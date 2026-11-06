// One reducer for every data source. Consumes protocol Events ({seq, topic, key, ts, value})
// and status objects, and keeps a single mutable state that all views render from.
// Pure logic: no DOM, importable from Node.

import { GRID, HERO_CAR } from "./grid.js";
import { ANOMALY_KEYS, isNum } from "./format.js";

export const TOPICS = ["car_telemetry", "race_standings", "car_state", "pit_decisions", "race_events", "race_control"];

const TELEMETRY_LOG_MAX = 1200;

function emptyCounts() {
  const c = {};
  for (const t of TOPICS) c[t] = 0;
  return c;
}

export function createState(prev) {
  return {
    epoch: (prev?.epoch ?? 0) + 1,
    raceId: null,
    raceStart: null, // race_start data
    ourCar: prev?.ourCar ?? HERO_CAR,
    totalLaps: prev?.totalLaps ?? 60,
    secondsPerLap: prev?.secondsPerLap ?? null,
    circuit: prev?.circuit ?? null,
    scriptedIncidents: [],
    settings: {}, // latest race_events "settings" data
    lap: 0, // highest lap seen in data (hero's current lap)
    flag: "PRE",
    raceState: "idle", // idle | running | paused | finished (status or replay engine is authoritative)
    cars: new Map(), // car_number -> car record
    orderCache: null,
    standingsLap: 0,
    telemetry: null,
    telemetryAt: 0, // ctx.now when the latest telemetry reading was reduced
    telemetryLog: [],
    fuelMax: null,
    carStates: [], // hero car_state rows, sorted by lap
    carStateByLap: new Map(),
    decisions: [], // hero decisions in arrival order
    decisionByLap: new Map(),
    raceEvents: [], // every race_events record (+ ts, seq)
    controlLog: [],
    scenarios: [], // {kind, label, source, lap, endLap}
    activeScenarios: [],
    boxCalls: [],
    pitStops: [], // every pit_stop event (all cars)
    scLaps: new Set(),
    anomalyLaps: new Map(), // lap -> [signal keys]
    anomalyNotified: new Set(),
    finish: null,
    counts: emptyCounts(),
    firstTs: 0,
    lastTs: 0,
    rev: { standings: 0, telemetry: 0, carState: 0, decisions: 0, events: 0, status: 0 },
    status: prev?.status ?? null,
  };
}

function seedCar(state, info) {
  const n = Number(info.car_number);
  let car = state.cars.get(n);
  if (!car) {
    car = {
      car_number: n,
      driver: info.driver ?? `Car ${n}`,
      driver_code: info.driver_code ?? String(n),
      team: info.team ?? "",
      team_color: info.team_color ?? "#8892a0",
      start_position: info.start_position ?? null,
      start_tire: info.start_tire ?? null,
      row: null,
      positions: [], // index: lap -> position
      gaps: [], // lap -> gap_to_leader_sec
      lapTimes: [], // lap -> last_lap_time_sec
      compounds: [], // lap -> compound
      posDelta: 0,
      posChangeSeq: 0,
      pitLaps: [],
    };
    state.cars.set(n, car);
    state.orderCache = null;
  } else {
    if (info.driver) car.driver = info.driver;
    if (info.driver_code) car.driver_code = info.driver_code;
    if (info.team) car.team = info.team;
    if (info.team_color) car.team_color = info.team_color;
    if (info.start_position != null) car.start_position = info.start_position;
    if (info.start_tire) car.start_tire = info.start_tire;
  }
  return car;
}

function notice(ctx, n) {
  if (ctx && ctx.notices) ctx.notices.push(n);
}

// Cars sorted by their latest position (falls back to start position).
export function getOrder(state) {
  if (state.orderCache) return state.orderCache;
  const arr = [...state.cars.values()];
  arr.sort((a, b) => {
    const pa = a.row?.position ?? a.start_position ?? 99;
    const pb = b.row?.position ?? b.start_position ?? 99;
    if (pa !== pb) return pa - pb;
    return (b.row?.lap ?? 0) - (a.row?.lap ?? 0);
  });
  state.orderCache = arr;
  return arr;
}

