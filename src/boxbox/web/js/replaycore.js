// Pure replay helpers: build a playback timeline from a session file, find the event index
// for a playback time, and synthesize a status object from reduced state. No DOM.

import { DEFAULT_SCENARIOS, DEFAULT_SPEEDS } from "./grid.js";
import { latestDecision, avgLatency } from "./store.js";
import { isNum } from "./format.js";

export const SESSION_FORMAT = "boxbox-session/1";

export function validateSession(session) {
  if (!session || typeof session !== "object") throw new Error("Session is not an object");
  if (!Array.isArray(session.events)) throw new Error("Session has no events array");
  if (session.format && !String(session.format).startsWith("boxbox-session/")) throw new Error(`Unknown session format ${session.format}`);
  if (!session.events.length) throw new Error("Session has no events");
  return session;
}

// Wall-clock gaps longer than maxGapMs (pauses during recording) are compressed.
export function buildTimeline(session, { maxGapMs = 4000 } = {}) {
  let events = session.events.filter((e) => e && e.topic);
  let sorted = true;
  for (let i = 1; i < events.length; i++) if ((events[i].ts ?? 0) < (events[i - 1].ts ?? 0)) { sorted = false; break; }
  if (!sorted) events = events.map((e, i) => [e, i]).sort((a, b) => (a[0].ts ?? 0) - (b[0].ts ?? 0) || a[1] - b[1]).map((x) => x[0]);

  const vt = new Float64Array(events.length);
  let t = 0;
  for (let i = 1; i < events.length; i++) {
    let dt = (events[i].ts ?? 0) - (events[i - 1].ts ?? 0);
    if (!Number.isFinite(dt) || dt < 0) dt = 0;
    if (dt > maxGapMs) dt = maxGapMs;
    t += dt;
    vt[i] = t;
  }
  const duration = t;

  const lapStarts = []; // lap -> playback ms of the lap's first telemetry reading
  const lapEnds = []; // lap -> playback ms of the hero's standings row (fallback when no telemetry)
  const decisionTimes = []; // lap -> playback ms of the hero's pit_decisions event
  const markers = [];
  let ourCar = Number(session.meta?.our_car ?? 88);
  let totalLaps = session.meta?.total_laps ?? 60;
  // Only the last race in the file matters for laps/markers (a race_start resets).
  let raceStartIdx = 0;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.topic === "race_events" && e.value?.kind === "race_start") {
      raceStartIdx = i;
      lapStarts.length = 0;
      lapEnds.length = 0;
      decisionTimes.length = 0;
      markers.length = 0;
      if (e.value.data?.our_car != null) ourCar = Number(e.value.data.our_car);
      if (isNum(e.value.data?.total_laps)) totalLaps = e.value.data.total_laps;
    }
    const v = e.value || {};
    if (e.topic === "car_telemetry" && isNum(v.lap) && lapStarts[v.lap] == null) lapStarts[v.lap] = vt[i];
    if (e.topic === "race_standings" && isNum(v.lap) && lapEnds[v.lap + 1] == null && Number(v.car_number) === ourCar) {
      lapEnds[v.lap + 1] = vt[i]; // lap L+1 starts no later than the end of lap L
    }
    if (e.topic === "race_events") {
      const lap = v.lap;
      if (v.kind === "pit_stop" && Number(v.data?.car_number) === ourCar) markers.push({ t: vt[i], kind: "pit", lap, label: `Pit stop L${lap}: ${v.data?.from_compound ?? ""} → ${v.data?.to_compound ?? ""}`, compound: v.data?.to_compound });
      else if (v.kind === "scenario") markers.push({ t: vt[i], kind: v.data?.kind === "safety_car" ? "sc" : "scenario", lap, label: `${v.data?.label ?? "Scenario"} L${lap}` });
      else if (v.kind === "flag" && v.data?.flag === "SC") markers.push({ t: vt[i], kind: "sc", lap, label: `Safety car L${lap}` });
      else if (v.kind === "finish") markers.push({ t: vt[i], kind: "finish", lap, label: "Chequered flag" });
    }
    if (e.topic === "pit_decisions" && Number(v.car_number) === ourCar && isNum(v.lap)) decisionTimes[v.lap] = vt[i];
    if (e.topic === "pit_decisions" && v.suggestion === "PIT NOW" && Number(v.car_number) === ourCar) markers.push({ t: vt[i], kind: "pitnow", lap: v.lap, label: `PIT NOW call L${v.lap}` });
  }
  // de-duplicate SC markers (scenario + flag at the same lap)
  const seen = new Set();
  const uniq = markers.filter((m) => {
    const k = `${m.kind}:${m.lap}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const laps = [];
  const nLaps = Math.min(Math.max(lapStarts.length, lapEnds.length), (totalLaps || 60) + 1);
  for (let l = 1; l < nLaps; l++) {
    const t = lapStarts[l] ?? lapEnds[l];
    if (t != null) laps.push({ lap: l, t });
  }
  const diffs = [];
  for (let i = 1; i < laps.length; i++) diffs.push((laps[i].t - laps[i - 1].t) / (laps[i].lap - laps[i - 1].lap));
  diffs.sort((a, b) => a - b);
  const recordedLapMs = diffs.length ? diffs[Math.floor(diffs.length / 2)] : (session.meta?.seconds_per_lap ?? 5) * 1000;

  return { events, vt, duration, laps, markers: uniq, recordedLapMs, raceStartIdx, ourCar, totalLaps, decisionTimes, meta: session.meta || {} };
}

// Number of events with vt <= t (upper bound).
export function indexAt(timeline, t) {
  const vt = timeline.vt;
  let lo = 0;
  let hi = vt.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (vt[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function timeForLap(timeline, lap) {
  const hit = timeline.laps.find((l) => l.lap === lap);
  if (hit) return hit.t;
  if (lap <= 1) return 0;
  return timeline.duration;
}

// Playback time just after lap N's strategist decision (deep links: ?lap=N), so the
// strategist panel shows that lap's call. Falls back to the start of lap N+1.
// The final lap maps to the end of the replay so the finish (and report) are included.
export function timeAfterDecision(timeline, lap) {
  if (lap >= (timeline.totalLaps || 60)) return timeline.duration;
  const t = timeline.decisionTimes?.[lap];
  if (t != null) return t;
  const next = timeline.laps.find((l) => l.lap === lap + 1);
  if (next) return Math.max(0, next.t - 1);
  return timeForLap(timeline, lap);
}

export function lapAtTime(timeline, t) {
  let lap = 0;
  for (const l of timeline.laps) {
    if (l.t <= t) lap = l.lap;
    else break;
  }
  return lap;
}

// A status object (same shape as GET /api/status) synthesized from reduced state.
export function synthesizeStatus(state, info = {}) {
  const meta = info.meta || {};
  const rec = meta.recorded_with || {};
  const d = latestDecision(state);
  const claude = state.decisions.find((x) => x.agent === "claude" && x.model);
  const anyClaude = state.decisions.some((x) => x.agent === "claude");
  const strategist = rec.strategist || meta.strategist || (anyClaude ? "claude" : d ? d.agent : null);
  const topics = {};
  for (const [k, n] of Object.entries(state.counts)) topics[k] = { count: n, rate: info.rates?.[k] ?? 0, last_ts: state.lastTs };
  return {
    app: "boxbox",
    version: "replay",
    mode: "replay",
    race: {
      race_id: state.raceId ?? meta.race_id ?? null,
      state: info.raceState || state.raceState,
      lap: state.lap,
      total_laps: state.totalLaps,
      // the recording's wall pacing (race_start may carry a headless 0.05 s/lap)
      seconds_per_lap: isNum(info.lapMs) ? Math.round(info.lapMs / 100) / 10 : state.secondsPerLap ?? meta.seconds_per_lap ?? null,
      flag: state.flag,
      autopilot: state.settings?.autopilot ?? meta.autopilot ?? state.boxCalls.some((b) => b.by === "agent"),
      scripted_incident: state.settings?.scripted_incident ?? meta.scripted_incident ?? state.scriptedIncidents.length > 0,
      active_scenarios: state.activeScenarios,
      circuit: state.circuit ?? meta.circuit ?? null,
      our_car: state.ourCar,
    },
    agent: {
      strategist,
      provider: rec.provider || meta.provider || (anyClaude ? "anthropic" : null),
      model: claude?.model ?? rec.model ?? meta.model ?? null,
      engineer_provider: "analyst",
      inflight: 0,
      avg_latency_ms: avgLatency(state),
    },
    pipeline: {
      broker: "replay",
      topics,
      stages: [
        { name: "simulator", status: "ok" },
        { name: "car_state", status: "ok" },
        { name: "pit_strategy_agent", status: "ok" },
      ],
    },
    capabilities: {
      control: false,
      chat: true,
      speeds: DEFAULT_SPEEDS,
      scenarios: DEFAULT_SCENARIOS,
    },
  };
}
