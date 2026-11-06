"""The race engineer: answers questions about the live race.

With an LLM, Claude gets the whole race so far as compact context (status, the hero
car's lap-by-lap history, the strategist's calls, every race event, the current top of
the order) and answers like an engineer on the radio. Without one, or if the call
fails, a built-in analyst answers the common questions straight from the data.
"""

from __future__ import annotations

import re
import time

from boxbox.agents.llm import LLMError
from boxbox.sim.grid import GRID, HERO_CAR
from boxbox.sim.model import TIRE_CLIFF_AGE

HERO = next(c for c in GRID if c["car_number"] == HERO_CAR)

SYSTEM = f"""You are the race engineer on the {HERO["team"]} pit wall, talking to the team about car #{HERO_CAR} ({HERO["driver"]}) during a live, simulated 60-lap race. Answer from the race data below, quoting real lap numbers, positions, gaps and temperatures. Be direct and conversational, like an engineer on the radio: usually 2-5 sentences, a short list only when it helps. If the data doesn't cover the question, say what you can see and what you can't. Never invent numbers.

How the pit wall works: telemetry is windowed per lap; a streaming detector forecasts each signal from the current stint and flags values outside a 99.99% band (front-left tyre temperature, front-left pressure, engine temperature). A strategist agent reads each lap and calls STAY OUT, PIT SOON or PIT NOW; with autopilot on, a PIT NOW boxes the car at the start of the next lap. The user can inject incidents (front-left overheating, slow puncture, engine overheating, safety car) or call a stop manually."""


def _r(v, d=1):
    return "-" if v is None else f"{v:.{d}f}"


def build_context(s: dict) -> str:
    lines = [f"RACE STATUS: {s['state']}, lap {s['lap']} of {s['total_laps']}, flag {s['flag']}."]
    st = s["settings"]
    lines.append(
        f"Autopilot (car obeys PIT NOW): {'on' if st.get('autopilot') else 'off'}. Pace: {st.get('seconds_per_lap')} s per lap."
    )
    if s["active"]:
        lines.append(
            "Active incidents: " + ", ".join(f"{a['label']} since lap {a['since_lap']}" for a in s["active"]) + "."
        )
    hero = next((c for c in s["standings"] if c["car_number"] == HERO_CAR), None)
    if hero:
        lines.append(
            f"HERO CAR NOW: P{hero['position']}, {hero['tire_compound']} tyres {hero['tire_age_laps']} laps old, "
            f"{hero['pit_stops']} stop(s), {_r(hero['gap_to_leader_sec'])}s to the leader, {_r(hero['gap_to_ahead_sec'])}s to the car ahead."
        )
    t = s["telemetry"]
    if t:
        lines.append(
            f"LATEST TELEMETRY: tyres FL {_r(t['tire_temp_fl_c'])}C FR {_r(t['tire_temp_fr_c'])}C RL {_r(t['tire_temp_rl_c'])}C RR {_r(t['tire_temp_rr_c'])}C; "
            f"FL pressure {_r(t['tire_pressure_fl_psi'], 2)} psi; engine {_r(t['engine_temp_c'])}C; fuel {_r(t['fuel_remaining_kg'])} kg; "
            f"battery {_r(t['battery_charge_pct'])}%; speed {_r(t['speed_kph'], 0)} km/h."
        )
    if s["standings"]:
        top = s["standings"][:10]
        lines.append(
            "TOP 10: "
            + "; ".join(
                f"P{c['position']} #{c['car_number']} {c['driver']} ({c['team']}) +{_r(c['gap_to_leader_sec'])}s {c['tire_compound']}"
                for c in top
            )
            + "."
        )
    lines.append(
        "HERO LAP HISTORY (lap: position, tyre, FL temp vs upper bound, FL psi, engine, flags, strategist call):"
    )
    for lap in sorted(set(s["car_states"]) | set(s["decisions"])):
        cs = s["car_states"].get(lap, {})
        d = s["decisions"].get(lap, {})
        b = (cs.get("bounds") or {}).get("tire_temp_fl_c")
        flags = [
            n
            for n, k in (
                ("FL-TEMP", "anomaly_tire_temp_fl"),
                ("FL-PRESSURE", "anomaly_tire_pressure_fl"),
                ("ENGINE", "anomaly_engine_temp"),
            )
            if cs.get(k)
        ]
        call = d.get("suggestion", "-")
        if d.get("recommended_tire_compound"):
            call += f" -> {d['recommended_tire_compound']}"
        lines.append(
            f"  L{lap}: P{cs.get('position', '-')}, {cs.get('tire_compound', '-')} age {cs.get('tire_age_laps', '-')}, "
            f"FL {_r(cs.get('tire_temp_fl_c'))}C (ub {_r(b['upper']) if b else 'training'}), {_r(cs.get('tire_pressure_fl_psi'), 2)} psi, "
            f"eng {_r(cs.get('engine_temp_c'))}C, {'+'.join(flags) or 'nominal'}{', SC' if cs.get('safety_car') else ''}; {call} "
            f"[{d.get('agent', '-')}]"
        )
    notable = [d for d in s["decisions"].values() if d.get("suggestion") != "STAY OUT"]
    for d in sorted(notable, key=lambda d: d["lap"])[-6:]:
        lines.append(f"STRATEGIST REASONING L{d['lap']} ({d['suggestion']}): {d.get('reasoning')}")
    lines.append("RACE EVENTS:")
    for e in s["race_events"]:
        if e.get("kind") in ("settings",):
            continue
        lines.append(f"  L{e.get('lap')}: {e.get('message')}")
    if s["finish"]:
        lines.append(f"FINAL RESULT SUMMARY: {s['finish'].get('summary')}")
    return "\n".join(lines)


