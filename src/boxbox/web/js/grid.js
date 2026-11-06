// The fictional 22-car grid, mirrored from src/boxbox/sim/grid.py.
// Used by the synthetic generator and as a fallback when a session has no race_start.

export const HERO_CAR = 88;

export const TEAMS = {
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
};

function car(number, driver, code, team, start, pitLap, pitTire, pace) {
  return {
    car_number: number,
    driver,
    driver_code: code,
    team,
    team_color: TEAMS[team],
    start_position: start,
    pit_lap: pitLap,
    pit_tire: pitTire,
    start_tire: "SOFT",
    pace_delta: pace,
  };
}

export const GRID = [
  car(1, "Kai Brennan", "BRE", "Vanta Motorsport", 1, 12, "MEDIUM", 0.0),
  car(4, "Mateo Duarte", "DUA", "Solstice GP", 2, 15, "MEDIUM", 0.03),
  car(88, "Elio Varga", "VAR", "Kestrel Racing", 3, null, "MEDIUM", 0.06),
  car(16, "Rafael Costa", "COS", "Ironclad Racing", 4, 10, "MEDIUM", 0.08),
  car(63, "Owen Hale", "HAL", "Bluefin Racing", 5, 14, "MEDIUM", 0.1),
  car(14, "Dario Montes", "MON", "Tidewater Racing", 6, 15, "MEDIUM", 0.13),
  car(10, "Nadia Voss", "VOS", "Polaris Racing", 7, 12, "MEDIUM", 0.15),
  car(44, "Theo Marchand", "MAR", "Ironclad Racing", 8, 11, "MEDIUM", 0.18),
  car(55, "Luca Bellandi", "BEL", "Corsa Nera", 9, 14, "MEDIUM", 0.5),
  car(81, "Jonas Lindqvist", "LIN", "Solstice GP", 10, 13, "MEDIUM", 0.55),
  car(30, "Arlo Quinn", "QUI", "Zenith Racing", 11, 14, "MEDIUM", 0.6),
  car(18, "Freya Holm", "HOL", "Tidewater Racing", 12, 16, "MEDIUM", 0.65),
  car(77, "Sana Okafor", "OKA", "Kestrel Racing", 13, 17, "MEDIUM", 0.7),
  car(12, "Aiko Mori", "MOR", "Bluefin Racing", 14, 17, "MEDIUM", 0.75),
  car(31, "Yusuf Demir", "DEM", "Lumen Racing", 15, 18, "HARD", 1.0),
  car(87, "Leon Fischer", "FIS", "Lumen Racing", 16, 19, "HARD", 1.05),
  car(27, "Tomas Kral", "KRA", "Quartz Engineering", 17, 21, "HARD", 1.1),
  car(23, "Ines Ferreira", "FER", "Corsa Nera", 18, 19, "HARD", 1.15),
  car(6, "Ravi Menon", "MEN", "Zenith Racing", 19, 20, "HARD", 1.2),
  car(5, "Zoe Lambert", "LAM", "Quartz Engineering", 20, 22, "HARD", 1.25),
  car(22, "Mila Novak", "NOV", "Vanta Motorsport", 21, 17, "HARD", 1.3),
  car(7, "Callum Reid", "REI", "Polaris Racing", 22, 21, "HARD", 1.35),
];

// Scenario catalogue shown when no live backend supplies capabilities (replay mode).
export const DEFAULT_SCENARIOS = [
  {
    kind: "fl_overheat",
    label: "Front-left overheating",
    icon: "flame",
    description: "The front-left tyre starts running hot and keeps climbing until it is changed.",
  },
  {
    kind: "slow_puncture",
    label: "Slow puncture",
    icon: "puncture",
    description: "The front-left tyre slowly loses pressure, lap after lap.",
  },
  {
    kind: "engine_overheat",
    label: "Engine overheating",
    icon: "engine",
    description: "Engine coolant temperature creeps above its normal band.",
  },
  {
    kind: "safety_car",
    label: "Safety car",
    icon: "safety_car",
    description: "A safety car neutralises the race for a few laps and bunches the field.",
  },
];

export const DEFAULT_SPEEDS = [20, 10, 5, 2, 1];
