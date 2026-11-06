// Built-in race analyst: answers engineer questions from reducer state with real numbers.
// Used in replay/synthetic mode, where no backend LLM is available. Pure (no DOM).

import {
  heroCar, getOrder, latestCarState, latestDecision, heroPitStops, decisionCounts,
  avgLatency, scPeriods, heroSummary, eventsOnLap,
} from "./store.js";
import { isNum, fmtLapTime, SIGNALS, stripBold } from "./format.js";

const f1 = (v) => (isNum(v) ? v.toFixed(1) : "—");
const f2 = (v) => (isNum(v) ? v.toFixed(2) : "—");

function name(car) {
  return car ? `${car.driver} (${car.driver_code}, #${car.car_number})` : "—";
}

function lapsLeft(state) {
  return Math.max(0, (state.totalLaps || 60) - (state.lap || 0));
}

function noRace(state) {
  return !state.cars.size || !heroCar(state)?.row;
}

function boundsText(row, key) {
  const b = row?.bounds?.[key];
  if (!b) return "detector still training";
  const sig = SIGNALS[key];
  return `expected ${b.expected.toFixed(sig.decimals)}, band ${b.lower.toFixed(sig.decimals)}–${b.upper.toFixed(sig.decimals)}`;
}

function heroPositionAt(state, lap) {
  return heroCar(state)?.positions[lap] ?? null;
}

function whyPit(state) {
  const stops = heroPitStops(state);
  const pitNow = state.decisions.filter((d) => d.suggestion === "PIT NOW");
  if (!stops.length) {
    if (pitNow.length) {
      const d = pitNow[pitNow.length - 1];
      return `We haven't stopped yet, but the strategist called **PIT NOW on lap ${d.lap}**: ${stripBold(d.condition_summary)} ` +
        `The recommendation is ${d.recommended_tire_compound ?? "a fresh set"}${d.recommended_stint_laps ? ` for ${d.recommended_stint_laps} laps` : ""}.`;
    }
    const soon = state.decisions.filter((d) => d.suggestion === "PIT SOON");
    const hero = heroCar(state);
    const row = hero?.row;
    if (soon.length) {
      const d = soon[soon.length - 1];
      return `We haven't pitted yet. The strategist has been saying **PIT SOON** since lap ${soon[0].lap}: ${stripBold(d.condition_summary)}`;
    }
    return `We haven't pitted. ${row ? `We're on ${row.tire_age_laps}-lap-old ${row.tire_compound}s` : "The tyres are fine"} and every decision so far has been **STAY OUT**.`;
  }
  const parts = [];
  for (const s of stops) {
    const call = state.boxCalls.find((b) => Number(b.car_number) === state.ourCar && Math.abs((b.lap ?? s.lap) - s.lap) <= 1);
    const decLap = call?.decision_lap ?? (pitNow.length ? pitNow.filter((d) => d.lap <= s.lap).pop()?.lap : null);
    const d = decLap != null ? state.decisionByLap.get(decLap) : null;
    const cs = decLap != null ? state.carStateByLap.get(decLap) : null;
    const before = heroPositionAt(state, s.lap - 1);
    const after = heroPositionAt(state, s.lap);
    let p = `We pitted on **lap ${s.lap}**, ${s.from_compound ?? "?"} → **${s.to_compound ?? "?"}**` +
      (isNum(s.stop_time_sec) ? ` (${s.stop_time_sec.toFixed(1)} s stop)` : "") + ".";
    if (s.reason === "engineer" || call?.by === "engineer") {
      p += " That was an engineer override from the pit wall (BOX button), not the strategist.";
    } else if (s.reason === "tyre_life" || call?.by === "tyre_life") {
      p += " The tyres reached the end of their safe life, so the car came in regardless of the strategist's call.";
    } else if (d) {
      p += ` The strategist called **${d.suggestion} on lap ${d.lap}**: ${stripBold(d.condition_summary)}`;
      if (cs?.bounds?.tire_temp_fl_c && cs.anomaly_tire_temp_fl) {
        const b = cs.bounds.tire_temp_fl_c;
        p += ` The front-left window averaged ${f1(cs.tire_temp_fl_c)}°C against an upper bound of ${f1(b.upper)}°C (expected ${f1(b.expected)}°C).`;
      }
      if (d.recommended_reason) p += ` ${d.recommended_reason}`;
      p += ` (${d.agent === "rules" ? "rules engine" : "Claude"}${isNum(d.latency_ms) ? `, ${Math.round(d.latency_ms)} ms` : ""}).`;
      if (call?.by === "agent") p += " Autopilot was on, so the car obeyed the call.";
    } else if (s.reason) {
      p += ` Reason recorded: ${s.reason}.`;
    }
    if (isNum(before) && isNum(after)) p += `\n\nWe went in P${before} and came out P${after}.`;
    parts.push(p);
  }
  const hero = heroCar(state);
  if (hero?.row && stops.length) parts.push(`Now: **P${hero.row.position}** on ${hero.row.tire_age_laps}-lap-old ${hero.row.tire_compound}s.`);
  return parts.join("\n\n");
}