export function heroCar(state) {
  return state.cars.get(state.ourCar) || null;
}

export function latestDecision(state) {
  return state.decisions.length ? state.decisions[state.decisions.length - 1] : null;
}

// True while the newest decision is a rules-engine reflex and the LLM's final call for
// that lap has not arrived yet ("Claude deliberating…").
export function isDeliberating(state) {
  const d = latestDecision(state);
  return !!d && d.phase === "reflex" && state.decisionByLap.get(d.lap) === d;
}

export function decisionsForLap(state, lap) {
  return state.decisions.filter((d) => d.lap === lap);
}

export function latestCarState(state) {
  return state.carStates.length ? state.carStates[state.carStates.length - 1] : null;
}

export function heroPitStops(state) {
  return state.pitStops.filter((p) => Number(p.car_number) === state.ourCar);
}

export function anomalySignals(row) {
  const out = [];
  if (!row) return out;
  for (const k of Object.keys(ANOMALY_KEYS)) if (row[k]) out.push(ANOMALY_KEYS[k]);
  return out;
}

// Detector training progress for a car_state row, mirroring the backend detector: tyre
// signals restart learning at every stint (pit_stops + compound), the engine signal never
// does, and safety-car windows are not learned. (training_windows in the record is the max
// across signals, so it can't be used directly.)
export function stintWindow(state, row, signal = "tire_temp_fl_c") {
  if (!row) return 0;
  const perStint = signal !== "engine_temp_c";
  const key = (r) => `${r.pit_stops ?? 0}|${r.tire_compound ?? ""}`;
  const k = key(row);
  let n = 0;
  for (const r of state.carStates) {
    if (r.lap > row.lap) break;
    if (perStint && key(r) !== k) continue;
    if (r.safety_car) continue;
    n++;
  }
  return n;
}

// Safety-car periods as [{start, end}] (end null while still out).
export function scPeriods(state) {
  const laps = [...state.scLaps].sort((a, b) => a - b);
  const out = [];
  for (const l of laps) {
    const last = out[out.length - 1];
    if (last && l === last.end + 1) last.end = l;
    else out.push({ start: l, end: l });
  }
  return out;
}

function applyRaceStart(state, v, ev) {
  const d = v.data || {};
  state.raceId = d.race_id ?? null;
  state.raceStart = d;
  if (isNum(d.total_laps)) state.totalLaps = d.total_laps;
  if (isNum(d.seconds_per_lap)) state.secondsPerLap = d.seconds_per_lap;
  if (d.circuit) state.circuit = d.circuit;
  if (d.our_car != null) state.ourCar = Number(d.our_car);
  state.scriptedIncidents = Array.isArray(d.scripted_incidents) ? d.scripted_incidents : [];
  const grid = Array.isArray(d.grid) && d.grid.length ? d.grid : GRID;
  for (const g of grid) seedCar(state, g);
  state.flag = "PRE";
  state.raceState = "running";
  state.firstTs = ev.ts || 0;
}

