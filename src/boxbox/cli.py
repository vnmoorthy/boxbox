"""``boxbox``: run the AI pit wall.

boxbox                         # everything in one process, dashboard on :8088
boxbox --pace 2 --autostart    # 2 s per lap, start racing immediately
boxbox --strategist rules      # offline, no LLM
boxbox --broker localhost:9092 --role sim   # one stage per process over Kafka/Redpanda
boxbox record --out demo.json  # record a race for the web demo
boxbox doctor                  # what BoxBox can see on this machine
boxbox mcp                     # MCP server: let Claude Code query the live race
"""

from __future__ import annotations

import argparse
import logging
import shutil
import signal
import sys
import threading
import time
import webbrowser
from pathlib import Path

from boxbox import __version__
from boxbox.agents.llm import DEFAULT_MODEL, has_anthropic_credentials
from boxbox.pipeline import ROLES, PipelineConfig, build_pipeline
from boxbox.sim.engine import SPEEDS

logger = logging.getLogger("boxbox")

BANNER = r"""
  ___           ___
 | _ ) _____ __| _ ) _____ __
 | _ \/ _ \ \ /| _ \/ _ \ \ /    real-time AI pit wall  v{version}
 |___/\___/_\_\|___/\___/_\_\
"""


def _run_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--host", default="127.0.0.1", help="interface to serve on (default 127.0.0.1)")
    p.add_argument("--port", type=int, default=8088, help="dashboard port (default 8088)")
    p.add_argument("--no-browser", action="store_true", help="don't open the dashboard in a browser")
    p.add_argument("--pace", type=float, default=5.0, choices=SPEEDS, help="wall-clock seconds per lap (default 5)")
    p.add_argument("--laps", type=int, default=60, help="race length (default 60)")
    p.add_argument("--autostart", action="store_true", help="start the first race immediately")
    p.add_argument("--no-autopilot", action="store_true", help="the car ignores the strategist's PIT NOW")
    p.add_argument("--no-scripted-incident", action="store_true", help="no front-left overheat at lap 24")
    p.add_argument(
        "--strategist",
        default="auto",
        choices=("auto", "hybrid", "claude", "rules"),
        help="who makes the calls (default auto)",
    )
    p.add_argument(
        "--llm",
        default="auto",
        choices=("auto", "anthropic", "claude-cli", "none"),
        help="Claude backend (default auto)",
    )
    p.add_argument("--model", default=DEFAULT_MODEL, help=f"Claude model (default {DEFAULT_MODEL})")
    p.add_argument("--broker", default=None, help="Kafka bootstrap servers; default: in-memory bus")
    p.add_argument("--role", default="all", choices=("all", *ROLES), help="which stage(s) to run (default all)")
    p.add_argument("--seed", type=int, default=None, help="random seed for reproducible races")
    p.add_argument("--circuit", default="silverstone", help="circuit shown on the map")
    p.add_argument("-v", "--verbose", action="store_true")


def cmd_run(args) -> int:
    roles = ROLES if args.role == "all" else (args.role,)
    if args.role != "all" and not args.broker:
        print("Running a single role needs a shared broker: add --broker localhost:9092", file=sys.stderr)
        return 2
    cfg = PipelineConfig(
        broker=args.broker,
        roles=roles,
        seconds_per_lap=args.pace,
        total_laps=args.laps,
        autopilot=not args.no_autopilot,
        scripted_incident=not args.no_scripted_incident,
        strategist=args.strategist,
        llm=args.llm,
        model=args.model,
        seed=args.seed,
        autostart=args.autostart,
        circuit=args.circuit,
    )
    print(BANNER.format(version=__version__))
    pipe = build_pipeline(cfg)
    if pipe.strategist:
        s = pipe.strategist
        brain = "rules engine" if s.mode == "rules" else f"{s.mode}: Claude ({s.provider}, {s.model}) + rules engine"
        print(f"  strategist   {brain}")
    if pipe.engineer:
        print(f"  engineer     {pipe.engineer.provider}")
    print(f"  bus          {pipe.bus.description}")
    pipe.start()

    if "dashboard" not in roles:
        print(f"  role         {args.role} (Ctrl-C to stop)")
        stop = threading.Event()
        signal.signal(signal.SIGINT, lambda *_: stop.set())
        signal.signal(signal.SIGTERM, lambda *_: stop.set())
        while not stop.is_set():
            time.sleep(0.5)
        pipe.stop()
        return 0

    import uvicorn

    from boxbox.local_port import ensure_port_free
    from boxbox.server.app import create_app

    ensure_port_free(args.host, args.port)
    url = f"http://{'localhost' if args.host in ('127.0.0.1', '0.0.0.0') else args.host}:{args.port}"
    print(f"  dashboard    {url}\n")
    if not args.no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        uvicorn.run(create_app(pipe), host=args.host, port=args.port, log_level="warning")
    except KeyboardInterrupt:
        pass
    finally:
        pipe.stop()
    return 0


