"""Full headless races through the whole pipeline: sim -> car_state -> strategist -> sim."""

from conftest import run_race


def test_default_race_flags_the_lap_24_overheat_and_the_car_obeys():
    race = run_race(laps=60)
    assert len(race.car_states) == 60 and len(race.decisions) == 60
    assert race.anomaly_laps() == [24]
    assert race.decisions[24]["suggestion"] == "PIT NOW"
    assert race.decisions[24]["recommended_tire_compound"] == "MEDIUM"
    assert all(race.decisions[lap]["suggestion"] == "STAY OUT" for lap in range(1, 20))
    call = race.race_events("box_call")[0]
    assert call["data"]["by"] == "agent" and call["data"]["decision_lap"] == 24
    assert [(s["lap"], s["data"]["to_compound"], s["data"]["reason"]) for s in race.hero_stops] == [
        (25, "MEDIUM", "agent")
    ]
    finish = race.race_events("finish")[0]["data"]
    assert finish["summary"]["pit_laps"] == [25]
    assert finish["summary"]["anomaly_laps"] == [24]
    assert len(finish["results"]) == 22


def test_detector_trains_before_it_judges():
    race = run_race(laps=30, scripted=False)
    early = race.car_states[3]
    assert early["bounds"]["tire_temp_fl_c"] is None
    assert race.car_states[10]["bounds"]["tire_temp_fl_c"] is not None
    assert race.anomaly_laps() == []


def test_slow_puncture_is_caught_on_pressure_and_boxed():
    race = run_race(laps=40, scripted=False, commands={8: {"command": "scenario", "kind": "puncture"}})
    pressure_laps = race.anomaly_laps("anomaly_tire_pressure_fl")
    assert pressure_laps and pressure_laps[0] <= 9
    assert race.decisions[pressure_laps[0]]["suggestion"] == "PIT NOW"
    assert race.hero_stops and race.hero_stops[0]["lap"] <= pressure_laps[0] + 1
    assert any(e["data"]["kind"] == "puncture" for e in race.race_events("scenario_end"))


def test_engine_overheat_is_flagged_but_not_pitted_for():
    race = run_race(laps=30, scripted=False, commands={10: {"command": "scenario", "kind": "engine"}})
    engine_laps = race.anomaly_laps("anomaly_engine_temp")
    assert engine_laps and engine_laps[0] <= 11
    assert all(race.decisions[lap]["suggestion"] != "PIT NOW" for lap in engine_laps)
    assert "lift-and-coast" in race.decisions[engine_laps[0]]["reasoning"]
    assert not any(s["lap"] <= engine_laps[-1] for s in race.hero_stops)


def test_safety_car_triggers_the_cheap_stop():
    race = run_race(laps=40, scripted=False, commands={14: {"command": "scenario", "kind": "safety_car"}})
    flags = [e["data"]["flag"] for e in race.race_events("flag")]
    assert "SC" in flags and flags.count("GREEN") >= 2
    sc_laps = sorted(lap for lap, c in race.car_states.items() if c["safety_car"])
    assert sc_laps
    first = race.decisions[sc_laps[0]]
    assert first["suggestion"] == "PIT NOW"
    stop = race.hero_stops[0]
    assert stop["lap"] <= sc_laps[0] + 2
    assert stop["data"]["stop_time_sec"] == 10.0  # half price under the safety car
    assert race.anomaly_laps() == []  # slow, cool SC laps aren't anomalies


def test_without_autopilot_the_car_ignores_pit_now_until_the_driver_gives_up():
    race = run_race(laps=40, autopilot=False)
    assert all(race.decisions[lap]["suggestion"] == "PIT NOW" for lap in range(24, 29))
    call = race.race_events("box_call")[0]
    assert call["data"]["by"] == "tyre_life" and "front-left" in call["message"]
    assert race.hero_stops[0]["data"]["reason"] == "tyre_life"
    assert race.hero_stops[0]["lap"] == 29  # five laps of nursing the overheating tyre


def test_engineer_box_pits_next_lap_on_the_chosen_compound():
    race = run_race(laps=30, scripted=False, commands={6: {"command": "box", "compound": "HARD"}})
    stop = race.hero_stops[0]
    assert stop["data"]["reason"] == "engineer" and stop["data"]["to_compound"] == "HARD"
    assert stop["lap"] in (7, 8)


def test_restart_abandons_and_starts_a_new_race():
    race = run_race(laps=12, scripted=False, commands={4: {"command": "restart"}})
    # The view keeps only the new race's log, which begins with race_start.
    first = race.events[0]["value"]
    assert first["kind"] == "race_start" and first["race_id"] == 2
    assert len(race.decisions) == 12