function reduceRaceEvent(state, v, ev, ctx) {
  const kind = v.kind;
  const d = v.data || {};
  const lap = isNum(v.lap) ? v.lap : state.lap;
  switch (kind) {
    case "race_start":
      break; // handled by caller (reset)
    case "scenario": {
      const sc = { kind: d.kind ?? "scenario", label: d.label ?? d.kind ?? "Scenario", source: d.source ?? "manual", lap, endLap: null };
      state.scenarios.push(sc);
      state.activeScenarios = state.activeScenarios.filter((a) => a.kind !== sc.kind).concat([{ kind: sc.kind, label: sc.label, since_lap: lap }]);
      notice(ctx, { type: "scenario", scenario: sc, message: v.message });
      break;
    }
    case "scenario_end": {
      for (let i = state.scenarios.length - 1; i >= 0; i--) {
        const sc = state.scenarios[i];
        if (sc.kind === d.kind && sc.endLap == null) {
          sc.endLap = lap;
          break;
        }
      }
      state.activeScenarios = state.activeScenarios.filter((a) => a.kind !== d.kind);
      notice(ctx, { type: "scenario_end", kind: d.kind, label: d.label, message: v.message });
      break;
    }
    case "box_call": {
      const bc = { ...d, lap };
      state.boxCalls.push(bc);
      notice(ctx, { type: "box_call", box: bc, message: v.message });
      break;
    }
    case "pit_stop": {
      const ps = { ...d, lap };
      state.pitStops.push(ps);
      const car = state.cars.get(Number(d.car_number));
      if (car) car.pitLaps.push(lap);
      if (Number(d.car_number) === state.ourCar) notice(ctx, { type: "pit_stop", stop: ps, message: v.message });
      break;
    }
    case "flag": {
      const prevFlag = state.flag;
      state.flag = d.flag || state.flag;
      if (state.flag === "SC") {
        state.scLaps.add(Math.max(1, lap));
        if (prevFlag !== "SC") notice(ctx, { type: "sc", lap, message: v.message });
      } else if (state.flag === "GREEN" && prevFlag === "SC") {
        notice(ctx, { type: "green", lap, message: v.message });
      } else if (state.flag === "CHEQUERED" && prevFlag !== "CHEQUERED") {
        notice(ctx, { type: "chequered", lap, message: v.message });
      }
      break;
    }
    case "paused":
      state.raceState = "paused";
      break;
    case "resumed":
      state.raceState = "running";
      break;
    case "settings": // seconds_per_lap, autopilot, scripted_incident, state
      state.settings = { ...state.settings, ...d };
      if (isNum(d.seconds_per_lap)) state.secondsPerLap = d.seconds_per_lap;
      if (d.state && ["idle", "running", "paused", "finished"].includes(d.state)) state.raceState = d.state;
      break;
    case "speed": // legacy (pre-settings) servers
      if (isNum(d.seconds_per_lap)) state.secondsPerLap = d.seconds_per_lap;
      break;
    case "abandoned":
      notice(ctx, { type: "abandoned", message: v.message });
      break;
    case "finish":
      state.finish = { ...d, lap };
      state.raceState = "finished";
      state.flag = "CHEQUERED";
      notice(ctx, { type: "finish", finish: state.finish, message: v.message });
      break;
    default:
      break;
  }
}

