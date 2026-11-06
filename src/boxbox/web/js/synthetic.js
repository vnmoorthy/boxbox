// Synthetic race generator: builds a complete, plausible 60-lap session in the browser that
// follows docs/protocol.md exactly. Used with ?synthetic=1, or when demo/session.json is
// missing. Pure and deterministic (seeded): importable from Node for the selftest.

import { GRID, HERO_CAR } from "./grid.js";

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COMPOUND = {
  SOFT: { offset: -0.55, deg: 0.07, cliffAge: 16, cliff: 0.02, temp: 102 },
  MEDIUM: { offset: 0.0, deg: 0.045, cliffAge: 34, cliff: 0.01, temp: 98 },
  HARD: { offset: 0.4, deg: 0.03, cliffAge: 46, cliff: 0.008, temp: 95 },
};

const MIN_BAND = { tire_temp_fl_c: 3.3, tire_pressure_fl_psi: 0.5, engine_temp_c: 2.9 };
const SIGNAL_KEYS = Object.keys(MIN_BAND);
const ANOMALY_FIELD = {
  tire_temp_fl_c: "anomaly_tire_temp_fl",
  tire_pressure_fl_psi: "anomaly_tire_pressure_fl",
  engine_temp_c: "anomaly_engine_temp",
};

const TELEMETRY_FIELDS = [
  "tire_temp_fl_c", "tire_temp_fr_c", "tire_temp_rl_c", "tire_temp_rr_c",
  "tire_pressure_fl_psi", "tire_pressure_fr_psi", "tire_pressure_rl_psi", "tire_pressure_rr_psi",
  "engine_temp_c", "brake_temp_fl_c", "brake_temp_fr_c", "battery_charge_pct", "fuel_remaining_kg",
];

const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export const SYNTHETIC_SCRIPT = {
  totalLaps: 60,
  overheatLap: 24,
  boxLap: 25,
  scFrom: 38,
  scTo: 40,
  rulesLaps: [33, 47],
  model: "claude-haiku-5-5",
};

