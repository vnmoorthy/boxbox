"""The dashboard's view of the race: an event log plus materialized views.

``LiveState`` subscribes to every topic. Each record becomes a numbered event in the
current race's log (what WebSocket clients replay on connect and what ``/api/session``
exports) and updates the materialized views behind ``/api/status``, ``/api/query``,
the MCP tools and the race engineer. A ``race_start`` event starts a new log.
"""

from __future__ import annotations

import itertools
import threading
import time
from collections import deque

from boxbox import __version__
from boxbox.bus.base import CAR_STATE, CAR_TELEMETRY, PIT_DECISIONS, RACE_EVENTS, RACE_STANDINGS, Bus, Record
from boxbox.sim.engine import DEFAULT_SECONDS_PER_LAP, SPEEDS
from boxbox.sim.grid import GRID, HERO_CAR
from boxbox.sim.scenarios import SCENARIOS

OBSERVED = (CAR_TELEMETRY, RACE_STANDINGS, CAR_STATE, PIT_DECISIONS, RACE_EVENTS)
QUERYABLE = OBSERVED
RATE_WINDOW_SEC = 5.0


class LiveState:
    def __init__(self, bus: Bus, *, mode: str = "embedded", controllable: bool = True, agent_info=None) -> None:
        self.bus = bus
        self.mode = mode
        self.controllable = controllable
        self.agent_info = agent_info  # callable -> dict, when the strategist runs in this process
        self._lock = threading.RLock()
        self._seq = itertools.count(1)
        self._counts = dict.fromkeys(OBSERVED, 0)
        self._last_ts: dict[str, int | None] = dict.fromkeys(OBSERVED)
        self._recent: dict[str, deque] = {t: deque(maxlen=4000) for t in OBSERVED}
        self.circuit = "silverstone"
        self._new_race(None)
        self.settings = {"seconds_per_lap": DEFAULT_SECONDS_PER_LAP, "autopilot": True, "scripted_incident": True}
        bus.subscribe(OBSERVED, self.on_record, name="dashboard", from_beginning=True)

    def _new_race(self, start: dict | None) -> None:
        data = (start or {}).get("data", {})
        self.events: list[dict] = []
        self.race_id = data.get("race_id")
        self.total_laps = data.get("total_laps", 60)
        self.grid = data.get("grid") or [
            {
                k: c[k]
                for k in ("car_number", "driver", "driver_code", "team", "team_color", "start_position", "start_tire")
            }
            for c in GRID
        ]
        if data.get("circuit"):
            self.circuit = data["circuit"]
        self.state = "running" if start else "idle"
        self.flag = "GREEN" if start else "PRE"
        self.lap = 0
        self.telemetry: dict | None = None
        self.standings: dict[int, dict] = {}
        self.car_states: dict[int, dict] = {}
        self.decisions: dict[int, dict] = {}
        self.race_events: list[dict] = []
        self.active: dict[str, dict] = {}
        self.finish: dict | None = None
        self.started_wall = time.time() if start else None

    # ---- ingest ------------------------------------------------------------
    def on_record(self, record: Record) -> None:
        with self._lock:
            value = record.value
            if record.topic == RACE_EVENTS and value.get("kind") == "race_start":
                self._new_race(value)
            event = {"seq": next(self._seq), "topic": record.topic, "key": record.key, "ts": record.ts, "value": value}
            self.events.append(event)
            self._counts[record.topic] += 1
            self._last_ts[record.topic] = record.ts
            self._recent[record.topic].append(time.monotonic())
            getattr(self, f"_on_{record.topic}")(value)

    def _on_car_telemetry(self, v: dict) -> None:
        self.telemetry = v
        if self.state == "idle":
            self.state = "running"
        self.lap = max(self.lap, int(v.get("lap") or 0))

    def _on_race_standings(self, v: dict) -> None:
        self.standings[v["car_number"]] = v
        if v["car_number"] == HERO_CAR:
            self.lap = max(self.lap, int(v.get("lap") or 0))

    def _on_car_state(self, v: dict) -> None:
        self.car_states[int(v["lap"])] = v

    def _on_pit_decisions(self, v: dict) -> None:
        self.decisions[int(v["lap"])] = v

    def _on_race_events(self, v: dict) -> None:
        kind = v.get("kind")
        data = v.get("data", {})
        self.race_events.append(v)
        if kind == "settings":
            for k in ("seconds_per_lap", "autopilot", "scripted_incident"):
                if k in data:
                    self.settings[k] = data[k]
        elif kind == "paused":
            self.state = "paused"
        elif kind == "resumed":
            self.state = "running"
        elif kind == "finish":
            self.state = "finished"
            self.finish = data
        elif kind == "flag":
            self.flag = data.get("flag", self.flag)
        elif kind == "scenario":
            self.active[data["kind"]] = {
                "kind": data["kind"],
                "label": data.get("label"),
                "since_lap": v.get("lap"),
                "source": data.get("source"),
            }
        elif kind == "scenario_end":
            self.active.pop(data.get("kind"), None)

    # ---- reads -------------------------------------------------------------
    def events_since(self, seq: int) -> list[dict]:
        with self._lock:
            if not self.events or self.events[-1]["seq"] <= seq:
                return []
            # Binary search would do, but logs are a few thousand events.
            return [e for e in self.events if e["seq"] > seq]

    def backlog(self) -> list[dict]:
        with self._lock:
            return list(self.events)

    def _rate(self, topic: str) -> float:
        cutoff = time.monotonic() - RATE_WINDOW_SEC
        recent = self._recent[topic]
        return round(sum(1 for t in reversed(recent) if t >= cutoff) / RATE_WINDOW_SEC, 2)

    def status(self) -> dict:
        with self._lock:
            agent = self.agent_info() if self.agent_info else {}
            if not agent:
                last = self.decisions[max(self.decisions)] if self.decisions else {}
                agent = {
                    "strategist": last.get("agent", "unknown"),
                    "provider": last.get("agent", "unknown"),
                    "model": last.get("model"),
                }
            topics = {
                t: {"count": self._counts[t], "rate": self._rate(t), "last_ts": self._last_ts[t]} for t in OBSERVED
            }
            fresh = (
                self._last_ts[CAR_TELEMETRY] is not None
                and (time.time() * 1000 - self._last_ts[CAR_TELEMETRY]) < 15_000
            )
            sim_status = {
                "running": "ok" if fresh else "stalled",
                "paused": "paused",
                "finished": "done",
                "idle": "idle",
            }[self.state]
            return {
                "app": "boxbox",
                "version": __version__,
                "mode": self.mode,
                "race": {
                    "race_id": self.race_id,
                    "state": self.state,
                    "lap": self.lap,
                    "total_laps": self.total_laps,
                    "seconds_per_lap": self.settings["seconds_per_lap"],
                    "flag": self.flag,
                    "autopilot": self.settings["autopilot"],
                    "scripted_incident": self.settings["scripted_incident"],
                    "active_scenarios": list(self.active.values()),
                    "circuit": self.circuit,
                    "our_car": HERO_CAR,
                },
                "agent": agent,
                "pipeline": {
                    "broker": self.bus.description,
                    "topics": topics,
                    "stages": [
                        {"name": "simulator", "status": sim_status},
                        {"name": "car_state", "status": "ok" if self._counts[CAR_STATE] else "waiting"},
                        {"name": "pit_strategy_agent", "status": "ok" if self._counts[PIT_DECISIONS] else "waiting"},
                    ],
                },
                "capabilities": {
                    "control": self.controllable,
                    "chat": True,
                    "speeds": list(SPEEDS),
                    "scenarios": [s.public() for s in SCENARIOS.values()],
                },
            }

    def session(self) -> dict:
        with self._lock:
            return {
                "format": "boxbox-session/1",
                "meta": {
                    "app": "boxbox",
                    "version": __version__,
                    "race_id": self.race_id,
                    "circuit": self.circuit,
                    "total_laps": self.total_laps,
                    "seconds_per_lap": self.settings["seconds_per_lap"],
                    "exported_at": int(time.time() * 1000),
                    "events": len(self.events),
                },
                "events": list(self.events),
            }

    def query(
        self, topic: str, *, limit: int = 20, lap: int | None = None, car_number: int | None = None
    ) -> list[dict]:
        if topic not in QUERYABLE:
            raise ValueError(f"topic must be one of {', '.join(QUERYABLE)}")
        with self._lock:
            rows = [e["value"] for e in reversed(self.events) if e["topic"] == topic]
        if lap is not None:
            rows = [r for r in rows if r.get("lap") == lap]
        if car_number is not None:
            rows = [r for r in rows if r.get("car_number") == car_number]
        return rows[: max(1, min(limit, 500))]

    def snapshot(self) -> dict:
        """A consistent copy of the views (for the race engineer)."""
        with self._lock:
            return {
                "state": self.state,
                "lap": self.lap,
                "total_laps": self.total_laps,
                "flag": self.flag,
                "settings": dict(self.settings),
                "telemetry": dict(self.telemetry) if self.telemetry else None,
                "standings": sorted(self.standings.values(), key=lambda s: s.get("position") or 99),
                "car_states": dict(self.car_states),
                "decisions": dict(self.decisions),
                "race_events": list(self.race_events),
                "active": list(self.active.values()),
                "finish": self.finish,
                "grid": list(self.grid),
            }