function tyres(state) {
  const t = state.telemetry;
  const cs = latestCarState(state);
  const row = heroCar(state)?.row;
  if (!t && !cs) return "No tyre data yet. The car hasn't completed a reading.";
  const src = t || cs;
  let s = `We're on **${row?.tire_compound ?? cs?.tire_compound ?? "?"}s, ${row?.tire_age_laps ?? cs?.tire_age_laps ?? "?"} laps old**.\n`;
  s += `Temps: FL ${f1(src.tire_temp_fl_c)}°C · FR ${f1(src.tire_temp_fr_c)}°C · RL ${f1(src.tire_temp_rl_c)}°C · RR ${f1(src.tire_temp_rr_c)}°C\n`;
  s += `Pressures: FL ${f1(src.tire_pressure_fl_psi)} · FR ${f1(src.tire_pressure_fr_psi)} · RL ${f1(src.tire_pressure_rl_psi)} · RR ${f1(src.tire_pressure_rr_psi)} psi`;
  if (cs) {
    const anomalies = [];
    if (cs.anomaly_tire_temp_fl) anomalies.push("front-left temperature");
    if (cs.anomaly_tire_pressure_fl) anomalies.push("front-left pressure");
    s += `\n\nLast window (lap ${cs.lap}): FL ${f1(cs.tire_temp_fl_c)}°C, ${boundsText(cs, "tire_temp_fl_c")}.`;
    s += anomalies.length ? ` **Anomaly: ${anomalies.join(" and ")}.**` : " Nothing outside its band.";
  }
  const d = latestDecision(state);
  if (d) s += `\n\nStrategist's latest call (lap ${d.lap}): **${d.suggestion}**.`;
  return s;
}

function gap(state) {
  const hero = heroCar(state);
  const row = hero?.row;
  if (!row) return "No timing yet.";
  const order = getOrder(state);
  const leader = order[0];
  const ahead = row.position > 1 ? order[row.position - 2] : null;
  const behind = order[row.position] || null;
  if (row.position === 1) {
    let s = `**We're leading.**`;
    if (behind?.row) s += ` ${name(behind)} is ${f1(behind.row.gap_to_ahead_sec)}s behind.`;
    return s + ` ${lapsLeft(state)} laps to go.`;
  }
  let s = `We're **P${row.position}, ${f1(row.gap_to_leader_sec)}s behind the leader** ${name(leader)}.`;
  if (ahead) s += ` The car ahead is ${name(ahead)}, ${f1(row.gap_to_ahead_sec)}s up the road.`;
  const lap = row.lap;
  const past = hero.gaps[lap - 5];
  if (isNum(past)) {
    const delta = row.gap_to_leader_sec - past;
    s += `\n\nOver the last 5 laps the gap to the lead has ${delta < 0 ? "shrunk" : "grown"} by ${Math.abs(delta).toFixed(1)}s (${(Math.abs(delta) / 5).toFixed(2)}s/lap).`;
  }
  s += ` Last lap: ${fmtLapTime(row.last_lap_time_sec)}.`;
  return s;
}

