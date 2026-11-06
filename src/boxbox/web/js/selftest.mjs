// Node selftest for the DOM-free modules: reducer, synthetic generator, analyst, replay core.
// Run: node src/boxbox/web/js/selftest.mjs

import { Store, TOPICS, getOrder, heroCar, decisionCounts, scPeriods, latestCarState } from "./store.js";
import { generateSession, SYNTHETIC_SCRIPT } from "./synthetic.js";
import { analystAnswer } from "./analyst.js";
import { buildTimeline, indexAt, timeForLap, timeAfterDecision, synthesizeStatus, validateSession } from "./replaycore.js";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stintWindow, isDeliberating } from "./store.js";
import { richTextToHtml, parseRichText, speedLabel, fmtGap, brainLabel, strategistLabel, escapeHtml } from "./format.js";

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL ${name}${detail !== undefined ? ` :: ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  }
}

// ---------- synthetic session follows the protocol ----------
const session = generateSession();
check("session format", session.format === "boxbox-session/1");
validateSession(session);
const evs = session.events;
check("event volume ~2k+", evs.length > 1800 && evs.length < 3500, evs.length);
let seqOk = true;
let tsOk = true;
for (let i = 0; i < evs.length; i++) {
  const e = evs[i];
  if (!TOPICS.includes(e.topic)) check("known topic", false, e.topic);
  if (i && e.seq <= evs[i - 1].seq) seqOk = false;
  if (i && e.ts < evs[i - 1].ts) tsOk = false;
  if (typeof e.ts !== "number" || !e.value) check("event shape", false, e);
}
check("seq strictly increasing", seqOk);
check("ts non-decreasing", tsOk);

const tel = evs.filter((e) => e.topic === "car_telemetry");
check("10 telemetry readings per lap", tel.length === 600, tel.length);
check("telemetry has lap_fraction", tel.every((e) => e.value.lap_fraction >= 0 && e.value.lap_fraction < 1));
const telKeys = ["car_number", "lap", "lap_fraction", "event_time", "tire_temp_fl_c", "tire_temp_fr_c", "tire_temp_rl_c", "tire_temp_rr_c",
  "tire_pressure_fl_psi", "tire_pressure_fr_psi", "tire_pressure_rl_psi", "tire_pressure_rr_psi", "engine_temp_c", "brake_temp_fl_c",
  "brake_temp_fr_c", "battery_charge_pct", "fuel_remaining_kg", "drs_active", "speed_kph", "throttle_pct", "brake_pct"];
check("telemetry fields", telKeys.every((k) => k in tel[0].value), Object.keys(tel[0].value));
const st = evs.filter((e) => e.topic === "race_standings");
check("22 standings per lap", st.length === 22 * 60, st.length);
const stKeys = ["car_number", "driver", "driver_code", "team", "team_color", "lap", "position", "gap_to_leader_sec", "gap_to_ahead_sec",
  "last_lap_time_sec", "pit_stops", "tire_compound", "tire_age_laps", "in_pit_lane", "event_time"];
check("standings fields", stKeys.every((k) => k in st[0].value));
const cs = evs.filter((e) => e.topic === "car_state").map((e) => e.value);
check("60 car_state windows", cs.length === 60);
check("bounds null while training (laps 1-6)", cs.slice(0, 6).every((r) => r.bounds.tire_temp_fl_c === null));
check("bounds present from lap 7", cs[6].bounds.tire_temp_fl_c && cs[6].training_windows === 6);
check("car_state window = 20s sim", cs.every((r) => r.window_end - r.window_start === 20000));
const decs = evs.filter((e) => e.topic === "pit_decisions").map((e) => e.value);
check("decision fields", ["suggestion", "condition_summary", "race_context", "recommended_tire_compound", "recommended_stint_laps",
  "recommended_reason", "reasoning", "raw_response", "agent", "model", "latency_ms", "window_end", "decided_at"].every((k) => k in decs[0]));
check("STAY OUT has null recommendations", decs.filter((d) => d.suggestion === "STAY OUT").every((d) => d.recommended_tire_compound === null && d.recommended_stint_laps === null));
const kinds = new Set(evs.filter((e) => e.topic === "race_events").map((e) => e.value.kind));
for (const k of ["race_start", "settings", "scenario", "scenario_end", "box_call", "pit_stop", "flag", "finish"]) check(`race_events has ${k}`, kinds.has(k));
check("race_events carry race_id", evs.filter((e) => e.topic === "race_events").every((e) => e.value.race_id === 1));
check("pit_stop has driver_code", evs.filter((e) => e.value.kind === "pit_stop").every((e) => e.value.data.driver_code));
check("car_state has safety_car + readings", cs.every((r) => typeof r.safety_car === "boolean" && r.readings === 10));
const rivalStops = evs.filter((e) => e.value.kind === "pit_stop" && e.value.data.car_number !== 88).map((e) => e.value.lap);
check("rivals pit laps 10-22", rivalStops.length === 21 && Math.min(...rivalStops) >= 10 && Math.max(...rivalStops) <= 22, rivalStops);

// ---------- reduce the full race ----------
const store = new Store({ now: () => 0 });
const notices = [];
store.onNotice((n) => notices.push(n.type));
const t0 = performance.now();
store.ingest(evs);
const reduceMs = performance.now() - t0;
const s = store.state;
check("reduce is fast (<250ms)", reduceMs < 250, reduceMs);
check("60 laps of decisions", s.decisionByLap.size === 60 && [...Array(60)].every((_, i) => s.decisionByLap.has(i + 1)));
for (let l = 1; l <= 18; l++) check(`lap ${l} STAY OUT`, s.decisionByLap.get(l).suggestion === "STAY OUT");
for (let l = 19; l <= 23; l++) check(`lap ${l} PIT SOON`, s.decisionByLap.get(l).suggestion === "PIT SOON");
check("PIT NOW at lap 24", s.decisionByLap.get(24).suggestion === "PIT NOW");
for (let l = 25; l <= 60; l++) check(`lap ${l} STAY OUT`, s.decisionByLap.get(l).suggestion === "STAY OUT");
const heroStops = s.pitStops.filter((p) => Number(p.car_number) === 88);
check("hero pit stop recorded", heroStops.length === 1 && heroStops[0].lap === 25 && heroStops[0].to_compound === "MEDIUM", heroStops);
check("box call recorded", s.boxCalls.length === 1 && s.boxCalls[0].decision_lap === 24 && s.boxCalls[0].by === "agent");
check("all pit stops", s.pitStops.length === 22);
check("finish summary present", s.finish && s.finish.summary && s.finish.summary.decisions && s.finish.results.length === 22);
const sum = s.finish.summary;
check("summary decisions add to 60", sum.decisions["STAY OUT"] + sum.decisions["PIT SOON"] + sum.decisions["PIT NOW"] === 60);
check("summary pit laps", JSON.stringify(sum.pit_laps) === "[25]");
check("summary anomaly laps", JSON.stringify(sum.anomaly_laps) === "[24]", sum.anomaly_laps);
check("reducer decision counts", JSON.stringify(decisionCounts(s)) === JSON.stringify(sum.decisions));
check("anomaly only at lap 24", [...s.anomalyLaps.keys()].join(",") === "24");
check("state finished", s.raceState === "finished" && s.flag === "CHEQUERED");
check("lap 60", s.lap === 60);
check("22 cars", s.cars.size === 22);
const order = getOrder(s);
check("order positions 1..22", order.every((c, i) => c.row.position === i + 1));
check("hero tracked", heroCar(s).row.car_number === 88 && heroCar(s).positions.filter(Boolean).length === 60);
check("SC laps 38-40", JSON.stringify(scPeriods(s)) === JSON.stringify([{ start: 38, end: 40 }]), scPeriods(s));
check("scenarios recorded", s.scenarios.length === 2 && s.scenarios[0].kind === "fl_overheat" && s.scenarios[0].endLap === 25);
check("telemetry latest is lap 60", s.telemetry.lap === 60);
check("car_state latest", latestCarState(s).lap === 60);
for (const n of ["race_start", "pit_now", "box_call", "pit_stop", "anomaly", "scenario", "sc", "green", "chequered", "finish"]) check(`notice ${n}`, notices.includes(n), n);
check("one anomaly notice per stint", notices.filter((n) => n === "anomaly").length === 1);
// decision phases: reflex then final on incident laps; latest per lap kept; one PIT NOW notice
check("reflex + final on lap 24", decs.filter((d) => d.lap === 24).map((d) => d.phase).join(",") === "reflex,final", decs.filter((d) => d.lap === 24).map((d) => d.phase));
check("reflex on SC laps", [38, 39, 40].every((l) => decs.some((d) => d.lap === l && d.phase === "reflex")));
check("latest per lap is final", s.decisionByLap.get(24).phase === "final" && s.decisionByLap.get(24).agent === "claude");
check("PIT NOW notice once per lap", notices.filter((n) => n === "pit_now").length === 1);
check("box call follows the reflex", (() => {
  const reflexTs = evs.find((e) => e.topic === "pit_decisions" && e.value.lap === 24 && e.value.phase === "reflex").ts;
  const finalTs = evs.find((e) => e.topic === "pit_decisions" && e.value.lap === 24 && e.value.phase === "final").ts;
  const boxTs = evs.find((e) => e.value.kind === "box_call").ts;
  return reflexTs < boxTs && boxTs < finalTs;
})());
const delib = new Store();
const reflexIdx = evs.findIndex((e) => e.topic === "pit_decisions" && e.value.phase === "reflex");
delib.ingest(evs.slice(0, reflexIdx + 1), { silent: true });
check("deliberating after reflex", isDeliberating(delib.state));
const finalIdx = evs.findIndex((e, i) => i > reflexIdx && e.topic === "pit_decisions" && e.value.lap === evs[reflexIdx].value.lap);
delib.ingest(evs.slice(reflexIdx + 1, finalIdx + 1), { silent: true });
check("not deliberating after final", !isDeliberating(delib.state));
const legacy = new Store();
legacy.ingest([{ seq: 1, topic: "pit_decisions", key: "88", ts: 1, value: { car_number: 88, lap: 3, suggestion: "STAY OUT" } }]);
check("missing phase = final", legacy.state.decisions[0].phase === "final" && !isDeliberating(legacy.state));

// silent ingest produces no notices
const silentStore = new Store();
let silentNotices = 0;
silentStore.onNotice(() => silentNotices++);
silentStore.ingest(evs, { silent: true });
check("silent ingest has no notices", silentNotices === 0);
check("silent ingest same decisions", silentStore.state.decisionByLap.size === 60);

// duplicate seq is ignored
const dupStore = new Store();
dupStore.ingest(evs.slice(0, 500));
dupStore.ingest(evs.slice(400, 800));
check("dedupe by seq", dupStore.state.counts.car_telemetry === evs.slice(0, 800).filter((e) => e.topic === "car_telemetry").length);

// a second race_start resets
const resetStore = new Store();
resetStore.ingest(evs);
const second = generateSession({ raceId: 2, startTs: evs[evs.length - 1].ts + 10000 });
const secondEvents = second.events.map((e) => ({ ...e, seq: e.seq + 100000 }));
resetStore.ingest(secondEvents.slice(0, 30));
check("race_start resets state", resetStore.state.raceId === 2 && resetStore.state.decisions.length === 0 && resetStore.state.finish === null && resetStore.state.pitStops.length === 0 && resetStore.state.lap === 1, { id: resetStore.state.raceId, d: resetStore.state.decisions.length, lap: resetStore.state.lap });

// ---------- analyst ----------
const why = analystAnswer("Why did we pit?", s);
check("analyst why-pit mentions lap 24", /lap 24/i.test(why), why);
check("analyst why-pit mentions lap 25", /lap 25/i.test(why), why);
check("analyst why-pit mentions MEDIUM", /MEDIUM/.test(why), why);
const tyres = analystAnswer("How are the tyres?", s);
check("analyst tyres has numbers", /MEDIUM/.test(tyres) && /°C/.test(tyres), tyres);
const gap = analystAnswer("What's the gap to the leader?", s);
check("analyst gap", gap.length > 20 && /\d/.test(gap), gap);
const summary = analystAnswer("Summarize the race so far", s);
check("analyst summary", /PIT NOW/.test(summary) && /lap 25/.test(summary), summary);
const stay = analystAnswer("What happens if we stay out?", s);
check("analyst stay out", stay.length > 20, stay);
const lap24 = analystAnswer("what happened on lap 24", s);
check("analyst lap 24", /PIT NOW/.test(lap24) && /Anomaly/i.test(lap24), lap24);
const future = analystAnswer("lap 70?", s);
check("analyst out-of-range lap", /no lap 70/i.test(future), future);
// mid-race answers (state at lap 24 before the stop)
const midStore = new Store();
const tl = buildTimeline(session);
const lap25Start = timeForLap(tl, 25);
midStore.ingest(tl.events.slice(0, indexAt(tl, lap25Start + 2500)));
const midWhy = analystAnswer("Why did we pit?", midStore.state);
check("analyst before the stop", /PIT NOW on lap 24/.test(midWhy), midWhy);
check("analyst empty state", /No race data/.test(analystAnswer("How are the tyres?", new Store().state)));

// ---------- replay core ----------
check("timeline duration ~ 60 laps", tl.duration > 59 * 5000 && tl.duration < 62 * 5000, tl.duration);
check("timeline has 60 laps", tl.laps.length >= 60, tl.laps.length);
check("recorded lap ms", Math.abs(tl.recordedLapMs - 5000) < 50, tl.recordedLapMs);
check("markers include pit + pitnow + sc + finish", ["pit", "pitnow", "sc", "finish", "scenario"].every((k) => tl.markers.some((m) => m.kind === k)), tl.markers);
const seekStore = new Store();
const t1 = performance.now();
seekStore.ingest(tl.events.slice(0, indexAt(tl, timeForLap(tl, 30))), { silent: true });
const seekMs = performance.now() - t1;
const dls = new Store();
dls.ingest(tl.events.slice(0, indexAt(tl, timeAfterDecision(tl, 24))), { silent: true });
check("synthetic deep link lap 24", dls.state.decisions.at(-1)?.suggestion === "PIT NOW");
check("seek to lap 30 is fast", seekMs < 100, seekMs);
check("seek to lap 30 lands on lap 30", seekStore.state.lap === 30, seekStore.state.lap);
check("seek decisions up to lap 28/29", [28, 29].includes(seekStore.state.decisionByLap.size), seekStore.state.decisionByLap.size);
const synth = synthesizeStatus(seekStore.state, { meta: session.meta, raceState: "running" });
check("synth status shape", synth.race.lap === 30 && synth.race.state === "running" && synth.capabilities.control === false && synth.agent.model === "claude-haiku-5-5", synth.race);
check("synth status pipeline counts", synth.pipeline.topics.car_telemetry.count === 291, synth.pipeline.topics.car_telemetry);
// out-of-order timestamps get sorted
const shuffled = { format: "boxbox-session/1", meta: {}, events: [evs[5], evs[3], evs[4]] };
const tl2 = buildTimeline(shuffled);
check("timeline sorts by ts", tl2.events[0].ts <= tl2.events[1].ts && tl2.events[1].ts <= tl2.events[2].ts);
// pauses are compressed
const gapped = { events: [{ ...evs[0], ts: 0 }, { ...evs[1], ts: 600000 }] };
check("long gaps compressed", buildTimeline(gapped).duration === 4000);

// stint-relative training progress
check("stintWindow lap 1", stintWindow(s, s.carStateByLap.get(1)) === 1);
check("stintWindow lap 6", stintWindow(s, s.carStateByLap.get(6)) === 6);
check("stintWindow after pit", stintWindow(s, s.carStateByLap.get(26)) === 2, stintWindow(s, s.carStateByLap.get(26)));
check("stintWindow engine never resets", stintWindow(s, s.carStateByLap.get(26), "engine_temp_c") === 26);
check("stintWindow skips SC windows", stintWindow(s, s.carStateByLap.get(41)) === stintWindow(s, s.carStateByLap.get(37)) + 1);

// ---------- the real recorded session (demo/session.json), when present ----------
const realPath = fileURLToPath(new URL("../demo/session.json", import.meta.url));
if (existsSync(realPath)) {
  const real = validateSession(JSON.parse(readFileSync(realPath, "utf8")));
  const rs = new Store();
  const rNotices = [];
  rs.onNotice((n) => rNotices.push(n.type));
  const tr = performance.now();
  rs.ingest(real.events);
  const realMs = performance.now() - tr;
  const r = rs.state;
  check("real: reduce fast", realMs < 250, realMs);
  const evR = real.events;
  const rDecEvents = evR.filter((e) => e.topic === "pit_decisions").map((e) => e.value);
  const rLaps = new Set(rDecEvents.map((d) => d.lap));
  check("real: a decision for every lap", r.decisionByLap.size === rLaps.size && rLaps.size === 60, r.decisionByLap.size);
  check("real: PIT NOW at 24", r.decisionByLap.get(24)?.suggestion === "PIT NOW");
  const finalByLap = new Map();
  for (const d of rDecEvents) finalByLap.set(d.lap, d);
  check("real: latest decision kept per lap", [...finalByLap].every(([lap, d]) => r.decisionByLap.get(lap).suggestion === d.suggestion && r.decisionByLap.get(lap).phase === (d.phase === "reflex" ? "reflex" : "final")));
  const reflexLaps = rDecEvents.filter((d) => d.phase === "reflex").map((d) => d.lap);
  if (reflexLaps.length) check("real: reflex laps end with a final", reflexLaps.every((l) => r.decisionByLap.get(l).phase === "final" || !rDecEvents.some((d) => d.lap === l && d.phase !== "reflex")));
  const sumR = r.finish?.summary;
  check("real: finish summary", sumR && r.finish.results.length === 22 && sumR.our_position === r.finish.results.find((x) => x.car_number === 88)?.position);
  check("real: decision counts match summary", JSON.stringify(decisionCounts(r)) === JSON.stringify(sumR.decisions), { ours: decisionCounts(r), theirs: sumR.decisions });
  check("real: anomaly laps match summary", JSON.stringify([...r.anomalyLaps.keys()].sort((a, b) => a - b)) === JSON.stringify(sumR.anomaly_laps), [...r.anomalyLaps.keys()]);
  const rStops = r.pitStops.filter((p) => Number(p.car_number) === r.ourCar);
  check("real: hero pit laps match summary", JSON.stringify(rStops.map((p) => p.lap)) === JSON.stringify(sumR.pit_laps), rStops.map((p) => p.lap));
  check("real: first hero stop lap 25 to MEDIUM", rStops[0]?.lap === 25 && rStops[0]?.to_compound === "MEDIUM", rStops[0]);
  check("real: box call by agent for lap 24", r.boxCalls[0]?.by === "agent" && r.boxCalls[0]?.decision_lap === 24);
  check("real: every pit_stop reduced", r.pitStops.length === evR.filter((e) => e.value?.kind === "pit_stop").length);
  check("real: settings reduced", r.settings.autopilot === true && typeof r.settings.scripted_incident === "boolean");
  check("real: state finished", r.raceState === "finished" && r.flag === "CHEQUERED" && r.lap === 60);
  check("real: notices", ["pit_now", "box_call", "pit_stop", "anomaly", "finish", "chequered"].every((k) => rNotices.includes(k)), rNotices);
  check("real: only hero stops notify", rNotices.filter((n) => n === "pit_stop").length === rStops.length);
  const pitNowLaps = new Set(rDecEvents.filter((d) => d.suggestion === "PIT NOW").map((d) => d.lap));
  check("real: one PIT NOW notice per lap", rNotices.filter((n) => n === "pit_now").length === pitNowLaps.size, rNotices.filter((n) => n === "pit_now").length);
  check("real: training restarts after pit", stintWindow(r, r.carStateByLap.get(25)) === 1 && r.carStateByLap.get(25).bounds.tire_temp_fl_c === null);
  const scLapsFile = new Set(evR.filter((e) => e.topic === "car_state" && e.value.safety_car).map((e) => e.value.lap));
  check("real: SC laps include car_state.safety_car windows", [...scLapsFile].every((l) => r.scLaps.has(l)));
  const rWhy = analystAnswer("Why did we pit?", r);
  check("real: analyst why-pit lap 24", /lap 24/.test(rWhy) && /lap 25/.test(rWhy), rWhy);
  check("real: analyst lap 24", /PIT NOW/.test(analystAnswer("What happened on lap 24?", r)));
  check("real: analyst summary", new RegExp(`P${sumR.our_position}`).test(analystAnswer("Summarize the race so far", r)));
  const rtl = buildTimeline(real);
  check("real: timeline ~300 s", Math.abs(rtl.duration - 300000) < 5000, rtl.duration);
  check("real: recorded lap 5 s", Math.abs(rtl.recordedLapMs - 5000) < 50, rtl.recordedLapMs);
  check("real: 60 lap marks", rtl.laps.length === 60, rtl.laps.length);
  const rSeek = new Store();
  rSeek.ingest(rtl.events.slice(0, indexAt(rtl, timeForLap(rtl, 24))), { silent: true });
  check("real: seek lands on lap 24", rSeek.state.lap === 24, rSeek.state.lap);
  // deep link ?lap=24 lands just after lap 24's (final) decision
  const dl = new Store();
  dl.ingest(rtl.events.slice(0, indexAt(rtl, timeAfterDecision(rtl, 24))), { silent: true });
  const lastLap24 = evR.filter((e) => e.topic === "pit_decisions" && e.value.lap === 24).at(-1);
  check("real: deep link lap 24 shows lap 24's last call (PIT NOW)", dl.state.decisionByLap.get(24)?._seq === lastLap24.seq && dl.state.decisionByLap.get(24)?.suggestion === "PIT NOW", dl.state.decisions.at(-1)?.lap);
  check("real: deep link lap 24 not deliberating", !isDeliberating(dl.state));
  const dl60 = new Store();
  dl60.ingest(rtl.events.slice(0, indexAt(rtl, timeAfterDecision(rtl, 60))), { silent: true });
  check("real: deep link lap 60 has lap 60 decision + finish", dl60.state.decisionByLap.has(60) && dl60.state.finish !== null);
  const rStatus = synthesizeStatus(r, { meta: real.meta, raceState: "finished", lapMs: rtl.recordedLapMs });
  check("real: synth status brain from recorded_with + 5 s/lap", rStatus.agent.strategist === (real.meta.recorded_with?.strategist ?? rStatus.agent.strategist) && rStatus.race.seconds_per_lap === 5, rStatus.agent);
  console.log(`real session: ${real.events.length} events reduced in ${realMs.toFixed(1)} ms`);
} else {
  console.log("real session: demo/session.json not found (skipped)");
}

// ---------- formatting / escaping ----------
const html = richTextToHtml('Hello **bold** <script>alert("x")</script>\nline2\n\npara2');
check("rich text escapes html", !html.includes("<script>") && html.includes("&lt;script&gt;"), html);
check("rich text bold", html.includes("<strong>bold</strong>"));
check("rich text paragraphs + br", html.split("<p>").length === 3 && html.includes("<br>"), html);
check("parse rich text", parseRichText("a **b** c")[0][0].length === 3);
check("escapeHtml", escapeHtml(`<a href="x">'&`) === "&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
check("speed label 20", speedLabel(20) === "20s/lap (1×)");
check("speed label 5", speedLabel(5) === "5s/lap (4×)");
check("speed label 1", speedLabel(1) === "1s/lap (20×)");
check("gap leader", fmtGap(0) === "LEADER" && fmtGap(1.234) === "+1.2");
check("brain label", brainLabel("claude", "claude-haiku-5-5") === "Claude haiku" && brainLabel("rules", null) === "Rules engine");
check("strategist label", strategistLabel({ strategist: "hybrid", model: "claude-haiku-5-5" }) === "Claude haiku" && strategistLabel({ strategist: "rules" }) === "Rules engine");

console.log(`\nselftest: ${passed} passed, ${failed} failed  (reduce ${reduceMs.toFixed(1)} ms for ${evs.length} events, seek ${seekMs.toFixed(1)} ms, ${SYNTHETIC_SCRIPT.totalLaps} laps)`);
console.log(`final: ${s.finish.results[0].driver} wins; #88 P${sum.our_position} (from P${sum.start_position}), decisions ${JSON.stringify(sum.decisions)}`);
if (failed) process.exit(1);
