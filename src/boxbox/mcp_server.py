"""MCP server: give any MCP client (Claude Code, Claude Desktop, ...) live access to the race.

Runs over stdio and reads from a running BoxBox dashboard's API, so the agent sees
exactly the same live views as the web app. Register it with Claude Code:

    claude mcp add boxbox -- uv run --directory /path/to/boxbox --extra mcp boxbox mcp
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request

TOPICS = ("car_telemetry", "race_standings", "car_state", "pit_decisions", "race_events")


class BoxBoxClient:
    def __init__(self, base_url: str) -> None:
        self.base = base_url.rstrip("/")

    def _request(self, path: str, body: dict | None = None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            self.base + path, data=data, headers={"Content-Type": "application/json"} if data else {}
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as exc:
            return {"error": f"HTTP {exc.code}: {exc.read().decode(errors='replace')[:300]}"}
        except urllib.error.URLError as exc:
            return {"error": f"BoxBox isn't reachable at {self.base} ({exc.reason}). Start it with `boxbox`."}

    def status(self):
        return self._request("/api/status")

    def query(self, topic: str, limit: int = 20, lap: int | None = None):
        params = {"topic": topic, "limit": limit}
        if lap is not None:
            params["lap"] = lap
        return self._request("/api/query?" + urllib.parse.urlencode(params))

    def ask(self, question: str):
        return self._request("/api/engineer", {"question": question})


def _server_class():
    """MCP SDK 2.x calls it MCPServer; 1.x called it FastMCP. Same decorator API for our use."""
    try:
        from mcp.server.mcpserver import MCPServer

        return MCPServer
    except ImportError:
        from mcp.server.fastmcp import FastMCP

        return FastMCP


def build_server(base_url: str):
    server_cls = _server_class()
    client = BoxBoxClient(base_url)
    mcp = server_cls(
        "boxbox",
        instructions=(
            "Live data from a BoxBox race: a simulated 60-lap race where an AI strategist calls pit stops for "
            "car #88 (Elio Varga, Kestrel Racing). Use race_status first, then the topic tools for detail."
        ),
    )

    def dump(obj) -> str:
        return json.dumps(obj, indent=1, default=str)

    @mcp.tool()
    def race_status() -> str:
        """Current race state: lap, flag, autopilot, active incidents, strategist brain, pipeline counts."""
        s = client.status()
        if "error" in s:
            return s["error"]
        return dump({"race": s["race"], "agent": s["agent"], "pipeline": s["pipeline"]["topics"]})

    @mcp.tool()
    def standings() -> str:
        """The current running order: position, driver, team, gap to leader, tyre compound and age, pit stops."""
        rows = client.query("race_standings", limit=22)
        if "error" in rows:
            return rows["error"]
        latest: dict[int, dict] = {}
        for r in rows["rows"]:
            latest.setdefault(r["car_number"], r)
        order = sorted(latest.values(), key=lambda r: r["position"])
        keep = (
            "position",
            "car_number",
            "driver",
            "team",
            "gap_to_leader_sec",
            "tire_compound",
            "tire_age_laps",
            "pit_stops",
            "lap",
        )
        return dump([{k: r[k] for k in keep} for r in order])

    @mcp.tool()
    def car_state(lap: int | None = None, limit: int = 5) -> str:
        """Car #88's per-lap state: averaged sensors, standings, anomaly flags and the detector's bounds.

        Give ``lap`` for one lap, or get the latest ``limit`` laps.
        """
        rows = client.query("car_state", limit=limit, lap=lap)
        return rows.get("error") or dump(rows["rows"])

    @mcp.tool()
    def pit_decisions(lap: int | None = None, limit: int = 5) -> str:
        """The strategist's calls (STAY OUT / PIT SOON / PIT NOW) with recommended compound and reasoning."""
        rows = client.query("pit_decisions", limit=limit, lap=lap)
        if "error" in rows:
            return rows["error"]
        return dump([{k: v for k, v in r.items() if k != "raw_response"} for r in rows["rows"]])

    @mcp.tool()
    def telemetry(limit: int = 10) -> str:
        """The latest raw sensor readings from car #88 (10 per lap): tyres, engine, brakes, fuel, battery, speed."""
        rows = client.query("car_telemetry", limit=limit)
        return rows.get("error") or dump(rows["rows"])

    @mcp.tool()
    def race_events(limit: int = 20) -> str:
        """Race events, newest first: pit stops, incidents, flags, box calls, the finish."""
        rows = client.query("race_events", limit=limit)
        if "error" in rows:
            return rows["error"]
        return dump([{"lap": r.get("lap"), "kind": r.get("kind"), "message": r.get("message")} for r in rows["rows"]])

    @mcp.tool()
    def ask_race_engineer(question: str) -> str:
        """Ask BoxBox's race engineer a question about the race; it answers from the full race history."""
        r = client.ask(question)
        return r.get("error") or r.get("answer", "")

    return mcp


def serve(base_url: str = "http://127.0.0.1:8088") -> None:
    try:
        server = build_server(base_url)
    except ImportError:
        raise SystemExit(
            "The MCP server needs the mcp package: uv sync --extra mcp (or pip install 'boxbox[mcp]')."
        ) from None
    server.run()
