"""The rules strategist: the same decision framework as the prompt, as code.

It answers in the exact 7-line format Claude uses, so both brains go through one
parser and the dashboard can't tell them apart except by the ``agent`` field. It runs
instantly and offline, which makes it the fallback when no LLM is configured or a
call fails, and the routine-lap brain in hybrid mode.
"""

from __future__ import annotations

from boxbox.sim.engine import default_compound

PIT_SOON_AGE = {"SOFT": 20, "MEDIUM": 32, "HARD": 45}


def decide(cs: dict, *, total_laps: int = 60) -> str:
    lap = cs["lap"]
    remaining = total_laps - lap
    compound = cs["tire_compound"]
    age = cs["tire_age_laps"]
    pos = cs["position"]
    gap = cs["gap_to_leader_sec"]
    stops = cs["pit_stops"]
    fl = cs["tire_temp_fl_c"]
    pressure = cs["tire_pressure_fl_psi"]
    engine = cs["engine_temp_c"]
    bounds = cs.get("bounds") or {}
    sc = bool(cs.get("safety_car"))
    rec = default_compound(remaining)
    stint = remaining

    race_context = f"Running P{pos}, {gap:.1f}s off the lead with {remaining} laps remaining" + (
        " under the safety car." if sc else "."
    )
    temp_note = ""
    if bounds.get("tire_temp_fl_c"):
        b = bounds["tire_temp_fl_c"]
        temp_note = f", {fl - b['upper']:.1f}C above its {b['upper']:.1f}C upper bound"

    if cs.get("anomaly_tire_temp_fl") or cs.get("anomaly_tire_pressure_fl"):
        if cs.get("anomaly_tire_pressure_fl"):
            cond = (
                f"Front-left pressure anomaly at {pressure:.2f} psi with the tyre at {fl:.0f}C: a likely slow puncture."
            )
            why = "A deflating tyre loses time every lap and risks a failure"
        else:
            cond = f"Front-left temperature anomaly at {fl:.1f}C{temp_note}."
            why = f"An overheating front-left on a {age}-lap {compound.lower()} risks delamination or failure"
        return _answer(
            "PIT NOW",
            cond,
            race_context,
            rec,
            stint,
            f"{rec.title()}s cover the remaining {remaining} laps in one stint.",
            f"The streaming detector flagged the front-left outside its forecast band, which is evidence of a real fault, not noise. "
            f"{why}, so we box this lap rather than gamble on track position. "
            f"Switching to {rec.lower()}s now means no further stop is needed to reach the flag.",
        )

    if cs.get("anomaly_engine_temp"):
        due = stops == 0 and age >= PIT_SOON_AGE[compound]
        return _answer(
            "PIT SOON" if due else "STAY OUT",
            f"Engine running hot at {engine:.1f}C, flagged as anomalous; tyres {compound.lower()} at {age} laps.",
            race_context,
            rec if due else None,
            stint if due else None,
            f"{rec.title()}s reach the flag." if due else None,
            "A pit stop can't cool the engine, so stopping for it would only cost track position. "
            "Driver: lift-and-coast into the heavy braking zones and short-shift on exits until temperatures recover. "
            + (
                "The tyres are due anyway, so plan the stop in the next few laps." if due else "Stay out and manage it."
            ),
        )

    if sc and age >= 10 and remaining >= 10:
        why = (
            "We haven't stopped yet, so this is the cheapest stop we'll get all race."
            if stops == 0
            else f"We've already stopped once, but {remaining} laps on fresh {rec.lower()}s against rivals on old tyres is worth far more than the few places a stop costs behind the safety car."
        )
        return _answer(
            "PIT NOW",
            f"{compound.title()}s at {age} laps; all sensors nominal.",
            race_context,
            rec,
            stint,
            f"Fresh {rec.lower()}s go flat out to the flag.",
            f"The safety car has bunched the field and a stop costs about half the usual 20 seconds, and the pack limits how many places we lose. {why}",
        )

    if stops > 0:
        return _answer(
            "STAY OUT",
            f"{compound.title()}s at {age} laps; front-left {fl:.0f}C and all sensors within bounds.",
            race_context,
            None,
            None,
            None,
            f"Our stop is done and the {compound.lower()}s have the range to reach the flag. "
            "Nothing in the telemetry is outside its band, so we hold position and push.",
        )

    if age >= PIT_SOON_AGE[compound]:
        return _answer(
            "PIT SOON",
            f"{compound.title()}s at {age} laps are past their best; front-left {fl:.0f}C, no anomaly.",
            race_context,
            rec,
            stint,
            f"{rec.title()}s give a clean one-stop to the flag.",
            f"{compound.title()}s fall off sharply after about {PIT_SOON_AGE[compound]} laps, so the pit window is open. "
            "No anomaly is flagged, so we don't need to react this lap; prepare the stop and watch the front-left.",
        )

    return _answer(
        "STAY OUT",
        f"{compound.title()}s at {age} laps; front-left {fl:.0f}C, all sensors within their bands.",
        race_context,
        None,
        None,
        None,
        "The tyres are inside their working window and the detector sees nothing unusual. "
        "Pitting now would cost about 20 seconds of track position, so we stay out.",
    )


def _answer(suggestion, condition, context, compound, stint, reason, reasoning) -> str:
    return "\n".join(
        [
            f"Suggestion: {suggestion}",
            f"Condition Summary: {condition}",
            f"Race Context: {context}",
            f"Recommended Compound: {compound or 'N/A'}",
            f"Recommended Stint Laps: {stint if stint is not None else 'N/A'}",
            f"Recommended Reason: {reason or 'N/A'}",
            f"Reasoning: {reasoning}",
        ]
    )