class RaceEngineer:
    def __init__(self, state, llm=None) -> None:
        self.state = state
        self.llm = llm

    @property
    def provider(self) -> str:
        return self.llm.provider if self.llm else "analyst"

    def ask(self, question: str, history: list[dict] | None = None) -> dict:
        question = (question or "").strip()[:2000]
        if not question:
            raise ValueError("question is empty")
        snap = self.state.snapshot()
        start = time.monotonic()
        if self.llm:
            messages = [m for m in (history or [])[-10:] if m.get("role") in ("user", "assistant") and m.get("content")]
            while messages and messages[0]["role"] != "user":
                messages.pop(0)
            messages.append({"role": "user", "content": question})
            try:
                answer = self.llm.complete(SYSTEM + "\n\nRACE DATA\n" + build_context(snap), messages, max_tokens=8192)
                return {
                    "answer": answer,
                    "provider": self.llm.provider,
                    "model": self.llm.model,
                    "latency_ms": round((time.monotonic() - start) * 1000),
                }
            except LLMError as exc:
                fallback_note = f" (Claude unavailable: {exc}; answered by the built-in analyst.)"
        else:
            fallback_note = ""
        answer = analyze(question, snap) + fallback_note
        return {
            "answer": answer,
            "provider": "analyst",
            "model": None,
            "latency_ms": round((time.monotonic() - start) * 1000),
        }


# ---- built-in analyst ------------------------------------------------------
def analyze(question: str, s: dict) -> str:
    q = question.lower()
    hero = next((c for c in s["standings"] if c["car_number"] == HERO_CAR), None)
    if s["state"] == "idle" or hero is None:
        return "No race is running yet. Start a race and I'll talk you through the tyres, the gaps and every strategy call."

    m = re.search(r"\blap\s*(\d+)", q)
    if m:
        return _lap_answer(int(m.group(1)), s)
    if any(w in q for w in ("why", "reason")) and any(w in q for w in ("pit", "box", "stop")):
        return _why_pit(s, hero)
    if "what if" in q or "stay out" in q or "don't pit" in q or "dont pit" in q:
        return _what_if(s, hero)
    if any(w in q for w in ("summar", "so far", "recap", "overview", "how's the race", "how is the race")):
        return _summary(s, hero)
    if any(w in q for w in ("tyre", "tire", "rubber", "temp", "pressure", "grip")):
        return _tyres(s, hero)
    if "engine" in q:
        return _engine(s)
    if any(w in q for w in ("anomal", "detector", "flag")):
        return _anomalies(s)
    if any(w in q for w in ("fuel", "battery", "energy")):
        t = s["telemetry"] or {}
        return f"Fuel is {_r(t.get('fuel_remaining_kg'))} kg and the battery is at {_r(t.get('battery_charge_pct'))}%. Both are tracking normally for lap {s['lap']}."
    if any(w in q for w in ("gap", "leader", "position", "where", "ahead", "behind", "p1", "win")):
        return _gaps(s, hero)
    if any(w in q for w in ("plan", "strategy", "next", "call", "decision")):
        return _plan(s, hero)
    return _summary(s, hero) + " Ask me about the tyres, the gaps, why we pitted, or any lap by number."


def _latest_decision(s):
    return s["decisions"][max(s["decisions"])] if s["decisions"] else None


