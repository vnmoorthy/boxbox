"""Record a full race headlessly into a replay file (the web demo's data).

The race runs in lockstep (each lap waits for its strategy call), so a slow LLM
doesn't change the race. Timestamps are then rewritten onto a clean replay timeline of
``pace_ms`` per lap, keeping publish order, so the web app can replay it smoothly.
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path

from boxbox.bus.base import CAR_STATE, CAR_TELEMETRY, PIT_DECISIONS, RACE_STANDINGS
from boxbox.pipeline import PipelineConfig, build_pipeline

logger = logging.getLogger("boxbox.record")


def retime(events: list[dict], *, pace_ms: int = 5000, start_ts: int = 1_800_000_000_000) -> list[dict]:
    """Map events onto a replay timeline of ``pace_ms`` per lap, never reordering them."""
    out = []
    last = start_ts
    cs_ts: dict[int, int] = {}
    for e in events:
        v = e["value"]
        topic = e["topic"]
        if topic == CAR_TELEMETRY:
            ts = start_ts + int(((v["lap"] - 1) + v.get("lap_fraction", 0.5)) * pace_ms)
        elif topic == RACE_STANDINGS:
            ts = start_ts + int((v["lap"] - 1) * pace_ms)
        elif topic == CAR_STATE:
            ts = start_ts + int(v["lap"] * pace_ms) + 40
            cs_ts[v["lap"]] = ts
        elif topic == PIT_DECISIONS:
            base = cs_ts.get(v["lap"], last)
            ts = base + min(int(v.get("latency_ms") or 0), int(pace_ms * 0.3)) + 60
        else:
            ts = last + 1
        ts = max(ts, last)
        last = ts
        out.append({**e, "ts": ts})
    return out


def record_race(
    out: Path,
    *,
    laps: int = 60,
    strategist: str = "auto",
    llm: str = "auto",
    model: str | None = None,
    seed: int | None = 7,
    pace_ms: int = 5000,
    scenarios: dict[int, str] | None = None,
    timeout_sec: float = 3600.0,
) -> dict:
    cfg = PipelineConfig(
        seconds_per_lap=0.05,
        total_laps=laps,
        strategist=strategist,
        llm=llm,
        seed=seed,
        lockstep=True,
        autostart=True,
    )
    if model:
        cfg.model = model
    pipe = build_pipeline(cfg)
    scenarios = scenarios or {}
    injected: set[int] = set()
    pipe.start()
    start = time.monotonic()
    try:
        while pipe.engine.races_finished < 1:
            if time.monotonic() - start > timeout_sec:
                raise TimeoutError("recording took too long")
            lap = pipe.engine.lap
            if lap in scenarios and lap not in injected:
                injected.add(lap)
                pipe.bus.publish("race_control", {"command": "scenario", "kind": scenarios[lap]})
            time.sleep(0.02)
        time.sleep(0.5)  # let the dashboard view drain the last events
        session = pipe.state.session()
    finally:
        pipe.stop()
    session["events"] = retime(session["events"], pace_ms=pace_ms)
    session["meta"]["seconds_per_lap"] = pace_ms / 1000
    session["meta"]["recorded_with"] = pipe.agent_info()
    session["meta"]["description"] = "A full 60-lap race recorded headlessly with the BoxBox pipeline."
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(session, separators=(",", ":")))
    return session