def cmd_record(args) -> int:
    from boxbox.record import record_race

    scenarios = {}
    for spec in args.scenario or []:
        lap, _, kind = spec.partition(":")
        scenarios[int(lap)] = kind
    t0 = time.monotonic()
    session = record_race(
        Path(args.out),
        laps=args.laps,
        strategist=args.strategist,
        llm=args.llm,
        model=args.model,
        seed=args.seed,
        pace_ms=int(args.pace * 1000),
        scenarios=scenarios,
    )
    decisions = [e["value"] for e in session["events"] if e["topic"] == "pit_decisions"]
    claude = sum(1 for d in decisions if d.get("agent") == "claude")
    print(
        f"Recorded {len(session['events'])} events, {len(decisions)} decisions ({claude} by Claude) "
        f"in {time.monotonic() - t0:.0f}s -> {args.out}"
    )
    return 0


def cmd_doctor(args) -> int:
    print(f"BoxBox {__version__}")
    print(f"  python        {sys.version.split()[0]}")
    print(
        f"  anthropic API {'credentials found' if has_anthropic_credentials() else 'no credentials (set ANTHROPIC_API_KEY)'}"
    )
    print(f"  claude CLI    {shutil.which('claude') or 'not installed'}")
    try:
        import kafka  # noqa: F401

        print("  kafka client  installed (broker mode available)")
    except ImportError:
        print("  kafka client  not installed (pip install 'boxbox[kafka]' for broker mode)")
    try:
        import mcp  # noqa: F401

        print("  mcp           installed (boxbox mcp available)")
    except ImportError:
        print("  mcp           not installed (pip install 'boxbox[mcp]')")
    return 0


def cmd_mcp(args) -> int:
    from boxbox.mcp_server import serve

    serve(args.url)
    return 0


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    parser = argparse.ArgumentParser(prog="boxbox", description="BoxBox: a real-time AI pit wall.")
    parser.add_argument("--version", action="version", version=f"boxbox {__version__}")
    sub = parser.add_subparsers(dest="cmd")
    _run_args(sub.add_parser("run", help="run the pit wall (default)"))
    rec = sub.add_parser("record", help="record a full race to a replay file")
    rec.add_argument("--out", default="src/boxbox/web/demo/session.json")
    rec.add_argument("--laps", type=int, default=60)
    rec.add_argument("--strategist", default="auto", choices=("auto", "hybrid", "claude", "rules"))
    rec.add_argument("--llm", default="auto", choices=("auto", "anthropic", "claude-cli", "none"))
    rec.add_argument("--model", default=DEFAULT_MODEL)
    rec.add_argument("--seed", type=int, default=7)
    rec.add_argument("--pace", type=float, default=5.0, help="replay seconds per lap (default 5)")
    rec.add_argument("--scenario", action="append", metavar="LAP:KIND", help="inject an incident, e.g. 40:safety_car")
    sub.add_parser("doctor", help="show what BoxBox can use on this machine")
    m = sub.add_parser("mcp", help="MCP server exposing the live race to coding agents")
    m.add_argument("--url", default="http://127.0.0.1:8088", help="the running BoxBox dashboard")

    # `boxbox` with no subcommand (or only run flags) means `boxbox run`.
    if not argv or argv[0].startswith("-") and argv[0] not in ("-h", "--help", "--version"):
        argv = ["run", *argv]
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if getattr(args, "verbose", False) else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)
    handler = {"run": cmd_run, "record": cmd_record, "doctor": cmd_doctor, "mcp": cmd_mcp}[args.cmd]
    return handler(args)


if __name__ == "__main__":
    sys.exit(main())
