"""Race physics: 22 cars, cumulative race time, tyre wear with a cliff.

Positions come from sorting cars by total race time, so overtakes happen naturally
when a faster car's cumulative time undercuts a slower one. A stop costs about 20 s
but resets tyre wear. Under the safety car everyone laps slowly, the field bunches
up, and a stop costs about half as much: the classic cheap stop.
"""

from __future__ import annotations

import random

COMPOUNDS = ("SOFT", "MEDIUM", "HARD")

# Seconds added per lap of tyre age, and the age where wear accelerates (the cliff).
TIRE_DEGRADATION = {"SOFT": 0.12, "MEDIUM": 0.08, "HARD": 0.02}
TIRE_CLIFF_AGE = {"SOFT": 14, "MEDIUM": 28, "HARD": 38}
TIRE_CLIFF_FACTOR = 4.0
TIRE_BASE_PACE = {"SOFT": 90.5, "MEDIUM": 91.0, "HARD": 91.5}
# Past this age a tyre is unsafe and the driver boxes whatever the pit wall says.
TIRE_MAX_LIFE = {"SOFT": 30, "MEDIUM": 42, "HARD": 55}

PIT_STOP_TIME_SEC = 20.0
SAFETY_CAR_LAP_TIME = 118.0
SAFETY_CAR_PIT_FACTOR = 0.5
SAFETY_CAR_INTERVAL = 0.8  # seconds between cars once the field bunches up


class Car:
    def __init__(self, info: dict) -> None:
        self.car_number: int = info["car_number"]
        self.driver: str = info["driver"]
        self.driver_code: str = info["driver_code"]
        self.team: str = info["team"]
        self.team_color: str = info["team_color"]
        self.start_position: int = info["start_position"]
        self.pit_lap: int | None = info["pit_lap"]
        self.pit_tire: str = info["pit_tire"]
        self.tire_compound: str = info["start_tire"]
        self.pace_delta: float = info["pace_delta"]
        self.position = self.start_position
        self.tire_age_laps = 0
        self.pit_stops = 0
        self.in_pit_lane = False
        self.has_pitted = False
        self.gap_to_leader_sec = 0.0
        self.gap_to_ahead_sec = 0.0
        self.last_lap_time_sec = TIRE_BASE_PACE[self.tire_compound]
        self.total_race_time = (self.start_position - 1) * 0.3

    def lap_time(self, rng: random.Random, penalty: float = 0.0) -> float:
        age = self.tire_age_laps
        deg = TIRE_DEGRADATION[self.tire_compound]
        cliff = TIRE_CLIFF_AGE[self.tire_compound]
        wear = deg * age if age <= cliff else deg * cliff + deg * TIRE_CLIFF_FACTOR * (age - cliff)
        return TIRE_BASE_PACE[self.tire_compound] + wear + self.pace_delta + penalty + rng.gauss(0, 0.08)

    def pit(self, compound: str) -> None:
        self.tire_compound = compound
        self.tire_age_laps = 0
        self.pit_stops += 1
        self.in_pit_lane = True
        self.has_pitted = True


class RaceModel:
    def __init__(self, grid: list[dict], rng: random.Random) -> None:
        self.rng = rng
        self.cars = sorted((Car(info) for info in grid), key=lambda c: c.total_race_time)
        self.lap = 0
        for i, car in enumerate(self.cars):
            car.position = i + 1
        self._update_gaps()

    def car(self, number: int) -> Car:
        return next(c for c in self.cars if c.car_number == number)

    def advance_lap(
        self,
        boxes: dict[int, str] | None = None,
        penalties: dict[int, float] | None = None,
        safety_car: bool = False,
    ) -> list[dict]:
        """Run one lap. Returns the pit stops made this lap.

        ``boxes`` maps car number to the compound it pits for this lap (on top of the
        scripted rival strategies); ``penalties`` adds seconds to a car's lap time.
        """
        boxes = boxes or {}
        penalties = penalties or {}
        self.lap += 1
        stops = []
        for car in self.cars:
            car.in_pit_lane = False
        for car in self.cars:
            compound = boxes.get(car.car_number)
            reason = "box"
            if compound is None and car.pit_lap == self.lap and not car.has_pitted:
                compound, reason = car.pit_tire, "strategy"
            if compound is not None:
                stops.append(
                    {
                        "car_number": car.car_number,
                        "from_compound": car.tire_compound,
                        "to_compound": compound,
                        "reason": reason,
                    }
                )
                car.pit(compound)

        stop_cost = PIT_STOP_TIME_SEC * (SAFETY_CAR_PIT_FACTOR if safety_car else 1.0)
        for car in self.cars:
            car.tire_age_laps += 1
            if safety_car:
                car.last_lap_time_sec = SAFETY_CAR_LAP_TIME + self.rng.gauss(0, 0.05)
            else:
                car.last_lap_time_sec = car.lap_time(self.rng, penalties.get(car.car_number, 0.0))
            car.total_race_time += car.last_lap_time_sec + (stop_cost if car.in_pit_lane else 0.0)

        self.cars.sort(key=lambda c: c.total_race_time)
        if safety_car:
            leader = self.cars[0].total_race_time
            for i, car in enumerate(self.cars):
                gap = car.total_race_time - leader
                car.total_race_time = leader + min(gap, max(i * SAFETY_CAR_INTERVAL, gap * 0.4))
        for i, car in enumerate(self.cars):
            car.position = i + 1
        self._update_gaps()
        for stop in stops:
            stop["stop_time_sec"] = round(stop_cost, 1)
        return stops

    def _update_gaps(self) -> None:
        leader = self.cars[0].total_race_time
        for i, car in enumerate(self.cars):
            car.gap_to_leader_sec = round(car.total_race_time - leader, 1)
            car.gap_to_ahead_sec = 0.0 if i == 0 else round(car.total_race_time - self.cars[i - 1].total_race_time, 1)

    def standings(self) -> list[dict]:
        return [
            {
                "car_number": c.car_number,
                "driver": c.driver,
                "driver_code": c.driver_code,
                "team": c.team,
                "team_color": c.team_color,
                "lap": self.lap,
                "position": c.position,
                "gap_to_leader_sec": c.gap_to_leader_sec,
                "gap_to_ahead_sec": c.gap_to_ahead_sec,
                "last_lap_time_sec": round(c.last_lap_time_sec, 3),
                "pit_stops": c.pit_stops,
                "tire_compound": c.tire_compound,
                "tire_age_laps": c.tire_age_laps,
                "in_pit_lane": c.in_pit_lane,
            }
            for c in self.cars
        ]