function summary(state) {
  const hero = heroCar(state);
  if (!hero?.row) return "The race hasn't started yet.";
  const sum = state.finish?.summary || heroSummary(state);
  const lines = [];
  const status = state.finish ? `**Race finished.**` : `**Lap ${state.lap}/${state.totalLaps}.**`;
  lines.push(`${status} ${hero.driver} started P${sum.start_position ?? "?"} and ${state.finish ? "finished" : "is running"} **P${sum.our_position ?? hero.row.position}**` +
    (isNum(sum.positions_gained) && sum.positions_gained !== 0 ? ` (${sum.positions_gained > 0 ? "+" : ""}${sum.positions_gained})` : "") + ".");
  const stops = heroPitStops(state);
  lines.push(stops.length
    ? `Pit stops: ${stops.map((s) => `lap ${s.lap} (${s.from_compound} → ${s.to_compound})`).join(", ")}.`
    : `No pit stops yet; ${hero.row.tire_age_laps}-lap-old ${hero.row.tire_compound}s.`);
  const c = decisionCounts(state);
  lines.push(`Strategist calls: ${c["STAY OUT"]} STAY OUT, ${c["PIT SOON"]} PIT SOON, ${c["PIT NOW"]} PIT NOW` +
    (isNum(avgLatency(state)) ? `, averaging ${Math.round(avgLatency(state))} ms per decision.` : "."));
  const anomalies = [...state.anomalyLaps.entries()];
  lines.push(anomalies.length
    ? `Anomalies: ${anomalies.map(([lap, sigs]) => `lap ${lap} (${sigs.map((k) => SIGNALS[k]?.label ?? k).join(", ")})`).join("; ")}.`
    : "No anomalies detected.");
  const scen = state.scenarios.filter((s) => s.kind !== "safety_car");
  if (scen.length) lines.push(`Incidents: ${scen.map((s) => `${s.label} on lap ${s.lap}${s.source === "scripted" ? " (scripted)" : ""}`).join(", ")}.`);
  const sc = scPeriods(state);
  if (sc.length) lines.push(`Safety car: ${sc.map((p) => (p.start === p.end ? `lap ${p.start}` : `laps ${p.start}–${p.end}`)).join(", ")}.`);
  const leader = getOrder(state)[0];
  if (leader && leader.car_number !== state.ourCar) lines.push(`${state.finish ? "Winner" : "Leader"}: ${name(leader)}.`);
  return lines.join("\n");
}

function stayOut(state) {
  const hero = heroCar(state);
  const row = hero?.row;
  if (!row) return "No data yet to model a stay-out.";
  const R = lapsLeft(state);
  const cs = latestCarState(state);
  const d = latestDecision(state);
  const lap = row.lap;
  const recent = [lap, lap - 1, lap - 2].map((l) => hero.lapTimes[l]).filter((x) => isNum(x) && x < 110);
  const older = [lap - 5, lap - 6, lap - 7].map((l) => hero.lapTimes[l]).filter((x) => isNum(x) && x < 110);
  const degPerLap = recent.length && older.length
    ? (recent.reduce((a, b) => a + b, 0) / recent.length - older.reduce((a, b) => a + b, 0) / older.length) / 5
    : null;
  let s = "";
  if (cs?.anomaly_tire_temp_fl) {
    const b = cs.bounds?.tire_temp_fl_c;
    s += `Staying out with the front-left at **${f1(cs.tire_temp_fl_c)}°C**${b ? ` (${(cs.tire_temp_fl_c - b.upper).toFixed(1)}°C over its upper bound)` : ""} is a failure risk, not just a pace problem. `;
  }
  if (R === 0) return s + "The race is over: there's nothing left to stay out for.";
  if (isNum(degPerLap) && degPerLap > 0.02) {
    const loss = (degPerLap * R * (R + 1)) / 2;
    s += `Our ${row.tire_compound}s are losing about **${degPerLap.toFixed(2)}s per lap** (${row.tire_age_laps} laps old). ` +
      `Over the remaining ${R} laps that compounds to roughly **${loss.toFixed(0)}s**, versus about 21s for a stop. `;
    s += loss > 21 ? "A stop pays for itself." : "Staying out is still the cheaper option on pure time.";
  } else {
    s += `Pace is stable (${row.tire_age_laps}-lap-old ${row.tire_compound}s, last lap ${fmtLapTime(row.last_lap_time_sec)}), so staying out costs little right now. A stop is about 21s.`;
  }
  if (d) s += `\n\nThe strategist's current call (lap ${d.lap}) is **${d.suggestion}**${d.recommended_tire_compound ? `, recommending ${d.recommended_tire_compound}` : ""}.`;
  return s;
}

