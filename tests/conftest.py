from __future__ import annotations

import time
from dataclasses import dataclass

import pytest

from boxbox.bus.base import RACE_CONTROL
from boxbox.pipeline import PipelineConfig, build_pipeline


@dataclass
class Race:
    events: list[dict]

    def topic(self, name):
        return [e["value"] for e in self.events if e["topic"] == name]

    @property
    def decisions(self) -> dict[int, dict]:
        return {d["lap"]: d for d in self.topic("pit_decisions")}

    @property
    def car_states(self) -> dict[int, dict]:
        return {c["lap"]: c for c in self.topic("car_state")}

    def race_events(self, kind):
        return [e for e in self.topic("race_events") if e["kind"] == kind]

    @property
    def hero_stops(self):
        return [e for e in self.race_events("pit_stop") if e["data"]["car_number"] == 88]

    def calls(self) -> str:
        sym = {"STAY OUT": ".", "PIT SOON": "s", "PIT NOW": "N"}
        return "".join(sym[self.decisions[lap]["suggestion"]] for lap in sorted(self.decisions))

    def anomaly_laps(self, flag="any"):
        keys = ("anomaly_tire_temp_fl", "anomaly_tire_pressure_fl", "anomaly_engine_temp") if flag == "any" else (flag,)
        return sorted(lap for lap, c in self.car_states.items() if any(c.get(k) for k in keys))


def run_race(*, laps=40, commands=None, autopilot=True, scripted=True, seed=3, timeout=60.0) -> Race:
    """Run one headless race in lockstep with the rules strategist.

    ``commands`` maps a lap to a race_control command (or list of them), sent while
    that lap is running.
    """
    cfg = PipelineConfig(
        seconds_per_lap=0.04,
        total_laps=laps,
        strategist="rules",
        llm="none",
        seed=seed,
        lockstep=True,
        autostart=True,
        autopilot=autopilot,
        scripted_incident=scripted,
    )
    pipe = build_pipeline(cfg)
    pipe.start()
    sent = set()
    deadline = time.monotonic() + timeout
    try:
        while pipe.engine.races_finished < 1:
            assert time.monotonic() < deadline, f"race stalled at lap {pipe.engine.lap}"
            lap = pipe.engine.lap
            for at, cmds in (commands or {}).items():
                if lap >= at and at not in sent:
                    sent.add(at)
                    for cmd in cmds if isinstance(cmds, list) else [cmds]:
                        pipe.bus.publish(RACE_CONTROL, cmd)
            time.sleep(0.003)
        time.sleep(0.3)
        return Race(pipe.state.backlog())
    finally:
        pipe.stop()


@pytest.fixture
def race_runner():
    return run_race
