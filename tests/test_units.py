from boxbox.agents import rules
from boxbox.agents.prompt import SYSTEM_PROMPT, format_car_state, parse_response
from boxbox.record import retime
from boxbox.stream.detector import TrendDetector


def _cs(**kw):
    base = {
        "car_number": 88,
        "lap": 12,
        "window_start": 0,
        "window_end": 20000,
        "tire_temp_fl_c": 100.0,
        "tire_temp_fr_c": 100.2,
        "tire_temp_rl_c": 97.0,
        "tire_temp_rr_c": 96.5,
        "tire_pressure_fl_psi": 21.4,
        "tire_pressure_fr_psi": 21.4,
        "tire_pressure_rl_psi": 20.4,
        "tire_pressure_rr_psi": 20.4,
        "engine_temp_c": 120.0,
        "brake_temp_fl_c": 450.0,
        "brake_temp_fr_c": 460.0,
        "battery_charge_pct": 70.0,
        "fuel_remaining_kg": 35.0,
        "position": 4,
        "gap_to_ahead_sec": 1.2,
        "gap_to_leader_sec": 5.5,
        "pit_stops": 0,
        "tire_compound": "SOFT",
        "tire_age_laps": 12,
        "anomaly_tire_temp_fl": False,
        "anomaly_tire_pressure_fl": False,
        "anomaly_engine_temp": False,
        "bounds": {"tire_temp_fl_c": {"expected": 100.1, "lower": 97.0, "upper": 103.2}},
        "safety_car": False,
    }
    base.update(kw)
    return base


# ---- detector ---------------------------------------------------------------
def test_detector_learns_then_flags_a_spike_and_keeps_flagging():
    d = TrendDetector(side="upper", min_sigma=0.5)
    for i in range(6):
        assert d.observe(95 + 0.4 * i).expected is None
    v = d.observe(95 + 0.4 * 6)
    assert v.expected is not None and not v.is_anomaly
    assert d.observe(140).is_anomaly
    assert d.observe(141).is_anomaly  # anomalies aren't learned as the new normal


def test_detector_resets_per_stint_and_ignores_the_wrong_side():
    d = TrendDetector(side="upper")
    for i in range(10):
        d.observe(100 + 0.4 * i, stint=1)
    assert not d.observe(80, stint=1).is_anomaly  # a drop isn't an upper anomaly
    assert d.observe(95, stint=2).expected is None  # new stint: training again


def test_detector_scores_without_learning():
    d = TrendDetector(side="lower", min_sigma=0.08)
    for _ in range(8):
        d.observe(21.0)
    before = len(d._history)
    assert d.observe(18.0, learn=False).is_anomaly
    assert not d.observe(21.0, learn=False).is_anomaly
    assert len(d._history) == before


# ---- strategist -------------------------------------------------------------
def test_rules_cover_the_decision_framework():
    assert parse_response(rules.decide(_cs()))["suggestion"] == "STAY OUT"
    assert parse_response(rules.decide(_cs(tire_age_laps=20, lap=20)))["suggestion"] == "PIT SOON"
    hot = parse_response(rules.decide(_cs(lap=24, tire_age_laps=24, tire_temp_fl_c=145.0, anomaly_tire_temp_fl=True)))
    assert (
        hot["suggestion"] == "PIT NOW"
        and hot["recommended_tire_compound"] == "MEDIUM"
        and hot["recommended_stint_laps"] == 36
    )
    eng = parse_response(rules.decide(_cs(engine_temp_c=137.0, anomaly_engine_temp=True)))
    assert eng["suggestion"] == "STAY OUT" and "lift-and-coast" in eng["reasoning"]
    sc = parse_response(rules.decide(_cs(safety_car=True)))
    assert sc["suggestion"] == "PIT NOW" and sc["recommended_tire_compound"] == "HARD"
    done = parse_response(rules.decide(_cs(pit_stops=1, tire_compound="MEDIUM", tire_age_laps=30)))
    assert done["suggestion"] == "STAY OUT" and done["recommended_tire_compound"] is None


def test_parser_tolerates_markdown_and_unknowns():
    text = "**Suggestion:** pit now\n**Condition Summary:** hot.\nRace Context: P8.\nRecommended Compound: Medium\nRecommended Stint Laps: about 36 laps\nRecommended Reason: reach the flag.\nReasoning: Box.\nIt is hot."
    p = parse_response(text)
    assert (
        p["suggestion"] == "PIT NOW"
        and p["recommended_tire_compound"] == "MEDIUM"
        and p["recommended_stint_laps"] == 36
    )
    assert p["reasoning"].startswith("Box.")
    assert parse_response("nonsense")["suggestion"] == "STAY OUT"
    stay = parse_response("Suggestion: STAY OUT\nRecommended Compound: HARD\nRecommended Stint Laps: 20")
    assert stay["recommended_tire_compound"] is None and stay["recommended_stint_laps"] is None


def test_prompt_input_carries_flags_and_bounds():
    text = format_car_state(_cs(anomaly_tire_temp_fl=True, tire_temp_fl_c=145.0))
    assert "Front-left temperature anomaly: TRUE" in text and "upper bound 103.2C" in text
    assert "laps remaining 48" in text
    assert "PIT NOW" in SYSTEM_PROMPT and "Elio Varga" in SYSTEM_PROMPT


# ---- replay timeline ---------------------------------------------------------
def test_retime_is_monotonic_and_paced():
    events = [
        {"topic": "race_events", "value": {"kind": "race_start"}, "ts": 9},
        {"topic": "race_standings", "value": {"lap": 1}, "ts": 1},
        {"topic": "car_telemetry", "value": {"lap": 1, "lap_fraction": 0.5}, "ts": 2},
        {"topic": "car_state", "value": {"lap": 1}, "ts": 3},
        {"topic": "pit_decisions", "value": {"lap": 1, "latency_ms": 99999}, "ts": 4},
        {"topic": "race_standings", "value": {"lap": 2}, "ts": 5},
    ]
    out = retime(events, pace_ms=1000, start_ts=0)
    ts = [e["ts"] for e in out]
    assert ts == sorted(ts)
    assert ts[2] == 500 and ts[3] == 1040 and ts[4] == 1040 + 300 + 60
