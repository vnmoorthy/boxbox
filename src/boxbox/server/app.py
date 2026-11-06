"""The BoxBox web server: dashboard, control API, race engineer, live event stream."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from pathlib import Path

from fastapi import Body, FastAPI, Query, WebSocket, WebSocketDisconnect
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from boxbox import __version__
from boxbox.bus.base import RACE_CONTROL
from boxbox.pipeline import Pipeline
from boxbox.sim.engine import SPEEDS
from boxbox.sim.model import COMPOUNDS
from boxbox.sim.scenarios import SCENARIOS

logger = logging.getLogger("boxbox.server")

WEB_DIR = Path(__file__).resolve().parent.parent / "web"
EVENT_POLL_SEC = 0.1
STATUS_EVERY_SEC = 1.0


class ControlError(ValueError):
    pass


def validate_command(cmd: dict, race_state: str) -> dict:
    name = cmd.get("command")
    live = race_state in ("running", "paused")
    if name == "start":
        if live:
            raise ControlError("A race is already running. Use restart to begin a new one.")
        return {"command": "start"}
    if name == "restart":
        return {"command": "restart"}
    if name == "pause":
        if race_state != "running":
            raise ControlError("The race isn't running.")
        return {"command": "pause"}
    if name == "resume":
        if race_state != "paused":
            raise ControlError("The race isn't paused.")
        return {"command": "resume"}
    if name == "speed":
        try:
            spl = float(cmd.get("seconds_per_lap"))
        except (TypeError, ValueError):
            raise ControlError("seconds_per_lap must be a number.") from None
        if spl not in SPEEDS:
            raise ControlError(f"seconds_per_lap must be one of {list(SPEEDS)}.")
        return {"command": "speed", "seconds_per_lap": spl}
    if name == "scenario":
        kind = cmd.get("kind")
        if kind not in SCENARIOS:
            raise ControlError(f"Unknown scenario {kind!r}.")
        if not live:
            raise ControlError("Start a race before injecting an incident.")
        return {"command": "scenario", "kind": kind}
    if name == "box":
        compound = cmd.get("compound")
        if compound is not None and compound not in COMPOUNDS:
            raise ControlError(f"compound must be one of {list(COMPOUNDS)}.")
        if not live:
            raise ControlError("Start a race before calling a stop.")
        return {"command": "box", "compound": compound}
    if name in ("autopilot", "scripted_incident"):
        if not isinstance(cmd.get("enabled"), bool):
            raise ControlError("enabled must be true or false.")
        return {"command": name, "enabled": cmd["enabled"]}
    raise ControlError(f"Unknown command {name!r}.")


def create_app(pipe: Pipeline) -> FastAPI:
    state = pipe.state
    app = FastAPI(title="BoxBox", version=__version__, docs_url="/api/docs", openapi_url="/api/openapi.json")

    @app.get("/healthz")
    async def healthz() -> dict:
        s = state.status()
        return {"status": "ok", "race": s["race"]["state"], "lap": s["race"]["lap"]}

    @app.get("/api/status")
    async def status() -> dict:
        return state.status()

    @app.post("/api/control")
    async def control(cmd: dict = Body(...)):
        try:
            command = validate_command(cmd, state.status()["race"]["state"])
        except ControlError as exc:
            return JSONResponse({"ok": False, "error": str(exc)}, status_code=400)
        pipe.bus.publish(RACE_CONTROL, command)
        await asyncio.sleep(0.15)  # let the simulator apply it before we report status
        return {"ok": True, "status": state.status()}

    @app.post("/api/engineer")
    async def engineer(body: dict = Body(...)):
        question = body.get("question")
        history = body.get("history") or []
        if not isinstance(question, str) or not question.strip():
            return JSONResponse({"error": "question is required"}, status_code=400)
        if not isinstance(history, list):
            return JSONResponse({"error": "history must be a list"}, status_code=400)
        return await run_in_threadpool(pipe.engineer.ask, question, history)

    @app.get("/api/session")
    async def session():
        data = state.session()
        name = f"boxbox-race-{data['meta']['race_id'] or 0}.json"
        return JSONResponse(data, headers={"Content-Disposition": f'inline; filename="{name}"'})

    @app.get("/api/query")
    async def query(
        topic: str = Query(...),
        limit: int = Query(20, ge=1, le=500),
        lap: int | None = Query(None),
        car_number: int | None = Query(None),
    ):
        try:
            rows = state.query(topic, limit=limit, lap=lap, car_number=car_number)
        except ValueError as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)
        return {"topic": topic, "rows": rows}

    @app.websocket("/ws")
    async def ws(socket: WebSocket) -> None:
        await socket.accept()
        try:
            backlog = state.backlog()
            last = backlog[-1]["seq"] if backlog else 0
            await socket.send_text(
                json.dumps({"type": "hello", "status": state.status(), "backlog": backlog}, default=str)
            )
            since_status = 0.0
            while True:
                await asyncio.sleep(EVENT_POLL_SEC)
                events = state.events_since(last)
                if events:
                    last = events[-1]["seq"]
                    await socket.send_text(json.dumps({"type": "events", "events": events}, default=str))
                since_status += EVENT_POLL_SEC
                if since_status >= STATUS_EVERY_SEC or any(e["topic"] == "race_events" for e in events):
                    since_status = 0.0
                    await socket.send_text(json.dumps({"type": "status", "status": state.status()}, default=str))
        except (WebSocketDisconnect, RuntimeError, ConnectionError):
            pass
        finally:
            with contextlib.suppress(Exception):
                await socket.close()

    if WEB_DIR.is_dir():
        app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
    return app