export function reduceEvent(state, ev, ctx = {}) {
  if (!ev || !ev.topic) return state;
  const v = ev.value || {};
  if (ev.topic === "race_events" && v.kind === "race_start") {
    state = createState(state);
    applyRaceStart(state, v, ev);
    notice(ctx, { type: "race_start", data: v.data, message: v.message });
  }
  if (state.counts[ev.topic] == null) state.counts[ev.topic] = 0;
  state.counts[ev.topic]++;
  if (!state.firstTs && ev.ts) state.firstTs = ev.ts;
  if (ev.ts) state.lastTs = ev.ts;

  switch (ev.topic) {
    case "car_telemetry": {
      const n = Number(v.car_number ?? ev.key);
      if (n !== state.ourCar) break;
      state.telemetry = v;
      state.telemetryAt = ctx.now ?? 0;
      state.telemetryLog.push(v);
      if (state.telemetryLog.length > TELEMETRY_LOG_MAX) state.telemetryLog.splice(0, state.telemetryLog.length - TELEMETRY_LOG_MAX);
      if (isNum(v.fuel_remaining_kg) && (state.fuelMax == null || v.fuel_remaining_kg > state.fuelMax)) state.fuelMax = v.fuel_remaining_kg;
      if (isNum(v.lap) && v.lap > state.lap) state.lap = v.lap;
      if (state.flag === "SC" && isNum(v.lap)) state.scLaps.add(v.lap);
      if (state.raceState === "idle") state.raceState = "running";
      state.rev.telemetry++;
      break;
    }
    case "race_standings": {
      const car = seedCar(state, v);
      const prev = car.row;
      const lap = v.lap;
      if (prev && isNum(prev.position) && isNum(v.position) && prev.position !== v.position && (lap ?? 0) >= (prev.lap ?? 0)) {
        car.posDelta = prev.position - v.position;
        if (!ctx.silent) car.posChangeSeq++;
      } else if (prev && prev.lap !== lap) {
        car.posDelta = 0;
      }
      car.row = v;
      if (isNum(lap)) {
        car.positions[lap] = v.position;
        car.gaps[lap] = v.gap_to_leader_sec;
        car.lapTimes[lap] = v.last_lap_time_sec;
        car.compounds[lap] = v.tire_compound;
        if (lap > state.standingsLap) state.standingsLap = lap;
        if (lap > state.lap) state.lap = lap;
        if (state.flag === "SC") state.scLaps.add(lap);
      }
      state.orderCache = null;
      if (state.raceState === "idle") state.raceState = "running";
      state.rev.standings++;
      break;
    }
    case "car_state": {
      const n = Number(v.car_number ?? ev.key);
      if (n !== state.ourCar) break;
      const lap = v.lap;
      if (state.carStateByLap.has(lap)) {
        const idx = state.carStates.findIndex((r) => r.lap === lap);
        if (idx >= 0) state.carStates[idx] = v;
      } else {
        state.carStates.push(v);
        if (state.carStates.length > 1 && state.carStates[state.carStates.length - 2].lap > lap) state.carStates.sort((a, b) => a.lap - b.lap);
      }
      state.carStateByLap.set(lap, v);
      if (v.safety_car === true && isNum(lap)) state.scLaps.add(lap);
      const sigs = anomalySignals(v);
      if (sigs.length) {
        state.anomalyLaps.set(lap, sigs);
        const stint = v.pit_stops ?? heroPitStops(state).length;
        const fresh = sigs.filter((s) => !state.anomalyNotified.has(`${stint}:${s}`));
        for (const s of fresh) state.anomalyNotified.add(`${stint}:${s}`);
        if (fresh.length) notice(ctx, { type: "anomaly", lap, signals: fresh, row: v });
      } else {
        state.anomalyLaps.delete(lap);
      }
      state.rev.carState++;
      break;
    }
    case "pit_decisions": {
      const n = Number(v.car_number ?? ev.key);
      if (n !== state.ourCar) break;
      const prevDecision = state.decisions[state.decisions.length - 1] || null;
      // phase: "reflex" (rules engine, instant, incident laps) then "final"; missing = final
      const d = { ...v, phase: v.phase === "reflex" ? "reflex" : "final", _ts: ev.ts, _seq: ev.seq };
      const firstPitNowThisLap = d.suggestion === "PIT NOW" && !state.decisions.some((x) => x.lap === d.lap && x.suggestion === "PIT NOW");
      // The full "BOX, BOX" moment is for a new call; a PIT NOW that persists lap after
      // lap (autopilot off, or a fault the car hasn't pitted for yet) is only a reminder.
      const newCall = firstPitNowThisLap && state.decisionByLap.get(d.lap - 1)?.suggestion !== "PIT NOW";
      state.decisions.push(d);
      state.decisionByLap.set(v.lap, d); // keep the latest decision per lap
      notice(ctx, { type: "decision", decision: d, previous: prevDecision });
      if (newCall) notice(ctx, { type: "pit_now", decision: d });
      else if (firstPitNowThisLap) notice(ctx, { type: "pit_now_repeat", decision: d });
      state.rev.decisions++;
      break;
    }
    case "race_events": {
      if (v.kind !== "race_start") reduceRaceEvent(state, v, ev, ctx);
      state.raceEvents.push({ ...v, ts: ev.ts, seq: ev.seq });
      state.rev.events++;
      break;
    }
    case "race_control": {
      state.controlLog.push({ ...v, ts: ev.ts, seq: ev.seq });
      state.rev.events++;
      break;
    }
    default:
      break;
  }
  return state;
}

