"""The race simulator stage: runs races and obeys the pit wall.

Publishes ``race_standings`` (22 cars, once per lap), ``car_telemetry`` (hero car,
``readings_per_lap`` per lap) and ``race_events``. Consumes ``race_control``
(commands from the dashboard or CLI) and ``pit_decisions`` (the closed loop: with
autopilot on, a ``PIT NOW`` boxes the hero car at the start of the next lap).

Time: one lap is 20 s of *simulation* time whatever the playback pace, so window
operators downstream see the same event-time stream at 1x or 20x. ``seconds_per_lap``
only sets how fast that stream is played in wall-clock time. In ``lockstep`` mode the
engine also waits for each lap's decision before starting the next lap, which makes
headless runs deterministic regardless of how slow the strategist is.
"""

from __future__ import annotations

import logging
import queue
import random
import threading
import time
from dataclasses import dataclass

from boxbox.bus.base import CAR_TELEMETRY, PIT_DECISIONS, RACE_CONTROL, RACE_EVENTS, RACE_STANDINGS, Bus, Record
from boxbox.sim.grid import GRID, HERO_CAR
from boxbox.sim.model import COMPOUNDS, TIRE_MAX_LIFE, RaceModel
from boxbox.sim.scenarios import SCENARIOS, ActiveScenario, effects_for
from boxbox.sim.telemetry import generate_reading

logger = logging.getLogger("boxbox.sim")

SIM_LAP_MS = 20_000
SPEEDS = (20, 10, 5, 2, 1)
DEFAULT_SECONDS_PER_LAP = 5.0
INCIDENT_LAP = 24


class _Restart(Exception):
    pass


class _Stop(Exception):
    pass


@dataclass
class _Box:
    compound: str
    reason: str  # agent | engineer | tyre_life
    decision_lap: int | None = None


def default_compound(laps_remaining: int) -> str:
    if laps_remaining > 38:
        return "HARD"
    if laps_remaining >= 18:
        return "MEDIUM"
    return "SOFT"