export function generateSession(opts = {}) {
  const rand = mulberry32(opts.seed ?? 8824);
  const gauss = () => {
    let u = 0;
    let v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };

  const S = SYNTHETIC_SCRIPT;
  const TOTAL = S.totalLaps;
  const SPL = opts.secondsPerLap ?? 5; // wall seconds per lap of the "recording"
  const LAP_WALL = SPL * 1000;
  const LAP_SIM = 20000;
  const HERO = HERO_CAR;
  const circuit = opts.circuit ?? "silverstone";
  const raceId = opts.raceId ?? 1;
  const wall0 = opts.startTs ?? Date.UTC(2026, 10, 5, 13, 0, 0);
  const sim0 = 1793440000000;
  const MODEL = S.model;

  const raw = [];
  let order = 0;
  const emit = (topic, key, ts, value) => {
    if (topic === "race_events") value = { kind: value.kind, lap: value.lap, race_id: raceId, message: value.message, data: value.data ?? {} };
    raw.push({ topic, key: key == null ? null : String(key), ts: Math.round(ts), value, _o: order++ });
  };
  const lapStartWall = (L) => wall0 + 2500 + (L - 1) * LAP_WALL;
  const lapEndWall = (L) => lapStartWall(L) + LAP_WALL;
  const lapStartSim = (L) => sim0 + (L - 1) * LAP_SIM;

  const gridInfo = GRID.map((c) => ({
    car_number: c.car_number,
    driver: c.driver,
    driver_code: c.driver_code,
    team: c.team,
    team_color: c.team_color,
    start_position: c.start_position,
    start_tire: c.start_tire,
  }));

  emit("race_events", null, wall0, {
    kind: "race_start",
    lap: 0,
    message: `Race ${raceId} is set: ${TOTAL} laps, 22 cars, #${HERO} starts P3.`,
    data: {
      race_id: raceId,
      total_laps: TOTAL,
      seconds_per_lap: SPL,
      circuit,
      our_car: HERO,
      grid: gridInfo,
      scripted_incidents: [{ lap: S.overheatLap, kind: "fl_overheat" }],
    },
  });
  emit("race_events", null, wall0 + 1, {
    kind: "settings",
    lap: 0,
    message: "Settings updated.",
    data: { seconds_per_lap: SPL, autopilot: true, scripted_incident: true, state: "running" },
  });
  emit("race_events", null, wall0 + 2000, { kind: "flag", lap: 1, message: "Lights out. Green flag.", data: { flag: "GREEN" } });

  const cars = GRID.map((c) => ({
    ...c,
    cum: (c.start_position - 1) * 0.28,
    compound: "SOFT",
    age: 0,
    stops: 0,
    lapTime: 0,
    pitThisLap: false,
  }));
  const hero = cars.find((c) => c.car_number === HERO);

  // Detector state for the hero car.
  let train = { tire_temp_fl_c: [], tire_pressure_fl_psi: [], engine_temp_c: [] };
  let trainCount = 0;

  let prevRows = new Map();
  const heroRows = [];
  const heroLapTimes = [];
  const counts = { "STAY OUT": 0, "PIT SOON": 0, "PIT NOW": 0 };
  const latencies = [];
  const anomalyLaps = [];
  let overheat = false;
  let heroFitP = 0; // continuous lap progress when the current hero tyre set was fitted
  let heroTyre = "SOFT";
  let heroStopTime = 0;
  let lastDecisionTs = 0;

  const profile = (f) => clamp(0.5 + 0.3 * Math.sin(2 * Math.PI * f * 4 + 0.6) + 0.22 * Math.sin(2 * Math.PI * f * 7 + 2.1), 0, 1);

  for (let L = 1; L <= TOTAL; L++) {
    const sc = L >= S.scFrom && L <= S.scTo;
    const ls = lapStartWall(L);

    // --- lap-start race events
    if (L === S.overheatLap) {
      overheat = true;
      emit("race_events", null, ls + 40, {
        kind: "scenario",
        lap: L,
        message: "Scripted incident: #88's front-left tyre starts overheating.",
        data: { kind: "fl_overheat", label: "Front-left overheating", source: "scripted" },
      });
    }
    if (L === S.scFrom) {
      emit("race_control", null, ls + 20, { command: "scenario", kind: "safety_car" });
      emit("race_events", null, ls + 40, {
        kind: "scenario",
        lap: L,
        message: "Safety car deployed after debris at Turn 9.",
        data: { kind: "safety_car", label: "Safety car", source: "manual" },
      });
      emit("race_events", null, ls + 60, { kind: "flag", lap: L, message: "Safety car on track.", data: { flag: "SC" } });
    }
    if (L === S.scTo + 1) {
      emit("race_events", null, ls + 30, {
        kind: "scenario_end",
        lap: L,
        message: "Safety car in this lap.",
        data: { kind: "safety_car", label: "Safety car" },
      });
      emit("race_events", null, ls + 40, { kind: "flag", lap: L, message: "Green flag. Racing resumes.", data: { flag: "GREEN" } });
    }

    // --- lap times for every car
    for (const c of cars) {
      const spec = COMPOUND[c.compound];
      let t =
        90.2 + c.pace_delta + spec.offset + spec.deg * c.age +
        (c.age > spec.cliffAge ? spec.cliff * (c.age - spec.cliffAge) ** 2 : 0) -
        0.035 * L + gauss() * 0.14;
      if (L === 1) t += 2.2 + (c.start_position - 1) * 0.06;
      if (c.car_number === HERO && overheat) t += 0.9;
      c.pitThisLap = false;
      const pitLap = c.car_number === HERO ? S.boxLap : c.pit_lap;
      if (L === pitLap) {
        t += 21.4 + gauss() * 0.4;
        c.pitThisLap = true;
        c.fromCompound = c.compound;
        c.compound = c.car_number === HERO ? "MEDIUM" : c.pit_tire;
        c.age = 0;
        c.stops++;
        c.stopTime = r1(19.6 + rand() * 1.4);
      } else {
        c.age++;
      }
      c.lapTime = t;
    }
    if (sc) {
      const sorted = [...cars].sort((a, b) => a.cum - b.cum);
      const leaderCum = sorted[0].cum;
      sorted.forEach((c, i) => {
        const gap = c.cum - leaderCum;
        const target = i * 0.9;
        const newGap = gap > target ? target + (gap - target) * 0.3 : gap;
        c.lapTime = 118 + (newGap - gap) + Math.abs(gauss()) * 0.05;
      });
    }
    for (const c of cars) c.cum += c.lapTime;
    const sorted = [...cars].sort((a, b) => a.cum - b.cum);
    const leaderCum = sorted[0].cum;
    sorted.forEach((c, i) => {
      c.position = i + 1;
      c.gapLeader = c.cum - leaderCum;
      c.gapAhead = i === 0 ? 0 : c.cum - sorted[i - 1].cum;
    });

    // --- hero telemetry (10 readings per lap)
    const heroPrev = prevRows.get(HERO);
    const gapAheadPrev = heroPrev ? heroPrev.gap_to_ahead_sec : 2;
    const readings = [];
    for (let k = 0; k < 10; k++) {
      const f = (k + 0.5) / 10;
      const p = L - 1 + f;
      const pitting = L === S.boxLap && f >= 0.85;
      if (L === S.boxLap && f >= 0.85 && heroTyre !== "MEDIUM") {
        heroTyre = "MEDIUM";
        heroFitP = p;
        overheat = false;
      }
      const since = p - heroFitP;
      const spec = COMPOUND[heroTyre];
      const nominal = spec.temp + 0.12 * since;
      const warm = since < 0.6 ? 1 - since / 0.6 : 0;
      const cold = L === 1 ? 10 * warm : 16 * warm;
      const wave = 1.5 * Math.sin(2 * Math.PI * (f * 3 + 0.2));
      const scCool = sc ? -2.0 : 0;
      const heat = overheat ? 46 * Math.min(1, (p - (S.overheatLap - 1)) / 0.3) : 0;
      const fl = nominal - cold + wave + scCool + heat + gauss() * 0.5;
      const fr = nominal - 1.2 - cold + wave * 0.8 + scCool + gauss() * 0.5;
      const rl = nominal - 3.5 - cold * 0.8 + wave * 0.5 + scCool + gauss() * 0.4;
      const rr = nominal - 4.2 - cold * 0.8 + wave * 0.5 + scCool + gauss() * 0.4;
      const pf = (temp) => 20.8 + 0.006 * (temp - 102);
      const pr = (temp) => 19.9 + 0.006 * (temp - 98);
      const prof = profile(f);
      const dprof = profile(f + 0.01) - prof;
      let speed = 95 + 235 * prof + gauss() * 3;
      if (sc) speed = speed * 0.55 + 22;
      if (pitting) speed = 79.8 + gauss() * 0.2;
      let throttle = clamp(25 + 120 * (prof - 0.2), 0, 100);
      let brake = 0;
      if (dprof < -0.004 && prof < 0.55) {
        brake = clamp(-dprof * 1600, 0, 100);
        throttle = clamp(throttle * 0.15, 0, 100);
      }
      if (sc) {
        throttle = clamp(throttle * 0.6, 0, 70);
        brake = brake * 0.4;
      }
      if (pitting) {
        throttle = 18;
        brake = 0;
      }
      const inDrsZone = (f >= 0.0 && f <= 0.1) || (f >= 0.52 && f <= 0.6);
      const drs = !sc && !pitting && L > 2 && inDrsZone && gapAheadPrev > 0 && gapAheadPrev < 1.0;
      if (drs) speed += 12;
      const brakeBase = sc ? 280 : 380;
      const engine = 119.6 + 0.25 * Math.sin(2 * Math.PI * f * 2) + gauss() * 0.3 + (drs ? 0.4 : 0) - (sc ? 0.9 : 0) - (pitting ? 1 : 0);
      const reading = {
        car_number: HERO,
        lap: L,
        lap_fraction: r2(f),
        event_time: Math.round(lapStartSim(L) + f * LAP_SIM),
        tire_temp_fl_c: r1(fl),
        tire_temp_fr_c: r1(fr),
        tire_temp_rl_c: r1(rl),
        tire_temp_rr_c: r1(rr),
        tire_pressure_fl_psi: r1(pf(fl) + gauss() * 0.03),
        tire_pressure_fr_psi: r1(pf(fr) + gauss() * 0.03),
        tire_pressure_rl_psi: r1(pr(rl) + gauss() * 0.03),
        tire_pressure_rr_psi: r1(pr(rr) + gauss() * 0.03),
        engine_temp_c: r1(engine),
        brake_temp_fl_c: r1(brakeBase + 160 * (brake / 100) + 60 * (1 - prof) + gauss() * 12),
        brake_temp_fr_c: r1(brakeBase + 12 + 160 * (brake / 100) + 60 * (1 - prof) + gauss() * 12),
        battery_charge_pct: r1(clamp(72 + 9 * Math.sin(2 * Math.PI * (2 * f + L * 0.13)) + gauss() * 1.5 - (drs ? 4 : 0), 15, 100)),
        fuel_remaining_kg: r1(Math.max(0.5, 44 - 0.7 * p)),
        drs_active: drs,
        speed_kph: r1(clamp(speed, 60, 345)),
        throttle_pct: r1(throttle),
        brake_pct: r1(brake),
      };
      readings.push(reading);
      emit("car_telemetry", HERO, ls + f * LAP_WALL, reading);
    }

    // --- standings (22 rows at lap end)
    const rows = new Map();
    for (const c of sorted) {
      const row = {
        car_number: c.car_number,
        driver: c.driver,
        driver_code: c.driver_code,
        team: c.team,
        team_color: c.team_color,
        lap: L,
        position: c.position,
        gap_to_leader_sec: r1(c.gapLeader),
        gap_to_ahead_sec: r1(c.gapAhead),
        last_lap_time_sec: r2(c.lapTime),
        pit_stops: c.stops,
        tire_compound: c.compound,
        tire_age_laps: c.age,
        in_pit_lane: c.pitThisLap,
        event_time: lapStartSim(L) + LAP_SIM,
      };
      rows.set(c.car_number, row);
      emit("race_standings", c.car_number, lapEndWall(L) - 40, row);
    }

    // --- pit stop events (during the lap)
    for (const c of cars) {
      if (!c.pitThisLap) continue;
      const isHero = c.car_number === HERO;
      if (isHero) heroStopTime = c.stopTime;
      emit("race_events", null, ls + (isHero ? 0.88 : 0.7 + (c.car_number % 7) * 0.02) * LAP_WALL, {
        kind: "pit_stop",
        lap: L,
        message: `${c.driver} pits: ${c.fromCompound} → ${c.compound}.`,
        data: {
          car_number: c.car_number,
          driver: c.driver,
          driver_code: c.driver_code,
          from_compound: c.fromCompound,
          to_compound: c.compound,
          reason: isHero ? "agent" : "strategy",
          stop_time_sec: c.stopTime,
        },
      });
      if (isHero) {
        emit("race_events", null, ls + 0.885 * LAP_WALL, {
          kind: "scenario_end",
          lap: L,
          message: "Front-left overheating cleared: new tyres fitted.",
          data: { kind: "fl_overheat", label: "Front-left overheating" },
        });
      }
    }

    // --- car_state window for the hero
    const avg = {};
    for (const k of TELEMETRY_FIELDS) avg[k] = readings.reduce((a, r) => a + r[k], 0) / readings.length;
    const heroRow = rows.get(HERO);
    const isPitLap = L === S.boxLap;
    const bounds = {};
    const anomalies = {};
    if (isPitLap) {
      train = { tire_temp_fl_c: [], tire_pressure_fl_psi: [], engine_temp_c: [] };
      trainCount = 0;
      for (const s of SIGNAL_KEYS) {
        bounds[s] = null;
        anomalies[s] = false;
      }
    } else {
      for (const s of SIGNAL_KEYS) {
        const val = avg[s];
        if (trainCount >= 6) {
          const recent = train[s].slice(-8);
          const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
          const sd = Math.sqrt(recent.reduce((a, b) => a + (b - mean) ** 2, 0) / recent.length);
          const band = Math.max(MIN_BAND[s], 3 * sd);
          const dec = s === "tire_pressure_fl_psi" ? r2 : r1;
          bounds[s] = { expected: dec(mean), lower: dec(mean - band), upper: dec(mean + band) };
          anomalies[s] = val < mean - band || val > mean + band;
        } else {
          bounds[s] = null;
          anomalies[s] = false;
        }
      }
    }
    const trainingWindows = trainCount;
    if (!isPitLap) {
      const any = SIGNAL_KEYS.some((s) => anomalies[s]);
      for (const s of SIGNAL_KEYS) if (!anomalies[s]) train[s].push(avg[s]);
      if (!any) trainCount++;
    }
    const carState = {
      car_number: HERO,
      lap: L,
      window_start: lapStartSim(L),
      window_end: lapStartSim(L) + LAP_SIM,
      tire_temp_fl_c: r1(avg.tire_temp_fl_c),
      tire_temp_fr_c: r1(avg.tire_temp_fr_c),
      tire_temp_rl_c: r1(avg.tire_temp_rl_c),
      tire_temp_rr_c: r1(avg.tire_temp_rr_c),
      tire_pressure_fl_psi: r2(avg.tire_pressure_fl_psi),
      tire_pressure_fr_psi: r2(avg.tire_pressure_fr_psi),
      tire_pressure_rl_psi: r2(avg.tire_pressure_rl_psi),
      tire_pressure_rr_psi: r2(avg.tire_pressure_rr_psi),
      engine_temp_c: r1(avg.engine_temp_c),
      brake_temp_fl_c: r1(avg.brake_temp_fl_c),
      brake_temp_fr_c: r1(avg.brake_temp_fr_c),
      battery_charge_pct: r1(avg.battery_charge_pct),
      fuel_remaining_kg: r1(avg.fuel_remaining_kg),
      position: heroRow.position,
      gap_to_ahead_sec: heroRow.gap_to_ahead_sec,
      gap_to_leader_sec: heroRow.gap_to_leader_sec,
      pit_stops: heroRow.pit_stops,
      tire_compound: heroRow.tire_compound,
      tire_age_laps: heroRow.tire_age_laps,
      anomaly_tire_temp_fl: anomalies.tire_temp_fl_c,
      anomaly_tire_pressure_fl: anomalies.tire_pressure_fl_psi,
      anomaly_engine_temp: anomalies.engine_temp_c,
      bounds,
      training_windows: trainingWindows,
      safety_car: sc,
      readings: readings.length,
    };
    if (anomalies.tire_temp_fl_c || anomalies.tire_pressure_fl_psi || anomalies.engine_temp_c) anomalyLaps.push(L);
    emit("car_state", HERO, lapEndWall(L) + 20, carState);
    heroRows.push(heroRow);
    heroLapTimes[L] = heroRow.last_lap_time_sec;

    // --- strategist decision for this window
    const isRules = S.rulesLaps.includes(L);
    const latency = isRules ? Math.round(4 + rand() * 10) : L === S.overheatLap ? 1840 : Math.round(1150 + rand() * 1100);
    const decision = buildDecision({
      L, TOTAL, carState, heroRow, rows, sorted, sc, isRules, latency, MODEL,
      heroLapTimes, heroStopTime, scFrom: S.scFrom, scTo: S.scTo, boxLap: S.boxLap, overheatLap: S.overheatLap,
      windowEnd: carState.window_end,
    });
    counts[decision.suggestion]++;
    latencies.push(latency);
    const decisionTs = lapEndWall(L) + latency;
    lastDecisionTs = Math.max(lastDecisionTs, decisionTs);
    // incident laps (anomaly or safety car) with an LLM brain: the rules engine publishes an
    // instant "reflex" decision first, then Claude's "final" one follows
    const incident = !isRules && (carState.anomaly_tire_temp_fl || carState.anomaly_tire_pressure_fl || carState.anomaly_engine_temp || sc);
    let boxTs = decisionTs + 15;
    if (incident) {
      const reflexLatency = Math.round(2 + rand() * 4);
      const reflex = {
        ...decision,
        reasoning: `Rules engine reflex: ${decision.suggestion === "PIT NOW" ? "anomaly flagged on the front-left, box immediately" : sc ? "safety car, no anomaly: hold position" : "no action"}. Claude's full call follows.`,
        raw_response: `rules: ${decision.suggestion}`,
        agent: "rules",
        model: null,
        phase: "reflex",
        latency_ms: reflexLatency,
        decided_at: carState.window_end + reflexLatency,
      };
      emit("pit_decisions", HERO, lapEndWall(L) + 25 + reflexLatency, reflex);
      boxTs = lapEndWall(L) + 40 + reflexLatency;
    }
    emit("pit_decisions", HERO, decisionTs, { ...decision, phase: "final" });
    if (decision.suggestion === "PIT NOW") {
      emit("race_events", null, boxTs, {
        kind: "box_call",
        lap: L + 1,
        message: `Box, box: #${HERO} pits this lap for ${decision.recommended_tire_compound} (strategist call, autopilot).`,
        data: { car_number: HERO, compound: decision.recommended_tire_compound, by: "agent", decision_lap: L },
      });
    }
    prevRows = rows;
  }

  // --- chequered flag + finish
  const finalOrder = [...cars].sort((a, b) => a.position - b.position);
  const leader = finalOrder[0];
  emit("race_events", null, lapEndWall(TOTAL) + 10, { kind: "flag", lap: TOTAL, message: "Chequered flag.", data: { flag: "CHEQUERED" } });
  const heroStart = GRID.find((c) => c.car_number === HERO).start_position;
  const summary = {
    our_position: hero.position,
    start_position: heroStart,
    positions_gained: heroStart - hero.position,
    pit_laps: [S.boxLap],
    decisions: counts,
    anomaly_laps: anomalyLaps,
    avg_decision_latency_ms: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
  };
  emit("race_events", null, lastDecisionTs + 250, {
    kind: "finish",
    lap: TOTAL,
    message: `${leader.driver} wins. ${hero.driver} (#${HERO}) finishes P${hero.position}.`,
    data: {
      results: finalOrder.map((c) => ({
        position: c.position,
        car_number: c.car_number,
        driver: c.driver,
        driver_code: c.driver_code,
        team: c.team,
        team_color: c.team_color,
        gap_to_leader_sec: r1(c.gapLeader),
        pit_stops: c.stops,
      })),
      summary,
    },
  });

  raw.sort((a, b) => a.ts - b.ts || a._o - b._o);
  const events = raw.map((e, i) => ({ seq: i + 1, topic: e.topic, key: e.key, ts: e.ts, value: e.value }));
  return {
    format: "boxbox-session/1",
    meta: {
      race_id: raceId,
      circuit,
      total_laps: TOTAL,
      seconds_per_lap: SPL,
      our_car: HERO,
      generator: "synthetic",
      recorded_at: new Date(wall0).toISOString(),
      strategist: "claude",
      provider: "anthropic",
      model: MODEL,
      broker: "in-memory",
      autopilot: true,
      scripted_incident: true,
    },
    events,
  };
}

