"""The ``pit_strategy_agent`` operator: one decision per ``car_state`` window.

Modes:
- ``claude``: every lap goes to Claude.
- ``rules``: every lap goes to the rules engine (instant, offline).
- ``hybrid`` (default with an LLM): Claude on laps that matter (any anomaly, the
  safety car, the pit window, the first lap, a periodic check-in); the rules engine on
  routine laps. Each decision says which brain made it.

LLM calls run on a small worker pool so a slow answer never blocks the stream, and
they're scheduled by priority: incident laps (an anomaly or the safety car) jump the
queue, and a routine lap that is still waiting when a newer lap arrives is decided
by the rules engine instead, so a slow LLM can't build a backlog in front of the call
that matters. A failed call falls back to the rules engine for that lap.
``latency_ms`` is measured from the moment the window reached the strategist to the
moment the decision was published, on the monotonic clock.

Two speeds. On an incident lap with an LLM brain, the rules engine first publishes a
``phase: "reflex"`` decision within milliseconds, so the car can react while Claude
deliberates; Claude's ``phase: "final"`` decision for the same lap follows with its
reasoning. Every other decision is ``final``. Consumers keep the latest decision per
lap; the autopilot acts on the first ``PIT NOW`` it sees.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor

from boxbox.agents import rules
from boxbox.agents.llm import LLMError
from boxbox.agents.prompt import SYSTEM_PROMPT, format_car_state, parse_response
from boxbox.bus.base import CAR_STATE, PIT_DECISIONS, RACE_EVENTS, Bus, Record, now_ms

logger = logging.getLogger("boxbox.strategist")

MODES = ("auto", "claude", "rules", "hybrid")
CARRIED = (
    "car_number",
    "lap",
    "position",
    "tire_age_laps",
    "anomaly_tire_temp_fl",
    "anomaly_tire_pressure_fl",
    "anomaly_engine_temp",
)


class StrategistOperator:
    def __init__(self, bus: Bus, *, llm=None, mode: str = "auto", total_laps: int = 60, max_workers: int = 3) -> None:
        if mode not in MODES:
            raise ValueError(f"mode must be one of {MODES}")
        self.bus = bus
        self.llm = llm
        if mode == "auto":
            mode = "hybrid" if llm else "rules"
        if mode in ("claude", "hybrid") and llm is None:
            logger.warning("strategist mode %s needs an LLM; using rules", mode)
            mode = "rules"
        self.mode = mode
        self.total_laps = total_laps
        self._pool = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="strategist")
        self.max_workers = max_workers
        self._queue: deque[tuple[dict, int, int, bool]] = (
            deque()
        )  # (car_state, received (monotonic), generation, critical)
        self._latest_lap = 0
        self._lock = threading.Lock()
        self._generation = 0
        self._last: dict | None = None
        self.inflight = 0
        self.latencies: deque[int] = deque(maxlen=30)
        self.llm_failures = 0
        bus.subscribe([CAR_STATE, RACE_EVENTS], self.on_record, name="pit_strategy_agent")

    @property
    def model(self) -> str | None:
        return getattr(self.llm, "model", None) if self.mode != "rules" else None

    @property
    def provider(self) -> str:
        return self.llm.provider if self.llm and self.mode != "rules" else "rules"

    def avg_latency_ms(self) -> int | None:
        with self._lock:
            return round(sum(self.latencies) / len(self.latencies)) if self.latencies else None

    def on_record(self, record: Record) -> None:
        if record.topic == RACE_EVENTS:
            if record.value.get("kind") in ("race_start", "abandoned"):
                with self._lock:
                    self._generation += 1
                    self._last = None
                    self._queue.clear()
                    self._latest_lap = 0
                    self.total_laps = record.value.get("data", {}).get("total_laps", self.total_laps)
            return
        cs = record.value
        # Latency is timed on the monotonic clock from the moment the window reaches the
        # strategist, so it measures thinking time and never includes a laptop's sleep.
        received = time.monotonic()
        with self._lock:
            gen = self._generation
            self._latest_lap = max(self._latest_lap, int(cs["lap"]))
        if self._wants_llm(cs):
            critical = self._is_critical(cs)
            if critical:
                self._emit(
                    cs, rules.decide(cs, total_laps=self.total_laps), "rules", None, received, gen, phase="reflex"
                )
            with self._lock:
                if critical:
                    self._queue.appendleft((cs, received, gen, True))
                else:
                    self._queue.append((cs, received, gen, False))
            self._dispatch()
        else:
            self._emit(cs, rules.decide(cs, total_laps=self.total_laps), "rules", None, received, gen)
        self._dispatch()

    @staticmethod
    def _is_critical(cs: dict) -> bool:
        return bool(
            cs.get("anomaly_tire_temp_fl")
            or cs.get("anomaly_tire_pressure_fl")
            or cs.get("anomaly_engine_temp")
            or cs.get("safety_car")
        )

    def _dispatch(self) -> None:
        """Start queued LLM calls while workers are free; settle stale routine laps with rules."""
        stale = []
        with self._lock:
            # A routine lap that a newer lap has overtaken in the queue isn't worth waiting for.
            for item in list(self._queue):
                cs, _ts, _gen, critical = item
                if not critical and cs["lap"] < self._latest_lap:
                    self._queue.remove(item)
                    stale.append(item)
            starts = []
            while self._queue and self.inflight < self.max_workers:
                starts.append(self._queue.popleft())
                self.inflight += 1
        for cs, ts, gen, _critical in stale:
            self._emit(cs, rules.decide(cs, total_laps=self.total_laps), "rules", None, ts, gen)
        for cs, ts, gen, _critical in starts:
            self._pool.submit(self._decide_llm, cs, ts, gen)

    def _wants_llm(self, cs: dict) -> bool:
        if self.mode == "claude":
            return True
        if self.mode != "hybrid":
            return False
        if cs.get("anomaly_tire_temp_fl") or cs.get("anomaly_tire_pressure_fl") or cs.get("anomaly_engine_temp"):
            return True
        if cs.get("safety_car"):
            return True
        window = rules.PIT_SOON_AGE[cs["tire_compound"]]
        if cs["pit_stops"] == 0 and cs["tire_age_laps"] >= window - 1:
            return True
        return cs["lap"] == 1 or (cs["lap"] % 10 == 0 and cs["lap"] < self.total_laps)

    def _decide_llm(self, cs: dict, received: float, gen: int) -> None:
        try:
            text = self.llm.complete(
                SYSTEM_PROMPT, [{"role": "user", "content": format_car_state(cs, total_laps=self.total_laps)}]
            )
            agent, model = "claude", self.llm.model
        except LLMError as exc:
            self.llm_failures += 1
            logger.warning("lap %s: Claude unavailable (%s); rules engine decides", cs.get("lap"), exc)
            text, agent, model = rules.decide(cs, total_laps=self.total_laps), "rules", None
        except Exception:
            logger.exception("lap %s: strategist error; rules engine decides", cs.get("lap"))
            text, agent, model = rules.decide(cs, total_laps=self.total_laps), "rules", None
        finally:
            with self._lock:
                self.inflight -= 1
        self._emit(cs, text, agent, model, received, gen)
        self._dispatch()

    def _emit(
        self, cs: dict, text: str, agent: str, model: str | None, received: float, gen: int, *, phase: str = "final"
    ) -> None:
        with self._lock:
            if gen != self._generation:
                return  # the race this window belonged to is over
        decided = now_ms()
        decision = {
            **{k: cs.get(k) for k in CARRIED},
            "tire_compound_current": cs["tire_compound"],
            **parse_response(text),
            "raw_response": text,
            "agent": agent,
            "model": model,
            "phase": phase,
            "latency_ms": round((time.monotonic() - received) * 1000),
            "window_end": cs.get("window_end"),
            "decided_at": decided,
        }
        with self._lock:
            if phase == "final":
                self.latencies.append(decision["latency_ms"])
            self._last = decision
        self.bus.publish(PIT_DECISIONS, decision, key=str(cs["car_number"]))

    def close(self) -> None:
        self._pool.shutdown(wait=False, cancel_futures=True)
