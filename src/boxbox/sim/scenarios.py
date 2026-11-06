"""Incidents you can throw at the hero car, and what each does to its sensors and pace."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class ScenarioSpec:
    kind: str
    label: str
    icon: str
    description: str
    ends_on_pit: bool
    duration_laps: int | None = None

    def public(self) -> dict:
        return {"kind": self.kind, "label": self.label, "icon": self.icon, "description": self.description}


SCENARIOS: dict[str, ScenarioSpec] = {
    s.kind: s
    for s in (
        ScenarioSpec(
            "fl_overheat",
            "Front-left overheating",
            "flame",
            "The front-left tyre's temperature spikes past 140°C. The detector should flag it within a lap and the strategist should call PIT NOW.",
            ends_on_pit=True,
        ),
        ScenarioSpec(
            "puncture",
            "Slow puncture",
            "tire",
            "The front-left tyre loses about 1.6 psi per lap and heats up, costing more time every lap until the car pits.",
            ends_on_pit=True,
        ),
        ScenarioSpec(
            "engine",
            "Engine overheating",
            "thermometer",
            "Engine temperature climbs about 16°C for four laps. A pit stop can't fix it; the strategist should manage it from the track.",
            ends_on_pit=False,
            duration_laps=4,
        ),
        ScenarioSpec(
            "safety_car",
            "Safety car",
            "flag",
            "A three-lap safety car bunches the field and halves the cost of a stop: an opening for a cheap pit stop.",
            ends_on_pit=False,
            duration_laps=3,
        ),
    )
}


@dataclass
class ActiveScenario:
    kind: str
    since_lap: int
    since_fraction: float
    source: str
    spec: ScenarioSpec = field(repr=False, default=None)  # type: ignore[assignment]

    def __post_init__(self) -> None:
        self.spec = SCENARIOS[self.kind]

    def progress(self, lap: int, fraction: float) -> float:
        """Laps elapsed since the scenario began (fractional)."""
        return max(0.0, (lap + fraction) - (self.since_lap + self.since_fraction))

    def expired(self, lap: int) -> bool:
        return self.spec.duration_laps is not None and lap >= self.since_lap + self.spec.duration_laps

    def public(self) -> dict:
        return {"kind": self.kind, "label": self.spec.label, "since_lap": self.since_lap, "source": self.source}


@dataclass
class Effects:
    fl_temp_floor: float | None = None
    fl_temp_add: float = 0.0
    fl_pressure_drop: float = 0.0
    engine_add: float = 0.0
    lap_penalty: float = 0.0
    safety_car: bool = False


def effects_for(active: list[ActiveScenario], lap: int, fraction: float) -> Effects:
    eff = Effects()
    for sc in active:
        t = sc.progress(lap, fraction)
        if sc.kind == "fl_overheat":
            eff.fl_temp_floor = 128.0 + min(t, 0.5) * 34.0  # ramps to ~145 within half a lap
            eff.lap_penalty += 0.8
        elif sc.kind == "puncture":
            eff.fl_pressure_drop += min(9.0, 1.6 * (t + 0.4))
            eff.fl_temp_add += 5.0 + 2.5 * t
            eff.lap_penalty += min(8.0, 1.2 + 1.0 * t)
        elif sc.kind == "engine":
            eff.engine_add += 16.0 * min(1.0, 0.4 + t)
            eff.lap_penalty += 0.35
        elif sc.kind == "safety_car":
            eff.safety_car = True
    return eff