def _gaps(s, hero):
    order = s["standings"]
    i = hero["position"] - 1
    ahead = order[i - 1] if i > 0 else None
    behind = order[i + 1] if i + 1 < len(order) else None
    leader = order[0]
    parts = [f"We're P{hero['position']} on lap {s['lap']}"]
    if hero["position"] == 1:
        parts.append("leading the race")
    else:
        parts.append(
            f"{_r(hero['gap_to_leader_sec'])}s behind the leader, {leader['driver']} (#{leader['car_number']})"
        )
    text = ", ".join(parts) + "."
    if ahead:
        text += f" {ahead['driver']} is {_r(hero['gap_to_ahead_sec'])}s ahead on {ahead['tire_compound'].lower()}s."
    if behind:
        text += f" {behind['driver']} is {_r(behind['gap_to_ahead_sec'])}s behind."
    return text


def _tyres(s, hero):
    t = s["telemetry"] or {}
    cs = s["car_states"].get(max(s["car_states"])) if s["car_states"] else None
    text = (
        f"We're on {hero['tire_compound'].lower()}s, {hero['tire_age_laps']} laps old. Latest temps: FL {_r(t.get('tire_temp_fl_c'))}C, "
        f"FR {_r(t.get('tire_temp_fr_c'))}C, RL {_r(t.get('tire_temp_rl_c'))}C, RR {_r(t.get('tire_temp_rr_c'))}C; "
        f"front-left pressure {_r(t.get('tire_pressure_fl_psi'), 2)} psi."
    )
    if cs:
        b = (cs.get("bounds") or {}).get("tire_temp_fl_c")
        if cs.get("anomaly_tire_temp_fl") or cs.get("anomaly_tire_pressure_fl"):
            text += f" The detector flagged the front-left on lap {cs['lap']}: that's a real problem, not noise."
        elif b:
            text += f" The detector expects about {b['expected']:.1f}C on the front-left with an upper bound of {b['upper']:.1f}C, so we're inside the band."
        else:
            text += " The detector is still learning this stint."
    cliff = TIRE_CLIFF_AGE[hero["tire_compound"]]
    if hero["tire_age_laps"] >= cliff:
        text += f" We're past the {hero['tire_compound'].lower()} wear cliff (about {cliff} laps), so expect lap time to fall away."
    return text


def _engine(s):
    t = s["telemetry"] or {}
    flagged = [lap for lap, cs in s["car_states"].items() if cs.get("anomaly_engine_temp")]
    text = f"Engine is at {_r(t.get('engine_temp_c'))}C."
    if flagged:
        text += f" The detector flagged it on lap{'s' if len(flagged) > 1 else ''} {', '.join(map(str, sorted(flagged)))}. A stop can't fix that, so the play is lift-and-coast and short-shifting until it cools."
    else:
        text += " No engine anomalies this race; it's running in its normal band around 120C."
    return text


def _anomalies(s):
    hits = []
    for lap, cs in sorted(s["car_states"].items()):
        names = [
            n
            for n, k in (
                ("front-left temperature", "anomaly_tire_temp_fl"),
                ("front-left pressure", "anomaly_tire_pressure_fl"),
                ("engine temperature", "anomaly_engine_temp"),
            )
            if cs.get(k)
        ]
        if names:
            hits.append(f"lap {lap} ({', '.join(names)})")
    if not hits:
        return "The detector hasn't flagged anything this race. Every signal has stayed inside its forecast band."
    return "The detector flagged: " + "; ".join(hits) + "."


def _pit_events(s):
    return [
        e for e in s["race_events"] if e.get("kind") == "pit_stop" and e.get("data", {}).get("car_number") == HERO_CAR
    ]


def _why_pit(s, hero):
    stops = _pit_events(s)
    if not stops:
        d = _latest_decision(s)
        return (
            f"We haven't stopped yet. The strategist's latest call is {d['suggestion']} on lap {d['lap']}: {d.get('reasoning')}"
            if d
            else "We haven't stopped yet."
        )
    parts = []
    for e in stops:
        data = e["data"]
        lap = e["lap"]
        call = next(
            (x for x in s["race_events"] if x.get("kind") == "box_call" and x.get("lap") in (lap, lap - 1, lap - 2)),
            None,
        )
        by = (call or {}).get("data", {}).get("by") or data.get("reason")
        decision_lap = (call or {}).get("data", {}).get("decision_lap")
        d = s["decisions"].get(decision_lap) if decision_lap else None
        if by == "agent" and d:
            parts.append(
                f"We pitted on lap {lap} for {data['to_compound'].lower()}s because the strategist called PIT NOW on lap {decision_lap}. "
                f"{d.get('condition_summary') or ''} {d.get('reasoning') or ''}".strip()
            )
        elif by == "engineer":
            parts.append(
                f"We pitted on lap {lap} for {data['to_compound'].lower()}s on a manual call from the pit wall."
            )
        elif by == "tyre_life":
            parts.append(f"We pitted on lap {lap}: the {data['from_compound'].lower()}s reached the end of their life.")
        else:
            parts.append(f"We pitted on lap {lap} for {data['to_compound'].lower()}s.")
    return " ".join(parts)