function lapReport(state, lap) {
  if (lap < 1 || lap > (state.totalLaps || 60)) return `There is no lap ${lap} in a ${state.totalLaps}-lap race.`;
  if (lap > state.lap) return `Lap ${lap} hasn't happened yet: we're on lap ${state.lap}.`;
  const hero = heroCar(state);
  const lines = [`**Lap ${lap}**`];
  const pos = hero?.positions[lap];
  const lt = hero?.lapTimes[lap];
  if (isNum(pos)) lines.push(`Position P${pos}, lap time ${fmtLapTime(lt)}, gap to leader ${f1(hero.gaps[lap])}s.`);
  const cs = state.carStateByLap.get(lap);
  if (cs) {
    let t = `Window: FL ${f1(cs.tire_temp_fl_c)}°C (${boundsText(cs, "tire_temp_fl_c")}), engine ${f1(cs.engine_temp_c)}°C, ${cs.tire_compound} age ${cs.tire_age_laps}.`;
    const sigs = state.anomalyLaps.get(lap);
    if (sigs) t += ` **Anomaly: ${sigs.map((k) => SIGNALS[k]?.label ?? k).join(", ")}.**`;
    lines.push(t);
  }
  const d = state.decisionByLap.get(lap);
  if (d) lines.push(`Strategist: **${d.suggestion}**. ${stripBold(d.condition_summary)}`);
  const evs = eventsOnLap(state, lap).filter((e) => e.kind !== "race_start");
  for (const e of evs) lines.push(`• ${e.message || e.kind}`);
  if (state.scLaps.has(lap)) lines.push("Safety car was out.");
  return lines.join("\n");
}

function position(state) {
  const row = heroCar(state)?.row;
  if (!row) return "No timing yet.";
  return `We're **P${row.position}** on lap ${row.lap}/${state.totalLaps}, ${row.position === 1 ? "leading" : `${f1(row.gap_to_leader_sec)}s off the lead`}.`;
}

function fuel(state) {
  const t = state.telemetry;
  if (!t) return "No telemetry yet.";
  const used = isNum(state.fuelMax) ? state.fuelMax - t.fuel_remaining_kg : null;
  const perLap = used != null && state.lap > 1 ? used / Math.max(1, t.lap - 1 + t.lap_fraction) : null;
  let s = `Fuel **${f1(t.fuel_remaining_kg)} kg**, battery **${f1(t.battery_charge_pct)}%**, engine ${f1(t.engine_temp_c)}°C.`;
  if (isNum(perLap) && perLap > 0) {
    const reach = t.fuel_remaining_kg / perLap;
    s += ` Burning about ${f2(perLap)} kg/lap: enough for ${reach.toFixed(0)} more laps with ${lapsLeft(state)} to go.`;
  }
  return s;
}

function engine(state) {
  const cs = latestCarState(state);
  const t = state.telemetry;
  if (!cs && !t) return "No engine data yet.";
  let s = `Engine ${f1((t || cs).engine_temp_c)}°C.`;
  if (cs) s += ` Last window ${f1(cs.engine_temp_c)}°C, ${boundsText(cs, "engine_temp_c")}${cs.anomaly_engine_temp ? " — **outside its band**" : ", nominal"}.`;
  return s;
}

