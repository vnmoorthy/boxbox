"""The 22-car grid. Every team and driver is fictional.

``pace_delta`` is a car's inherent per-lap pace deficit (seconds) to the fastest car.
The top eight are closely matched; the midfield is about 0.5-0.8 s slower and the back
markers 1.0-1.35 s slower, so front-runners battle each other while the field spreads.

Rival pit laps are compressed for a 60-lap race: rivals stop on laps 10-22, while the
hero car (#88) stays out and relies on the strategist to call its stop.
"""

from __future__ import annotations

HERO_CAR = 88

TEAMS: dict[str, str] = {
    "Kestrel Racing": "#12e3a5",
    "Vanta Motorsport": "#8b5cf6",
    "Solstice GP": "#ff8c1a",
    "Ironclad Racing": "#ff3b5c",
    "Bluefin Racing": "#3b82f6",
    "Tidewater Racing": "#a3e635",
    "Polaris Racing": "#22d3ee",
    "Corsa Nera": "#c0c7d1",
    "Zenith Racing": "#6366f1",
    "Lumen Racing": "#ff5ad1",
    "Quartz Engineering": "#f4a582",
}


def _car(number, driver, code, team, start, pit_lap, pit_tire, pace):
    return {
        "car_number": number,
        "driver": driver,
        "driver_code": code,
        "team": team,
        "team_color": TEAMS[team],
        "start_position": start,
        "pit_lap": pit_lap,
        "pit_tire": pit_tire,
        "start_tire": "SOFT",
        "pace_delta": pace,
    }


GRID: list[dict] = [
    _car(1, "Kai Brennan", "BRE", "Vanta Motorsport", 1, 12, "MEDIUM", 0.00),
    _car(4, "Mateo Duarte", "DUA", "Solstice GP", 2, 15, "MEDIUM", 0.03),
    _car(88, "Elio Varga", "VAR", "Kestrel Racing", 3, None, "MEDIUM", 0.06),
    _car(16, "Rafael Costa", "COS", "Ironclad Racing", 4, 10, "MEDIUM", 0.08),
    _car(63, "Owen Hale", "HAL", "Bluefin Racing", 5, 14, "MEDIUM", 0.10),
    _car(14, "Dario Montes", "MON", "Tidewater Racing", 6, 15, "MEDIUM", 0.13),
    _car(10, "Nadia Voss", "VOS", "Polaris Racing", 7, 12, "MEDIUM", 0.15),
    _car(44, "Theo Marchand", "MAR", "Ironclad Racing", 8, 11, "MEDIUM", 0.18),
    _car(55, "Luca Bellandi", "BEL", "Corsa Nera", 9, 14, "MEDIUM", 0.50),
    _car(81, "Jonas Lindqvist", "LIN", "Solstice GP", 10, 13, "MEDIUM", 0.55),
    _car(30, "Arlo Quinn", "QUI", "Zenith Racing", 11, 14, "MEDIUM", 0.60),
    _car(18, "Freya Holm", "HOL", "Tidewater Racing", 12, 16, "MEDIUM", 0.65),
    _car(77, "Sana Okafor", "OKA", "Kestrel Racing", 13, 17, "MEDIUM", 0.70),
    _car(12, "Aiko Mori", "MOR", "Bluefin Racing", 14, 17, "MEDIUM", 0.75),
    _car(31, "Yusuf Demir", "DEM", "Lumen Racing", 15, 18, "HARD", 1.00),
    _car(87, "Leon Fischer", "FIS", "Lumen Racing", 16, 19, "HARD", 1.05),
    _car(27, "Tomas Kral", "KRA", "Quartz Engineering", 17, 21, "HARD", 1.10),
    _car(23, "Ines Ferreira", "FER", "Corsa Nera", 18, 19, "HARD", 1.15),
    _car(6, "Ravi Menon", "MEN", "Zenith Racing", 19, 20, "HARD", 1.20),
    _car(5, "Zoe Lambert", "LAM", "Quartz Engineering", 20, 22, "HARD", 1.25),
    _car(22, "Mila Novak", "NOV", "Vanta Motorsport", 21, 17, "HARD", 1.30),
    _car(7, "Callum Reid", "REI", "Polaris Racing", 22, 21, "HARD", 1.35),
]