def _what_if(s, hero):
    cliff = TIRE_CLIFF_AGE[hero["tire_compound"]]
    age = hero["tire_age_laps"]
    remaining = s["total_laps"] - s["lap"]
    if age >= cliff:
        extra = 0.12 * 4 * (age - cliff + remaining / 2)
        return (
            f"Staying out on {age}-lap {hero['tire_compound'].lower()}s means running past the wear cliff (about {cliff} laps) for {remaining} more laps. "
            f"We'd lose roughly {extra:.1f}s a lap by the end, far more than the 20s a stop costs, and a tyre anomaly could force us in anyway."
        )
    return (
        f"We're {age} laps into {hero['tire_compound'].lower()}s, {cliff - age} laps before the wear cliff. Staying out is fine for now; "
        f"after the cliff each lap gets about {0.12 * 4:.2f}s slower, which is when a stop starts to pay for itself."
    )


def _plan(s, hero):
    d = _latest_decision(s)
    if not d:
        return "The strategist hasn't made a call yet; it decides at the end of each lap."
    text = f"Latest call (lap {d['lap']}, {d.get('agent')}): {d['suggestion']}."
    if d.get("recommended_tire_compound"):
        text += f" Plan: {d['recommended_tire_compound'].lower()}s for about {d.get('recommended_stint_laps')} laps."
    if d.get("reasoning"):
        text += " " + d["reasoning"]
    return text


def _lap_answer(lap, s):
    cs = s["car_states"].get(lap)
    d = s["decisions"].get(lap)
    if not cs and not d:
        return f"I don't have data for lap {lap} yet; we're on lap {s['lap']}."
    text = f"Lap {lap}:"
    if cs:
        text += f" P{cs['position']}, {cs['tire_compound'].lower()}s {cs['tire_age_laps']} laps old, front-left {cs['tire_temp_fl_c']:.1f}C"
        flags = [
            n
            for n, k in (
                ("front-left temperature", "anomaly_tire_temp_fl"),
                ("front-left pressure", "anomaly_tire_pressure_fl"),
                ("engine", "anomaly_engine_temp"),
            )
            if cs.get(k)
        ]
        text += f", anomaly: {', '.join(flags)}." if flags else ", all signals nominal."
    if d:
        text += f" The strategist ({d.get('agent')}) called {d['suggestion']}"
        text += f" for {d['recommended_tire_compound'].lower()}s." if d.get("recommended_tire_compound") else "."
        if d.get("reasoning"):
            text += " " + d["reasoning"]
    events = [
        e["message"]
        for e in s["race_events"]
        if e.get("lap") == lap and e.get("kind") in ("pit_stop", "scenario", "box_call", "flag")
    ]
    if events:
        text += " Also that lap: " + " ".join(events)
    return text


def _summary(s, hero):
    start = next((g["start_position"] for g in s["grid"] if g["car_number"] == HERO_CAR), 3)
    stops = _pit_events(s)
    counts = {}
    for d in s["decisions"].values():
        counts[d["suggestion"]] = counts.get(d["suggestion"], 0) + 1
    text = f"Lap {s['lap']} of {s['total_laps']}: {HERO['driver']} started P{start} and is P{hero['position']} now"
    text += f", {_r(hero['gap_to_leader_sec'])}s off the lead." if hero["position"] > 1 else ", leading."
    if stops:
        text += (
            " Stops: "
            + ", ".join(
                f"lap {e['lap']} ({e['data']['from_compound'].lower()} to {e['data']['to_compound'].lower()})"
                for e in stops
            )
            + "."
        )
    else:
        text += f" Still on the starting {hero['tire_compound'].lower()}s, {hero['tire_age_laps']} laps old."
    anomalies = [
        lap
        for lap, cs in s["car_states"].items()
        if cs.get("anomaly_tire_temp_fl") or cs.get("anomaly_tire_pressure_fl") or cs.get("anomaly_engine_temp")
    ]
    if anomalies:
        text += (
            f" The detector flagged lap{'s' if len(anomalies) > 1 else ''} {', '.join(map(str, sorted(anomalies)))}."
        )
    if counts:
        text += " Strategist calls so far: " + ", ".join(f"{v}x {k}" for k, v in counts.items()) + "."
    return text