function safetyCar(state) {
  const sc = scPeriods(state);
  if (state.flag === "SC") return `**Safety car is out** (since lap ${sc.length ? sc[sc.length - 1].start : state.lap}). The field is bunched; gaps will be small at the restart.`;
  if (!sc.length) return "No safety car so far.";
  return `Safety car periods: ${sc.map((p) => (p.start === p.end ? `lap ${p.start}` : `laps ${p.start}–${p.end}`)).join(", ")}.`;
}

function leader(state) {
  const order = getOrder(state);
  const l = order[0];
  if (!l?.row) return "No timing yet.";
  return `${name(l)} leads${l.car_number === state.ourCar ? " — that's us" : ""}, on ${l.row.tire_age_laps}-lap-old ${l.row.tire_compound}s with ${l.row.pit_stops} stop${l.row.pit_stops === 1 ? "" : "s"}.`;
}

function strategyCall(state) {
  const d = latestDecision(state);
  if (!d) return "The strategist hasn't made a call yet: it decides once per lap, after each 20-second window.";
  let s = `Latest call (lap ${d.lap}): **${d.suggestion}**. ${stripBold(d.condition_summary)}`;
  if (d.recommended_tire_compound) s += `\nRecommended: ${d.recommended_tire_compound}${d.recommended_stint_laps ? ` for ${d.recommended_stint_laps} laps` : ""}. ${d.recommended_reason ?? ""}`;
  s += `\n\n${stripBold(d.reasoning)}`;
  return s;
}

export function analystAnswer(question, state) {
  const q = String(question || "").toLowerCase().trim();
  if (!q) return "Ask me about the tyres, the gap, the pit stop, or a specific lap.";
  if (noRace(state) && !/help|what can/.test(q)) return "No race data yet. Start the race (or the replay) and ask again.";

  const lapMatch = q.match(/\blap\s*(\d{1,3})\b/) || q.match(/\bl(\d{1,3})\b/);
  if (lapMatch && !/stay out|what if/.test(q)) return lapReport(state, Number(lapMatch[1]));
  if (/why.*(pit|box|stop)|(pit|box|stop).*why|reason.*(pit|stop)|when did we (pit|stop|box)/.test(q)) return whyPit(state);
  if (/stay out|what if|what happens if|don'?t pit|no stop|extend/.test(q)) return stayOut(state);
  if (/summar|so far|recap|overview|how('?s| is| did) (the )?race|report/.test(q)) return summary(state);
  if (/tyre|tire|rubber|degrad|front.?left|\bfl\b|temperature|overheat/.test(q)) return tyres(state);
  if (/gap|leader|ahead|behind|interval|catch/.test(q)) return /who/.test(q) ? leader(state) : gap(state);
  if (/who.*(lead|winning|first|p1)/.test(q)) return leader(state);
  if (/position|where are we|what place|\bp\d\b/.test(q)) return position(state);
  if (/fuel|battery|energy|ers/.test(q)) return fuel(state);
  if (/engine|power ?unit|coolant/.test(q)) return engine(state);
  if (/safety|sc\b|yellow|neutral/.test(q)) return safetyCar(state);
  if (/pit|box|strategy|call|decision|recommend|should we/.test(q)) return /when|did/.test(q) ? whyPit(state) : strategyCall(state);
  if (/anomal|detector|bound/.test(q)) return tyres(state);
  return (
    "I'm the built-in analyst for this replay, so I answer from the race data only. Try:\n" +
    "• Why did we pit?\n• How are the tyres?\n• What's the gap to the leader?\n• Summarize the race so far\n• What happens if we stay out?\n• What happened on lap 24?\n\n" +
    position(state)
  );
}

export const ANALYST_PROVIDER = { provider: "analyst", model: "built-in" };