class RaceEngine:
    def __init__(
        self,
        bus: Bus,
        *,
        seconds_per_lap: float = DEFAULT_SECONDS_PER_LAP,
        total_laps: int = 60,
        autopilot: bool = True,
        scripted_incident: bool = True,
        circuit: str = "silverstone",
        seed: int | None = None,
        readings_per_lap: int = 10,
        lockstep: bool = False,
        lockstep_timeout: float = 180.0,
        autostart: bool = False,
    ) -> None:
        self.bus = bus
        self.seconds_per_lap = float(seconds_per_lap)
        self.total_laps = total_laps
        self.autopilot = autopilot
        self.scripted_incident = scripted_incident
        self.circuit = circuit
        self.seed = seed
        self.readings_per_lap = readings_per_lap
        self.lockstep = lockstep
        self.lockstep_timeout = lockstep_timeout
        self.autostart = autostart
        self.incident_lap = INCIDENT_LAP if total_laps >= 30 else max(3, int(total_laps * 0.4))

        self.state = "idle"
        self.race_id = 0
        self.lap = 0
        self._cmds: queue.Queue = queue.Queue()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="race-engine", daemon=True)
        self._want_start = autostart
        self._want_restart = False
        self.races_finished = 0
        self._reset_race_state()
        bus.subscribe([RACE_CONTROL, PIT_DECISIONS], self._cmds.put, name="simulator")

    # ---- lifecycle ---------------------------------------------------------
    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._cmds.put(None)

    def join(self, timeout: float | None = None) -> None:
        self._thread.join(timeout)

    def _reset_race_state(self) -> None:
        self.model: RaceModel | None = None
        self.active: list[ActiveScenario] = []
        self.pending_box: _Box | None = None
        self.stint_start_lap = 1
        self.fraction = 0.0
        self.flag = "PRE"
        self.decisions: dict[int, dict] = {}
        self.final_laps: set[int] = set()  # laps whose final (not reflex) decision has landed
        self.pit_laps: list[int] = []
        self._scripted_fired = False
        self.sim_epoch = 0

    def _run(self) -> None:
        try:
            while not self._stop.is_set():
                if not self._want_start:
                    self._drain(0.2)
                    continue
                self._want_start = False
                try:
                    self._run_race()
                except _Restart:
                    self._publish_event("abandoned", "Race abandoned; restarting.")
                    self._want_start = True
                self._want_restart = False
        except _Stop:
            pass
        except Exception:
            logger.exception("race engine crashed")

    # ---- commands ----------------------------------------------------------
    def _drain(self, timeout: float) -> None:
        """Handle commands for up to ``timeout`` seconds (idle/finished states)."""
        try:
            record = self._cmds.get(timeout=timeout)
        except queue.Empty:
            return
        self._handle(record)

    def _sleep(self, seconds: float, until=None) -> None:
        """Sleep in wall time while handling commands; pause freezes the clock."""
        deadline = time.monotonic() + seconds
        while True:
            if self._stop.is_set():
                raise _Stop
            if self._want_restart:
                raise _Restart
            if until is not None and until():
                return
            now = time.monotonic()
            if self.state != "paused" and until is None and now >= deadline:
                return
            if until is not None and now >= deadline:
                return
            wait = 0.25 if self.state == "paused" else max(0.0, min(0.25, deadline - now))
            paused_at = now if self.state == "paused" else None
            try:
                record = self._cmds.get(timeout=wait if wait > 0 else 0.001)
            except queue.Empty:
                record = None
            if paused_at is not None:
                deadline += time.monotonic() - paused_at
            if record is not None:
                self._handle(record)

    def _handle(self, record: Record | None) -> None:
        if record is None:
            if self._stop.is_set():
                raise _Stop
            return
        if record.topic == PIT_DECISIONS:
            self._on_decision(record.value)
            return
        cmd = record.value
        name = cmd.get("command")
        try:
            getattr(self, f"_cmd_{name}")(cmd)
        except AttributeError:
            logger.warning("unknown command %r", name)
        except (ValueError, KeyError) as exc:
            logger.warning("rejected command %r: %s", name, exc)

    def _cmd_start(self, cmd: dict) -> None:
        if self.state in ("idle", "finished"):
            self._want_start = True

    def _cmd_restart(self, cmd: dict) -> None:
        if self.state in ("running", "paused"):
            self._want_restart = True
        else:
            self._want_start = True

    def _cmd_pause(self, cmd: dict) -> None:
        if self.state == "running":
            self.state = "paused"
            self._publish_event("paused", "Race paused.")

    def _cmd_resume(self, cmd: dict) -> None:
        if self.state == "paused":
            self.state = "running"
            self._publish_event("resumed", "Race resumed.")

    def _cmd_speed(self, cmd: dict) -> None:
        spl = float(cmd["seconds_per_lap"])
        if spl <= 0:
            raise ValueError("seconds_per_lap must be positive")
        self.seconds_per_lap = spl
        self._publish_settings()

    def _cmd_autopilot(self, cmd: dict) -> None:
        self.autopilot = bool(cmd["enabled"])
        self._publish_settings()

    def _cmd_scripted_incident(self, cmd: dict) -> None:
        self.scripted_incident = bool(cmd["enabled"])
        self._publish_settings()

    def _cmd_scenario(self, cmd: dict) -> None:
        kind = cmd["kind"]
        if kind not in SCENARIOS:
            raise ValueError(f"unknown scenario {kind}")
        if self.state not in ("running", "paused"):
            raise ValueError("no race running")
        self._activate(kind, "manual")

    def _cmd_box(self, cmd: dict) -> None:
        compound = cmd.get("compound") or self._default_compound()
        if compound not in COMPOUNDS:
            raise ValueError(f"unknown compound {compound}")
        if self.state not in ("running", "paused") or self.lap >= self.total_laps:
            raise ValueError("no race running")
        self.pending_box = _Box(compound, "engineer")
        self._publish_event(
            "box_call",
            f"Engineer: box, box. {compound.title()}s are ready.",
            car_number=HERO_CAR,
            compound=compound,
            by="engineer",
            decision_lap=None,
        )

    # ---- closed loop -------------------------------------------------------
    def _on_decision(self, d: dict) -> None:
        if d.get("car_number") != HERO_CAR or self.model is None:
            return
        lap = int(d.get("lap") or 0)
        self.decisions[lap] = d
        if d.get("phase", "final") == "final":
            self.final_laps.add(lap)
        if not (self.autopilot and d.get("suggestion") == "PIT NOW"):
            return
        if self.pending_box is not None or lap < self.stint_start_lap or self.lap >= self.total_laps:
            return
        if self.state not in ("running", "paused"):
            return
        compound = d.get("recommended_tire_compound")
        if compound not in COMPOUNDS:
            compound = self._default_compound()
        self.pending_box = _Box(compound, "agent", decision_lap=lap)
        self._publish_event(
            "box_call",
            f"Strategist: box, box. {compound.title()}s.",
            car_number=HERO_CAR,
            compound=compound,
            by="agent",
            decision_lap=lap,
        )

    def _default_compound(self) -> str:
        return default_compound(self.total_laps - self.lap)

    # ---- race --------------------------------------------------------------
    def _activate(self, kind: str, source: str) -> None:
        if any(s.kind == kind for s in self.active):
            return
        sc = ActiveScenario(kind=kind, since_lap=max(1, self.lap), since_fraction=self.fraction, source=source)
        self.active.append(sc)
        self._publish_event("scenario", f"{sc.spec.label} ({source}).", kind=kind, label=sc.spec.label, source=source)
        if kind == "safety_car":
            self._set_flag("SC")

    def _end_scenario(self, sc: ActiveScenario) -> None:
        self.active.remove(sc)
        self._publish_event("scenario_end", f"{sc.spec.label} over.", kind=sc.kind, label=sc.spec.label)
        if sc.kind == "safety_car" and not any(s.kind == "safety_car" for s in self.active):
            self._set_flag("GREEN")

    def _set_flag(self, flag: str) -> None:
        if flag != self.flag:
            self.flag = flag
            names = {"GREEN": "Green flag", "SC": "Safety car deployed", "CHEQUERED": "Chequered flag"}
            self._publish_event("flag", names.get(flag, flag) + ".", flag=flag)

    def _run_race(self) -> None:
        self._reset_race_state()
        self.race_id += 1
        seed = None if self.seed is None else self.seed + self.race_id
        rng = random.Random(seed)
        self.model = RaceModel(GRID, rng)
        self.lap = 0
        self.state = "running"
        self.sim_epoch = (int(time.time() * 1000) // SIM_LAP_MS) * SIM_LAP_MS
        self._publish_event(
            "race_start",
            f"Race {self.race_id} started: {self.total_laps} laps.",
            race_id=self.race_id,
            total_laps=self.total_laps,
            seconds_per_lap=self.seconds_per_lap,
            circuit=self.circuit,
            our_car=HERO_CAR,
            grid=[
                {
                    k: car[k]
                    for k in (
                        "car_number",
                        "driver",
                        "driver_code",
                        "team",
                        "team_color",
                        "start_position",
                        "start_tire",
                    )
                }
                for car in GRID
            ],
            scripted_incidents=[{"lap": self.incident_lap, "kind": "fl_overheat"}] if self.scripted_incident else [],
        )
        self._publish_settings()
        self._set_flag("GREEN")

        n = self.readings_per_lap
        for lap in range(1, self.total_laps + 1):
            self.lap = lap
            self.fraction = 0.0
            self._lap_start(lap, rng)
            window_start = self.sim_epoch + (lap - 1) * SIM_LAP_MS
            hero = self.model.car(HERO_CAR)
            for i in range(n):
                self.fraction = (i + 0.5) / n
                eff = effects_for(self.active, lap, self.fraction)
                reading = generate_reading(
                    rng,
                    lap=lap,
                    tire_age=hero.tire_age_laps,
                    compound=hero.tire_compound,
                    effects=eff,
                    lap_fraction=self.fraction,
                )
                reading["car_number"] = HERO_CAR
                reading["event_time"] = window_start + int((i + 0.5) * SIM_LAP_MS / n)
                self.bus.publish(CAR_TELEMETRY, reading, key=str(HERO_CAR))
                self._sleep(self.seconds_per_lap / n)
            if self.lockstep:
                self._sleep(self.lockstep_timeout, until=lambda lap=lap: lap in self.final_laps)
        # Give the final lap's strategy call a moment to land so the race summary includes it.
        self._sleep(min(15.0, max(2.0, self.seconds_per_lap * 2)), until=lambda: self.total_laps in self.final_laps)
        self._finish()

    def _lap_start(self, lap: int, rng: random.Random) -> None:
        model = self.model
        hero = model.car(HERO_CAR)
        if self.scripted_incident and lap == self.incident_lap and not self._scripted_fired:
            self._scripted_fired = True
            self._activate("fl_overheat", "scripted")
        for sc in list(self.active):
            if sc.expired(lap):
                self._end_scenario(sc)
        if (
            self.pending_box is None
            and hero.tire_age_laps + 1 > TIRE_MAX_LIFE[hero.tire_compound]
            and lap < self.total_laps
        ):
            compound = default_compound(self.total_laps - lap)
            self.pending_box = _Box(compound, "tyre_life")
            self._publish_event(
                "box_call",
                f"Driver: the tyres are finished, boxing for {compound.title()}s.",
                car_number=HERO_CAR,
                compound=compound,
                by="tyre_life",
                decision_lap=None,
            )
        boxes = {HERO_CAR: self.pending_box.compound} if self.pending_box else {}
        eff = effects_for(self.active, lap, 0.5)
        stops = model.advance_lap(boxes=boxes, penalties={HERO_CAR: eff.lap_penalty}, safety_car=eff.safety_car)
        for stop in stops:
            car = model.car(stop["car_number"])
            is_hero = car.car_number == HERO_CAR
            reason = self.pending_box.reason if is_hero and self.pending_box else stop["reason"]
            if is_hero:
                self.pit_laps.append(lap)
                self.pending_box = None
                self.stint_start_lap = lap
                for sc in [s for s in self.active if s.spec.ends_on_pit]:
                    self._end_scenario(sc)
            self._publish_event(
                "pit_stop",
                f"{car.driver} pits: {stop['from_compound'].title()} to {stop['to_compound'].title()}.",
                car_number=car.car_number,
                driver=car.driver,
                driver_code=car.driver_code,
                from_compound=stop["from_compound"],
                to_compound=stop["to_compound"],
                reason=reason,
                stop_time_sec=stop["stop_time_sec"],
            )
        window_start = self.sim_epoch + (lap - 1) * SIM_LAP_MS
        for row in model.standings():
            row["event_time"] = window_start
            self.bus.publish(RACE_STANDINGS, row, key=str(row["car_number"]))

    def _finish(self) -> None:
        model = self.model
        self._set_flag("CHEQUERED")
        hero = model.car(HERO_CAR)
        counts = {"STAY OUT": 0, "PIT SOON": 0, "PIT NOW": 0}
        latencies = []
        anomaly_laps = []
        for lap, d in sorted(self.decisions.items()):
            if d.get("suggestion") in counts:
                counts[d["suggestion"]] += 1
            if d.get("latency_ms") is not None:
                latencies.append(d["latency_ms"])
            if d.get("anomaly_tire_temp_fl") or d.get("anomaly_tire_pressure_fl") or d.get("anomaly_engine_temp"):
                anomaly_laps.append(lap)
        results = [
            {
                "position": c.position,
                "car_number": c.car_number,
                "driver": c.driver,
                "driver_code": c.driver_code,
                "team": c.team,
                "team_color": c.team_color,
                "gap_to_leader_sec": c.gap_to_leader_sec,
                "pit_stops": c.pit_stops,
            }
            for c in model.cars
        ]
        self.state = "finished"
        self.races_finished += 1
        self._publish_event(
            "finish",
            f"Chequered flag. {hero.driver} finishes P{hero.position}.",
            results=results,
            summary={
                "our_position": hero.position,
                "start_position": hero.start_position,
                "positions_gained": hero.start_position - hero.position,
                "pit_laps": self.pit_laps,
                "decisions": counts,
                "anomaly_laps": anomaly_laps,
                "avg_decision_latency_ms": round(sum(latencies) / len(latencies)) if latencies else None,
            },
        )

    # ---- publishing --------------------------------------------------------
    def _publish_event(self, event_kind: str, message: str, /, **data) -> None:
        self.bus.publish(
            RACE_EVENTS,
            {"kind": event_kind, "lap": self.lap, "race_id": self.race_id, "message": message, "data": data},
        )

    def _publish_settings(self) -> None:
        self._publish_event(
            "settings",
            "Settings updated.",
            seconds_per_lap=self.seconds_per_lap,
            autopilot=self.autopilot,
            scripted_incident=self.scripted_incident,
            state=self.state,
        )
