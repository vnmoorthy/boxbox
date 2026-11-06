"""Hero-car sensor readings: tyres, engine, brakes, energy, fuel, driver inputs."""

from __future__ import annotations

import random

from boxbox.sim.scenarios import Effects

FUEL_START_KG = 44.0
FUEL_BURN_PER_LAP = 0.7
TIRE_TEMP_BASE = {"fl": 95.0, "fr": 95.0, "rl": 93.0, "rr": 93.0}
TIRE_TEMP_GRADIENT = {"fl": 0.42, "fr": 0.45, "rl": 0.39, "rr": 0.35}
COMPOUND_TEMP_OFFSET = {"SOFT": 0.0, "MEDIUM": -2.0, "HARD": -4.0}
TIRE_PRESSURE_BASE = {"fl": 22.0, "fr": 22.0, "rl": 21.0, "rr": 21.0}
TIRE_PRESSURE_DROP_PER_LAP = 0.05


def generate_reading(
    rng: random.Random,
    *,
    lap: int,
    tire_age: int,
    compound: str,
    effects: Effects,
    lap_fraction: float,
) -> dict:
    sc = effects.safety_car
    temps = {}
    for corner in ("fl", "fr", "rl", "rr"):
        t = TIRE_TEMP_BASE[corner] + TIRE_TEMP_GRADIENT[corner] * tire_age + COMPOUND_TEMP_OFFSET[compound]
        t += rng.uniform(-1.0, 1.0) - (6.0 if sc else 0.0)
        temps[corner] = t
    temps["fl"] += effects.fl_temp_add
    if effects.fl_temp_floor is not None:
        temps["fl"] = max(temps["fl"], effects.fl_temp_floor + rng.uniform(-2.0, 2.0))

    pressures = {
        corner: TIRE_PRESSURE_BASE[corner] - TIRE_PRESSURE_DROP_PER_LAP * tire_age + rng.uniform(-0.1, 0.1)
        for corner in ("fl", "fr", "rl", "rr")
    }
    pressures["fl"] -= effects.fl_pressure_drop

    engine = 120.0 + rng.uniform(-2.0, 2.0) + effects.engine_add - (8.0 if sc else 0.0)
    brake_base = 300.0 if sc else 450.0
    battery = 60.0 + 20.0 * (0.5 + 0.5 * (((lap * 3 + tire_age) % 7) / 7.0)) + rng.uniform(-2.0, 2.0)
    fuel = max(0.5, FUEL_START_KG - FUEL_BURN_PER_LAP * (lap - 1 + lap_fraction) + rng.uniform(-0.05, 0.05))
    speed = rng.uniform(150, 200) if sc else 280.0 + rng.uniform(0, 40)
    throttle = rng.uniform(30, 60) if sc else rng.uniform(60, 100)
    brake = rng.uniform(0, 15) if rng.random() < 0.3 else 0.0
    return {
        "lap": lap,
        "lap_fraction": round(lap_fraction, 3),
        "tire_temp_fl_c": round(temps["fl"], 1),
        "tire_temp_fr_c": round(temps["fr"], 1),
        "tire_temp_rl_c": round(temps["rl"], 1),
        "tire_temp_rr_c": round(temps["rr"], 1),
        "tire_pressure_fl_psi": round(pressures["fl"], 2),
        "tire_pressure_fr_psi": round(pressures["fr"], 2),
        "tire_pressure_rl_psi": round(pressures["rl"], 2),
        "tire_pressure_rr_psi": round(pressures["rr"], 2),
        "engine_temp_c": round(engine, 1),
        "brake_temp_fl_c": round(brake_base + rng.uniform(-25, 25), 1),
        "brake_temp_fr_c": round(brake_base + 10 + rng.uniform(-25, 25), 1),
        "battery_charge_pct": round(max(35.0, min(85.0, battery)), 1),
        "fuel_remaining_kg": round(fuel, 2),
        "drs_active": (not sc) and rng.random() > 0.6,
        "speed_kph": round(speed, 1),
        "throttle_pct": round(throttle, 1),
        "brake_pct": round(brake, 1),
    }
