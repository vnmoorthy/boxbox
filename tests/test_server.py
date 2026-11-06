"""The web API against a live in-process pipeline (rules strategist, fast pace)."""

import time

import pytest
from fastapi.testclient import TestClient

from boxbox.pipeline import PipelineConfig, build_pipeline
from boxbox.server.app import create_app


@pytest.fixture
def client():
    pipe = build_pipeline(PipelineConfig(seconds_per_lap=1, total_laps=30, strategist="rules", llm="none", seed=5))
    pipe.start()
    with TestClient(create_app(pipe)) as c:
        c.pipe = pipe
        yield c
    pipe.stop()


def wait_for(client, predicate, timeout=10.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        s = client.get("/api/status").json()
        if predicate(s):
            return s
        time.sleep(0.05)
    raise AssertionError(f"condition not met; last status {s['race']}")


def test_status_starts_idle_with_capabilities(client):
    s = client.get("/api/status").json()
    assert s["app"] == "boxbox" and s["mode"] == "embedded"
    assert s["race"]["state"] == "idle" and s["race"]["flag"] == "PRE"
    assert {sc["kind"] for sc in s["capabilities"]["scenarios"]} == {"fl_overheat", "puncture", "engine", "safety_car"}
    assert s["capabilities"]["speeds"] == [20, 10, 5, 2, 1]
    assert s["agent"]["strategist"] == "rules"


def test_controls_validate_before_reaching_the_simulator(client):
    for body, msg in [
        ({"command": "scenario", "kind": "puncture"}, "Start a race"),
        ({"command": "pause"}, "isn't running"),
        ({"command": "speed", "seconds_per_lap": 3}, "one of"),
        ({"command": "box", "compound": "WET"}, "compound"),
        ({"command": "autopilot", "enabled": "yes"}, "true or false"),
        ({"command": "launch"}, "Unknown command"),
    ]:
        r = client.post("/api/control", json=body)
        assert r.status_code == 400 and msg in r.json()["error"], body


def test_full_control_flow(client):
    assert client.post("/api/control", json={"command": "start"}).json()["ok"]
    wait_for(client, lambda s: s["race"]["state"] == "running" and s["race"]["lap"] >= 1)
    assert client.post("/api/control", json={"command": "start"}).status_code == 400

    client.post("/api/control", json={"command": "speed", "seconds_per_lap": 2})
    wait_for(client, lambda s: s["race"]["seconds_per_lap"] == 2)

    client.post("/api/control", json={"command": "autopilot", "enabled": False})
    wait_for(client, lambda s: s["race"]["autopilot"] is False)

    client.post("/api/control", json={"command": "scenario", "kind": "safety_car"})
    s = wait_for(client, lambda s: s["race"]["flag"] == "SC")
    assert s["race"]["active_scenarios"][0]["kind"] == "safety_car"

    client.post("/api/control", json={"command": "pause"})
    s = wait_for(client, lambda s: s["race"]["state"] == "paused")
    lap = s["race"]["lap"]
    time.sleep(0.6)
    assert client.get("/api/status").json()["race"]["lap"] == lap
    client.post("/api/control", json={"command": "resume"})
    wait_for(client, lambda s: s["race"]["state"] == "running")

    client.post("/api/control", json={"command": "box", "compound": "HARD"})
    wait_for(
        client,
        lambda s: any(
            e["kind"] == "pit_stop" and e["data"]["car_number"] == 88
            for e in client.get("/api/query?topic=race_events&limit=100").json()["rows"]
        ),
        timeout=8,
    )

    old = client.get("/api/status").json()["race"]["race_id"]
    client.post("/api/control", json={"command": "restart"})
    wait_for(client, lambda s: s["race"]["race_id"] == old + 1 and s["race"]["state"] == "running")


def test_engineer_query_session_and_websocket(client):
    r = client.post("/api/engineer", json={"question": "How are the tyres?"}).json()
    assert r["provider"] == "analyst" and "No race" in r["answer"]
    assert client.post("/api/engineer", json={"question": ""}).status_code == 400

    client.post("/api/control", json={"command": "start"})
    wait_for(client, lambda s: s["race"]["lap"] >= 2)
    answer = client.post("/api/engineer", json={"question": "How are the tyres?"}).json()["answer"]
    assert "softs" in answer
    assert "P" in client.post("/api/engineer", json={"question": "what's the gap to the leader"}).json()["answer"]

    rows = client.get("/api/query?topic=pit_decisions&limit=5").json()["rows"]
    assert rows and rows[0]["car_number"] == 88
    assert client.get("/api/query?topic=nope").status_code == 400

    session = client.get("/api/session").json()
    assert session["format"] == "boxbox-session/1" and session["events"][0]["value"]["kind"] == "race_start"

    with client.websocket_connect("/ws") as ws:
        hello = ws.receive_json()
        assert hello["type"] == "hello" and hello["backlog"] and hello["status"]["race"]["state"] == "running"
        kinds = {ws.receive_json()["type"] for _ in range(6)}
        assert kinds & {"events", "status"}


def test_dashboard_is_served(client):
    r = client.get("/")
    assert r.status_code == 200 and "<html" in r.text.lower()
    assert client.get("/circuits/index.json").json()["default"] == "silverstone"
