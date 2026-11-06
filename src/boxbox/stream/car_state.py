"""The ``car_state`` operator: window, join, detect.

Consumes ``car_telemetry`` and ``race_standings`` and emits one ``car_state`` row per
20-second event-time window (one lap of sim time):

1. **Tumbling window** on ``event_time``. A window closes when it has all of a lap's
   readings or when a reading from a later window arrives (the watermark passes it).
2. **Temporal join**: each reading is joined with the hero car's standings row as of
   the reading's event time (the latest row whose ``event_time`` is not after it).
3. **Aggregate**: averages of every sensor; the latest standings fields.
4. **Detect**: each watched signal goes through a stint-aware :class:`TrendDetector`.
"""

from __future__ import annotations

import bisect
import logging
import threading

from boxbox.bus.base import CAR_STATE, CAR_TELEMETRY, RACE_EVENTS, RACE_STANDINGS, Bus, Record
from boxbox.sim.engine import SIM_LAP_MS
from boxbox.sim.grid import HERO_CAR
from boxbox.stream.detector import SIGNALS, TrendDetector

logger = logging.getLogger("boxbox.car_state")

AVERAGED = (
    "tire_temp_fl_c",
    "tire_temp_fr_c",
    "tire_temp_rl_c",
    "tire_temp_rr_c",
    "tire_pressure_fl_psi",
    "tire_pressure_fr_psi",
    "tire_pressure_rl_psi",
    "tire_pressure_rr_psi",
    "engine_temp_c",
    "brake_temp_fl_c",
    "brake_temp_fr_c",
    "battery_charge_pct",
    "fuel_remaining_kg",
)
JOINED = ("position", "gap_to_ahead_sec", "gap_to_leader_sec", "pit_stops", "tire_compound", "tire_age_laps")


class CarStateOperator:
    def __init__(self, bus: Bus, *, readings_per_window: int = 10, car_number: int = HERO_CAR) -> None:
        self.bus = bus
        self.car_number = car_number
        self.readings_per_window = readings_per_window
        self._lock = threading.Lock()
        self._reset()
        self.windows_emitted = 0
        bus.subscribe([CAR_TELEMETRY, RACE_STANDINGS, RACE_EVENTS], self.on_record, name="car_state")

    def _reset(self) -> None:
        self._versions: list[tuple[int, dict]] = []  # (event_time, standings row), sorted
        self._window: int | None = None
        self._rows: list[dict] = []
        self._detectors = {
            field: TrendDetector(side=side, min_sigma=floor)
            for field, (_flag, side, floor, _per_stint) in SIGNALS.items()
        }
        self._safety_car = False
        self._sc_window = False
        # Readings that arrived before their lap's standings row (possible on a real
        # broker, where the two topics aren't ordered relative to each other).
        self._pending: list[dict] = []

    def on_record(self, record: Record) -> None:
        with self._lock:
            if record.topic == RACE_EVENTS:
                kind = record.value.get("kind")
                if kind in ("race_start", "abandoned"):
                    self._reset()
                elif kind == "finish":
                    self._close()
                elif kind == "flag":
                    self._safety_car = record.value.get("data", {}).get("flag") == "SC"
                    self._sc_window = self._sc_window or self._safety_car
                return
            value = record.value
            if value.get("car_number") != self.car_number:
                return
            if record.topic == RACE_STANDINGS:
                t = int(value["event_time"])
                i = bisect.bisect_right([v[0] for v in self._versions], t)
                self._versions.insert(i, (t, value))
                del self._versions[:-200]
                pending, self._pending = self._pending, []
                for reading in pending:
                    self._on_reading(reading)
                return
            self._on_reading(value)

    def _as_of(self, t: int) -> dict | None:
        i = bisect.bisect_right([v[0] for v in self._versions], t)
        return self._versions[i - 1][1] if i else None

    def _on_reading(self, reading: dict) -> None:
        latest_lap = self._versions[-1][1]["lap"] if self._versions else 0
        if latest_lap < reading["lap"]:
            self._pending.append(reading)  # wait for this lap's standings row
            del self._pending[:-50]
            return
        window = int(reading["event_time"]) // SIM_LAP_MS
        if self._window is not None and window > self._window:
            self._close()
        if self._window is None:
            self._window = window
            self._sc_window = self._safety_car
        standing = self._as_of(int(reading["event_time"]))
        if standing is None:  # inner join: no standings version yet
            return
        self._rows.append({**reading, **{k: standing[k] for k in JOINED}})
        if len(self._rows) >= self.readings_per_window:
            self._close()

    def _close(self) -> None:
        rows, window, sc_window = self._rows, self._window, self._sc_window
        self._rows, self._window, self._sc_window = [], None, self._safety_car
        if not rows or window is None:
            return
        last = rows[-1]
        state = {
            "car_number": self.car_number,
            "lap": max(r["lap"] for r in rows),
            "window_start": window * SIM_LAP_MS,
            "window_end": (window + 1) * SIM_LAP_MS,
            **{f: round(sum(r[f] for r in rows) / len(rows), 2) for f in AVERAGED},
            **{k: last[k] for k in JOINED},
            "readings": len(rows),
        }
        stint = (last["pit_stops"], last["tire_compound"])
        bounds = {}
        training = 0
        for field, (flag, _side, _floor, per_stint) in SIGNALS.items():
            # Safety-car laps run slow and cool: score them, but don't learn "normal" from them.
            verdict = self._detectors[field].observe(state[field], stint if per_stint else None, learn=not sc_window)
            state[flag] = verdict.is_anomaly
            bounds[field] = verdict.bounds()
            training = max(training, verdict.training_windows)
        state["bounds"] = bounds
        state["training_windows"] = training
        state["safety_car"] = sc_window
        self.windows_emitted += 1
        self.bus.publish(CAR_STATE, state, key=str(self.car_number))