export function reduceStatus(state, status) {
  if (!status) return state;
  state.status = status;
  const r = status.race;
  if (r) {
    if (r.state) state.raceState = r.state;
    if (r.flag) state.flag = r.flag;
    if (r.our_car != null) state.ourCar = Number(r.our_car);
    if (isNum(r.total_laps)) state.totalLaps = r.total_laps;
    if (isNum(r.seconds_per_lap)) state.secondsPerLap = r.seconds_per_lap;
    if (r.circuit) state.circuit = r.circuit;
    if (Array.isArray(r.active_scenarios)) state.activeScenarios = r.active_scenarios;
  }
  state.rev.status++;
  return state;
}

// ----- derived helpers (shared by views and the analyst) -----

export function decisionCounts(state) {
  const c = { "STAY OUT": 0, "PIT SOON": 0, "PIT NOW": 0 };
  for (const d of state.decisionByLap.values()) if (c[d.suggestion] != null) c[d.suggestion]++;
  return c;
}

export function avgLatency(state) {
  const xs = state.decisions.map((d) => d.latency_ms).filter(isNum);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export function eventsOnLap(state, lap) {
  return state.raceEvents.filter((e) => e.lap === lap);
}

// Summary computed from state (used when no finish summary exists yet, e.g. analyst).
export function heroSummary(state) {
  const hero = heroCar(state);
  const pos = hero?.row?.position ?? null;
  const start = hero?.start_position ?? hero?.positions.find((p) => p != null) ?? null;
  return {
    our_position: pos,
    start_position: start,
    positions_gained: isNum(start) && isNum(pos) ? start - pos : null,
    pit_laps: heroPitStops(state).map((p) => p.lap),
    decisions: decisionCounts(state),
    anomaly_laps: [...state.anomalyLaps.keys()].sort((a, b) => a - b),
    avg_decision_latency_ms: avgLatency(state),
  };
}

export class Store {
  constructor({ now } = {}) {
    this.now = now || (() => Date.now());
    this.state = createState(null);
    this.version = 0;
    this.lastSeq = 0;
    this.listeners = new Set();
    this.noticeListeners = new Set();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onNotice(fn) {
    this.noticeListeners.add(fn);
    return () => this.noticeListeners.delete(fn);
  }

  reset() {
    this.state = createState(this.state);
    this.state.raceState = "idle";
    this.lastSeq = 0;
    this.version++;
    this._emit([], { reset: true, silent: true });
  }

  ingest(events, { silent = false } = {}) {
    if (!events || !events.length) return;
    const ctx = { silent, now: this.now(), notices: silent ? null : [] };
    let s = this.state;
    const accepted = [];
    for (const ev of events) {
      const isStart = ev.topic === "race_events" && ev.value?.kind === "race_start";
      if (isNum(ev.seq)) {
        if (!isStart && ev.seq <= this.lastSeq) continue;
        this.lastSeq = ev.seq;
      }
      s = reduceEvent(s, ev, ctx);
      accepted.push(ev);
    }
    this.state = s;
    this.version++;
    if (ctx.notices) for (const n of ctx.notices) for (const l of this.noticeListeners) l(n, s);
    this._emit(accepted, { silent });
  }

  setStatus(status) {
    if (!status) return;
    reduceStatus(this.state, status);
    this.version++;
    this._emit([], { status: true, silent: true });
  }

  _emit(events, info) {
    for (const l of this.listeners) l(this.state, events, info);
  }
}