function buildDecision(c) {
  const { L, TOTAL, carState: cs, heroRow, sorted, sc, isRules, latency, MODEL } = c;
  const R = TOTAL - L;
  const pos = heroRow.position;
  const gapL = heroRow.gap_to_leader_sec;
  const gapA = heroRow.gap_to_ahead_sec;
  const ahead = pos > 1 ? sorted[pos - 2] : null;
  const fl = cs.tire_temp_fl_c;
  const fr = cs.tire_temp_fr_c;
  const b = cs.bounds.tire_temp_fl_c;
  const age = heroRow.tire_age_laps;
  const comp = heroRow.tire_compound;
  const lt = heroRow.last_lap_time_sec;
  const lapTimes = c.heroLapTimes;
  const recent = [L, L - 1, L - 2].map((l) => lapTimes[l]).filter((x) => x != null && x < 110);
  const older = [L - 5, L - 6, L - 7].map((l) => lapTimes[l]).filter((x) => x != null && x < 110);
  const deg = recent.length && older.length ? recent.reduce((a, x) => a + x, 0) / recent.length - older.reduce((a, x) => a + x, 0) / older.length : 0;
  const rivalsPitted = sorted.filter((x) => x.car_number !== HERO_CAR && x.stops > 0).length;

  const context = pos === 1
    ? `Leading the race on ${comp}s with ${R} laps remaining.`
    : `P${pos}, ${gapL.toFixed(1)}s off the lead (${gapA.toFixed(1)}s behind ${ahead ? ahead.driver_code : "the car ahead"}) with ${R} laps remaining.`;
  const training = !b;
  const nominalCond = training
    ? `Detector training (${Math.min(cs.training_windows, 6)}/6 windows). Tyre temps look normal: FL ${fl.toFixed(0)}°C, FR ${fr.toFixed(0)}°C.`
    : `All monitored signals inside their bands. FL ${fl.toFixed(1)}°C (expected ${b.expected.toFixed(1)}, band ${b.lower.toFixed(1)}–${b.upper.toFixed(1)}).`;

  let suggestion = "STAY OUT";
  let condition = nominalCond;
  let reasoning;
  let rec = { compound: null, stint: null, reason: null };

  if (L === c.overheatLap) {
    suggestion = "PIT NOW";
    const over = b ? fl - b.upper : 0;
    condition = `Front-left tyre anomaly at ${fl.toFixed(0)}C, ${over.toFixed(0)}C above its expected upper bound.`;
    rec = { compound: "MEDIUM", stint: R, reason: "Mediums reach the flag in one stint." };
    reasoning =
      `The detector flagged the front-left at **${fl.toFixed(1)}°C** against an expected ${b ? b.expected.toFixed(1) : "—"}°C ` +
      `(upper bound ${b ? b.upper.toFixed(1) : "—"}°C). A tyre that far outside its band risks a failure, and the softs are already ${age} laps old.\n\n` +
      `Pitting costs about 21 s, but ${R} laps on fresh mediums recovers most of it and removes the risk. ${rivalsPitted} rivals have already stopped. **Box this lap.**`;
  } else if (L >= 19 && L < c.overheatLap) {
    suggestion = "PIT SOON";
    condition = `Soft tyres at ${age} laps; lap time up ${Math.max(0, deg).toFixed(2)}s over the last 5 laps. FL ${fl.toFixed(1)}°C, still inside its band.`;
    rec = { compound: "MEDIUM", stint: R, reason: `Mediums can run the remaining ${R} laps in one stint.` };
    reasoning =
      `${rivalsPitted} of 21 rivals have already stopped and are on fresher tyres. Our softs are past their best ` +
      `(${Math.max(0, deg).toFixed(2)}s slower than five laps ago, last lap ${lt.toFixed(2)}s). ` +
      `The pit window is open: plan to box within the next ${Math.max(1, c.overheatLap - L + 1)} laps, or immediately if the detector flags anything.`;
  } else if (L === c.boxLap) {
    condition = `Fresh MEDIUM tyres fitted (${c.heroStopTime.toFixed(1)} s in the pit lane). Detector retraining for the new stint.`;
    reasoning = "The stop is done and the front-left problem left with the old set. The new mediums need a lap to come up to temperature; nothing to do but push.";
  } else if (sc) {
    condition = `Safety car: field bunched up. All signals nominal; FL ${fl.toFixed(1)}°C.`;
    reasoning = L > c.boxLap
      ? `We already stopped on lap ${c.boxLap} and these ${comp}s (${age} laps) reach the flag, so a safety-car stop gains nothing. Stay out and keep track position for the restart.`
      : "A safety-car stop would be cheap, but the tyres are healthy. Stay out and keep track position.";
  } else if (L > c.boxLap) {
    reasoning = L >= 50
      ? `${comp}s are ${age} laps old with ${R} to go; they reach the flag comfortably (last lap ${lt.toFixed(2)}s). No anomalies. Stay out and bring it home.`
      : `${comp}s are ${age} laps old and holding pace (last lap ${lt.toFixed(2)}s). No anomalies and no reason to stop again; one-stop strategy on track.`;
  } else {
    reasoning =
      `Softs are ${age} laps old and still in their window: last lap ${lt.toFixed(2)}s` +
      (Math.abs(deg) > 0.01 ? `, ${deg >= 0 ? "+" : ""}${deg.toFixed(2)}s versus five laps ago` : "") +
      `. No anomalies, so there is no reason to give up track position. The pit window opens around lap 19.`;
  }

  if (isRules) {
    reasoning = `Rules engine: no anomaly flagged, ${comp} age ${age} laps under the ${comp === "MEDIUM" ? 38 : 30}-lap limit, no safety car. Decision: ${suggestion}. (Claude timed out after 4.0 s; the rules fallback answered.)`;
  }

  const raw = [
    `Suggestion: ${suggestion}`,
    `Condition: ${condition}`,
    `Context: ${context}`,
    `Compound: ${rec.compound ?? "n/a"}`,
    `Stint laps: ${rec.stint ?? "n/a"}`,
    `Reason: ${rec.reason ?? "n/a"}`,
    `Reasoning: ${reasoning.replace(/\*\*/g, "")}`,
  ].join("\n");

  return {
    car_number: HERO_CAR,
    lap: L,
    position: pos,
    tire_compound_current: comp,
    tire_age_laps: age,
    anomaly_tire_temp_fl: cs.anomaly_tire_temp_fl,
    anomaly_tire_pressure_fl: cs.anomaly_tire_pressure_fl,
    anomaly_engine_temp: cs.anomaly_engine_temp,
    suggestion,
    condition_summary: condition,
    race_context: context,
    recommended_tire_compound: rec.compound,
    recommended_stint_laps: rec.stint,
    recommended_reason: rec.reason,
    reasoning,
    raw_response: isRules ? `rules: ${suggestion}` : raw,
    agent: isRules ? "rules" : "claude",
    model: isRules ? null : MODEL,
    latency_ms: latency,
    window_end: c.windowEnd,
    decided_at: c.windowEnd + latency,
  };
}
