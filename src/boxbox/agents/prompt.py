"""The strategist's prompt, the per-lap input it reads, and the parser for its answer."""

from __future__ import annotations

import re

from boxbox.sim.grid import GRID, HERO_CAR

HERO = next(c for c in GRID if c["car_number"] == HERO_CAR)
SUGGESTIONS = ("PIT NOW", "PIT SOON", "STAY OUT")

SYSTEM_PROMPT = f"""You are the race strategist on the pit wall for {HERO["team"]}, car #{HERO_CAR}, driven by {HERO["driver"]}, in a 60-lap race. Each message is one lap of live car state from the telemetry stream. Decide whether the car should stay out or pit.

Reply with exactly these 7 lines, in this order, as plain text with no markdown:
Suggestion: <PIT NOW | PIT SOON | STAY OUT>
Condition Summary: <one sentence on the car's condition>
Race Context: <one sentence on the race situation>
Recommended Compound: <SOFT | MEDIUM | HARD | N/A>
Recommended Stint Laps: <integer | N/A>
Recommended Reason: <one sentence on the compound choice | N/A>
Reasoning: <2-4 sentences explaining the call>

Decision framework, in priority order:
1. Tyre anomalies. The anomaly flags come from a streaming detector that forecasts each lap from this stint's history and flags values outside its 99.99% band. A front-left temperature or pressure anomaly is evidence of a real tyre problem (overheating, puncture): call PIT NOW. A high reading without a flag is still within expected bounds.
2. Engine anomaly. A pit stop cannot fix the engine. Call STAY OUT (or PIT SOON if a stop is due anyway) and tell the driver how to manage it: lift-and-coast, short-shift.
3. Safety car. Under the safety car a stop costs about half the usual time and the bunched field limits the places lost. If the tyres are 10 or more laps old and at least 10 laps remain, call PIT NOW for fresh tyres, even if the car has already stopped: fresh rubber against rivals on old tyres is worth more than the few places a cheap stop costs.
4. Pit history. Otherwise, a car that has already stopped should run to the flag on its current tyres unless a tyre anomaly appears.
5. Tyre age. Softs fall off sharply after about 20 laps: from lap 20 of a soft stint, call PIT SOON. Mediums after about 32 laps, hards after about 45.
6. Otherwise, STAY OUT. Track position is worth about 20 seconds.

Only PIT NOW boxes the car: it pits at the start of the next lap on the compound you recommend. Choose the compound that reaches the flag in one stint: more than 38 laps left, HARD; 18 to 38 laps, MEDIUM; fewer than 18, SOFT.
For STAY OUT, write N/A on the three Recommended lines. Use the real numbers from the input."""


def _f(v, digits=1) -> str:
    return "n/a" if v is None else f"{v:.{digits}f}"


def _flag(v) -> str:
    return "TRUE" if v else "FALSE"


def format_car_state(cs: dict, *, total_laps: int = 60) -> str:
    """Render one ``car_state`` row as the strategist's input message."""
    b = cs.get("bounds") or {}
    fl_bounds = b.get("tire_temp_fl_c")
    fl_note = (
        f" (expected {_f(fl_bounds['expected'])}C, upper bound {_f(fl_bounds['upper'])}C)"
        if fl_bounds
        else " (detector still training)"
    )
    pr_bounds = b.get("tire_pressure_fl_psi")
    pr_note = (
        f" (expected {_f(pr_bounds['expected'], 2)}, lower bound {_f(pr_bounds['lower'], 2)} psi)" if pr_bounds else ""
    )
    lap = cs["lap"]
    return (
        f"CAR STATE: lap {lap} of {total_laps}\n"
        f"Driver: {HERO['driver']} (#{HERO_CAR}) | Position: P{cs['position']} | Pit stops taken: {cs['pit_stops']}\n"
        f"TYRES: {cs['tire_compound']}, {cs['tire_age_laps']} laps old\n"
        f"  Temps (C): FL {_f(cs['tire_temp_fl_c'])} FR {_f(cs['tire_temp_fr_c'])} RL {_f(cs['tire_temp_rl_c'])} RR {_f(cs['tire_temp_rr_c'])}\n"
        f"  Pressures (psi): FL {_f(cs['tire_pressure_fl_psi'], 2)} FR {_f(cs['tire_pressure_fr_psi'], 2)} "
        f"RL {_f(cs['tire_pressure_rl_psi'], 2)} RR {_f(cs['tire_pressure_rr_psi'], 2)}\n"
        f"  Front-left temperature anomaly: {_flag(cs.get('anomaly_tire_temp_fl'))}{fl_note}\n"
        f"  Front-left pressure anomaly: {_flag(cs.get('anomaly_tire_pressure_fl'))}{pr_note}\n"
        f"CAR SYSTEMS: engine {_f(cs['engine_temp_c'])}C (anomaly {_flag(cs.get('anomaly_engine_temp'))}) | "
        f"brakes FL {_f(cs['brake_temp_fl_c'], 0)}C FR {_f(cs['brake_temp_fr_c'], 0)}C | "
        f"battery {_f(cs['battery_charge_pct'])}% | fuel {_f(cs['fuel_remaining_kg'])} kg\n"
        f"RACE: gap to leader {_f(cs['gap_to_leader_sec'])}s | gap to car ahead {_f(cs['gap_to_ahead_sec'])}s | "
        f"laps remaining {total_laps - lap} | safety car: {'YES' if cs.get('safety_car') else 'no'}"
    )


def _line(text: str, label: str) -> str | None:
    m = re.search(rf"^\W*\**{re.escape(label)}:\**\s*(.+?)\s*$", text, re.IGNORECASE | re.MULTILINE)
    return m.group(1).strip().strip("*").strip() if m else None


def _na(v: str | None) -> str | None:
    return None if v is None or v.strip().upper() in ("N/A", "NA", "NONE", "-", "") else v


def parse_response(text: str) -> dict:
    """Extract the 7 labeled fields. Unknown suggestions default to STAY OUT."""
    raw = (_line(text, "Suggestion") or "").upper()
    suggestion = next((s for s in SUGGESTIONS if s in raw), "STAY OUT")
    compound = (_na(_line(text, "Recommended Compound")) or "").upper()
    compound = next((c for c in ("SOFT", "MEDIUM", "HARD") if c in compound), None)
    stint_raw = _na(_line(text, "Recommended Stint Laps"))
    stint = None
    if stint_raw:
        m = re.search(r"\d+", stint_raw)
        stint = int(m.group()) if m else None
    reasoning = None
    m = re.search(r"^\W*\**Reasoning:\**\s*([\s\S]+?)\s*$", text, re.IGNORECASE | re.MULTILINE)
    if m:
        reasoning = m.group(1).strip()
    return {
        "suggestion": suggestion,
        "condition_summary": _line(text, "Condition Summary"),
        "race_context": _line(text, "Race Context"),
        "recommended_tire_compound": compound if suggestion != "STAY OUT" else None,
        "recommended_stint_laps": stint if suggestion != "STAY OUT" else None,
        "recommended_reason": _na(_line(text, "Recommended Reason")) if suggestion != "STAY OUT" else None,
        "reasoning": reasoning,
    }
