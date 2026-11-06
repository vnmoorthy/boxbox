"""The strategist with a slow LLM: reflex decisions, priority scheduling, stale-lap fallback."""

import threading
import time

from boxbox.agents.strategist import StrategistOperator
from boxbox.bus import MemoryBus
from boxbox.bus.base import CAR_STATE, PIT_DECISIONS, RACE_EVENTS
from boxbox.server.state import LiveState
from boxbox.sim.engine import RaceEngine
from boxbox.stream.car_state import CarStateOperator
from test_units import _cs


class SlowClaude:
    provider = "fake"
    model = "fake-claude"

    def __init__(self, delay: float) -> None:
        self.delay = delay
        self.calls: list[int] = []

    def complete(self, system, messages, *, max_tokens=4096):
        text = messages[-1]["content"]
        lap = int(text.split("lap ")[1].split(" ")[0])
        self.calls.append(lap)
        time.sleep(self.delay)
        if "anomaly: TRUE" in text:
            return "Suggestion: PIT NOW\nRecommended Compound: MEDIUM\nRecommended Stint Laps: 20\nReasoning: Claude says box."
        return "Suggestion: STAY OUT\nReasoning: Claude says stay out."


def test_incident_lap_gets_a_reflex_then_jumps_a_slow_queue():
    bus = MemoryBus()
    llm = SlowClaude(delay=0.4)
    seen: list[dict] = []
    final_24 = threading.Event()

    def collect(record):
        seen.append(record.value)
        if record.value["lap"] == 24 and record.value["phase"] == "final":
            final_24.set()

    bus.subscribe([PIT_DECISIONS], collect, name="test")
    StrategistOperator(bus, llm=llm, mode="hybrid", max_workers=1)
    bus.publish(RACE_EVENTS, {"kind": "race_start", "data": {"total_laps": 60}})
    for lap in range(19, 24):  # pit-window laps: Claude-worthy but routine
        bus.publish(CAR_STATE, _cs(lap=lap, tire_age_laps=lap))
    bus.publish(CAR_STATE, _cs(lap=24, tire_age_laps=24, tire_temp_fl_c=145.0, anomaly_tire_temp_fl=True))

    assert final_24.wait(5)
    lap24 = [d for d in seen if d["lap"] == 24]
    reflex, final = lap24[0], lap24[-1]
    assert reflex["phase"] == "reflex" and reflex["agent"] == "rules" and reflex["suggestion"] == "PIT NOW"
    assert reflex["latency_ms"] < 200
    assert final["phase"] == "final" and final["agent"] == "claude" and final["suggestion"] == "PIT NOW"
    # Lap 19 was already with Claude; lap 24 went next, ahead of the routine laps.
    assert llm.calls[:2] == [19, 24]
    by_lap = {d["lap"]: d for d in seen}
    assert {by_lap[lap]["agent"] for lap in (20, 21, 22, 23)} == {"rules"}
    bus.close()


def test_slow_claude_still_boxes_the_car_the_next_lap():
    """Real time, 0.3 s laps, Claude taking 1.2 s (4 laps): the reflex boxes the car on time."""
    bus = MemoryBus()
    state = LiveState(bus)
    CarStateOperator(bus)
    StrategistOperator(bus, llm=SlowClaude(delay=1.2), mode="hybrid", max_workers=2)
    engine = RaceEngine(bus, seconds_per_lap=0.3, total_laps=30, seed=4, autostart=True)
    engine.start()
    deadline = time.monotonic() + 40
    while engine.races_finished < 1:
        assert time.monotonic() < deadline
        time.sleep(0.05)
    time.sleep(0.3)
    stops = [
        e["value"]
        for e in state.backlog()
        if e["topic"] == "race_events" and e["value"]["kind"] == "pit_stop" and e["value"]["data"]["car_number"] == 88
    ]
    incident = engine.incident_lap
    assert stops[0]["lap"] == incident + 1
    finals = {d["lap"]: d for d in state.decisions.values()}
    assert finals[incident]["agent"] == "claude" and finals[incident]["phase"] == "final"
    engine.stop()
    bus.close()
