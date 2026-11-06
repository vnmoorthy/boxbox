// Anomaly detection panel + car telemetry panel.

import { $, h, s, setText, setAttr, toggleClass } from "./dom.js";
import { createBandChart } from "./charts.js";
import { latestCarState, stintWindow, anomalySignals } from "./store.js";
import { SIGNALS, fmtNum, isNum, heatColor, brakeColor, clamp } from "./format.js";

// ---------------------------------------------------------------- anomaly panel
export function createAnomalyPanel() {
  const chip = $("#anom-chip");
  const ro = { now: $("#anom-now"), exp: $("#anom-exp"), band: $("#anom-band"), dev: $("#anom-dev"), devWrap: $("#anom-dev-wrap") };
  const main = createBandChart($("#chart-fl"), { signal: "tire_temp_fl_c", height: 230, label: "Front-left tyre temperature" });
  const press = createBandChart($("#chart-press"), { signal: "tire_pressure_fl_psi", height: 120, compact: true, label: "Front-left tyre pressure" });
  const eng = createBandChart($("#chart-engine"), { signal: "engine_temp_c", height: 120, compact: true, label: "Engine temperature" });
  const miniChips = { tire_pressure_fl_psi: $("#chip-press"), engine_temp_c: $("#chip-engine") };

  function chipFor(state, row, signal) {
    if (!row) return { kind: "wait", text: "WAITING" };
    if (row[SIGNALS[signal].anomaly]) return { kind: "bad", text: "ANOMALY" };
    if (!row.bounds?.[signal]) return { kind: "train", text: `TRAINING (${Math.min(stintWindow(state, row, signal), 6)}/6)` };
    return { kind: "ok", text: "NOMINAL" };
  }

  function update(state) {
    main.update(state);
    press.update(state);
    eng.update(state);
    const row = latestCarState(state);
    const sigs = anomalySignals(row);
    let c;
    if (!row) c = { kind: "wait", text: "WAITING FOR FIRST WINDOW", tip: "car_state emits one window per lap (20 s of sim time)" };
    else if (sigs.length) c = { kind: "bad", text: `ANOMALY · ${sigs.map((k) => SIGNALS[k].short).join(" + ")}`, tip: `Lap ${row.lap}: outside the detector's expected band` };
    else if (!row.bounds?.tire_temp_fl_c) {
      const n = Math.min(stintWindow(state, row), 6);
      c = { kind: "train", text: `TRAINING (${n}/6)`, tip: "The detector learns each signal's normal band from the first 6 windows of every stint" };
    } else c = { kind: "ok", text: "NOMINAL", tip: `Lap ${row.lap}: all monitored signals inside their bands` };
    chip.dataset.kind = c.kind;
    setText(chip, c.text);
    chip.dataset.tip = c.tip;
    for (const [sig, el] of Object.entries(miniChips)) {
      const mc = chipFor(state, row, sig);
      el.dataset.kind = mc.kind;
      setText(el, mc.text);
    }

    // readout: live FL vs last window's band
    const t = state.telemetry;
    const b = row?.bounds?.tire_temp_fl_c;
    setText(ro.now, isNum(t?.tire_temp_fl_c) ? `${fmtNum(t.tire_temp_fl_c, 1)}°C` : isNum(row?.tire_temp_fl_c) ? `${fmtNum(row.tire_temp_fl_c, 1)}°C` : "—");
    setText(ro.exp, b ? `${fmtNum(b.expected, 1)}°C` : "—");
    setText(ro.band, b ? `${fmtNum(b.lower, 1)}–${fmtNum(b.upper, 1)}` : row ? "training" : "—");
    const v = isNum(t?.tire_temp_fl_c) ? t.tire_temp_fl_c : row?.tire_temp_fl_c;
    let dev = "—";
    let devKind = "";
    if (b && isNum(v)) {
      if (v > b.upper) {
        dev = `+${fmtNum(v - b.upper, 1)}° over`;
        devKind = "bad";
      } else if (v < b.lower) {
        dev = `${fmtNum(v - b.lower, 1)}° under`;
        devKind = "bad";
      } else {
        dev = `${v >= b.expected ? "+" : ""}${fmtNum(v - b.expected, 1)}° vs exp.`;
        devKind = "ok";
      }
    }
    setText(ro.dev, dev);
    ro.devWrap.dataset.kind = devKind;
  }

  return { update };
}

// ---------------------------------------------------------------- car telemetry
const TYRES = [
  { k: "fl", label: "FL", x: 92, y: 74, w: 32, h: 60, side: "l" },
  { k: "fr", label: "FR", x: 236, y: 74, w: 32, h: 60, side: "r" },
  { k: "rl", label: "RL", x: 86, y: 268, w: 38, h: 70, side: "l" },
  { k: "rr", label: "RR", x: 236, y: 268, w: 38, h: 70, side: "r" },
];

function buildCarSvg() {
  const svg = s("svg", { class: "car-svg", viewBox: "14 14 332 362", role: "img", "aria-label": "Top-down view of car 88 with tyre temperatures" });
  const defs = s("defs");
  defs.innerHTML = `
    <linearGradient id="car-body" x1="0" x2="1">
      <stop offset="0" stop-color="#0b3b30"/><stop offset=".5" stop-color="#12e3a5"/><stop offset="1" stop-color="#0b3b30"/></linearGradient>
    <linearGradient id="car-body-dark" x1="0" x2="1">
      <stop offset="0" stop-color="#161b21"/><stop offset=".5" stop-color="#2a323c"/><stop offset="1" stop-color="#161b21"/></linearGradient>
    <linearGradient id="tyre-shine" x1="0" x2="1">
      <stop offset="0" stop-color="#000" stop-opacity=".45"/><stop offset=".35" stop-color="#fff" stop-opacity=".18"/><stop offset="1" stop-color="#000" stop-opacity=".5"/></linearGradient>`;
  svg.append(defs);
  const body = s("g", { class: "car-body" });
  // suspension arms
  body.append(
    s("path", { d: "M124 92 L160 110 M124 118 L160 122 M236 92 L200 110 M236 118 L200 122", class: "car-arm" }),
    s("path", { d: "M124 290 L156 282 M124 318 L158 306 M236 290 L204 282 M236 318 L202 306", class: "car-arm" }),
  );
  // front wing
  body.append(
    s("path", { d: "M100 30 Q180 18 260 30 L262 44 Q180 36 98 44 Z", class: "car-wing" }),
    s("rect", { x: 94, y: 26, width: 8, height: 22, rx: 2, class: "car-endplate" }),
    s("rect", { x: 258, y: 26, width: 8, height: 22, rx: 2, class: "car-endplate" }),
  );
  // nose + chassis
  body.append(
    s("path", { d: "M172 40 Q180 30 188 40 L196 130 L164 130 Z", fill: "url(#car-body)", class: "car-shell" }),
    s("path", { d: "M164 128 L196 128 L214 168 Q226 180 226 210 L224 276 Q220 312 200 330 L160 330 Q140 312 136 276 L134 210 Q134 180 146 168 Z", fill: "url(#car-body-dark)", class: "car-shell" }),
    s("path", { d: "M170 136 L190 136 L198 300 Q190 318 180 320 Q170 318 162 300 Z", fill: "url(#car-body)", class: "car-shell", opacity: ".9" }),
  );
  // sidepod inlets
  body.append(
    s("path", { d: "M146 172 L162 168 L160 196 L140 200 Z", class: "car-inlet" }),
    s("path", { d: "M214 172 L198 168 L200 196 L220 200 Z", class: "car-inlet" }),
  );
  // cockpit + halo
  body.append(
    s("ellipse", { cx: 180, cy: 200, rx: 12, ry: 24, class: "car-cockpit" }),
    s("path", { d: "M168 186 Q180 168 192 186 M180 172 L180 182", class: "car-halo" }),
    s("circle", { cx: 180, cy: 206, r: 7, class: "car-helmet" }),
  );
  // rear wing + diffuser
  body.append(
    s("rect", { x: 128, y: 344, width: 104, height: 20, rx: 3, class: "car-wing" }),
    s("rect", { x: 124, y: 340, width: 8, height: 28, rx: 2, class: "car-endplate" }),
    s("rect", { x: 228, y: 340, width: 8, height: 28, rx: 2, class: "car-endplate" }),
    s("text", { x: 180, y: 258, class: "car-number", "text-anchor": "middle" }, "88"),
  );
  svg.append(body);
  const tyres = {};
  for (const t of TYRES) {
    const g = s("g", { class: `tyre tyre-${t.k}` });
    const rect = s("rect", { x: t.x, y: t.y, width: t.w, height: t.h, rx: 7, class: "tyre-fill" });
    const shine = s("rect", { x: t.x, y: t.y, width: t.w, height: t.h, rx: 7, fill: "url(#tyre-shine)", class: "tyre-shine" });
    const alert = s("rect", { x: t.x - 4, y: t.y - 4, width: t.w + 8, height: t.h + 8, rx: 10, class: "tyre-alert" });
    const lx = t.side === "l" ? t.x - 10 : t.x + t.w + 10;
    const anchor = t.side === "l" ? "end" : "start";
    const tag = s("text", { x: lx, y: t.y + 10, class: "tyre-tag", "text-anchor": anchor }, t.label);
    const temp = s("text", { x: lx, y: t.y + 32, class: "tyre-temp", "text-anchor": anchor }, "—");
    const pres = s("text", { x: lx, y: t.y + 50, class: "tyre-pres", "text-anchor": anchor }, "— psi");
    g.append(alert, rect, shine, tag, temp, pres);
    svg.append(g);
    tyres[t.k] = { g, rect, temp, pres };
  }
  return { svg, tyres };
}

export function createCarPanel() {
  const holder = $("#car-figure");
  const { svg, tyres } = buildCarSvg();
  holder.append(svg);
  const m = {
    engine: $("#m-engine"),
    engineBar: $("#m-engine-bar"),
    brakeFl: $("#m-brake-fl"),
    brakeFr: $("#m-brake-fr"),
    fuel: $("#m-fuel"),
    fuelBar: $("#m-fuel-bar"),
    batt: $("#m-batt"),
    battBar: $("#m-batt-bar"),
    speed: $("#m-speed"),
    throttle: $("#m-throttle"),
    throttleBar: $("#m-throttle-bar"),
    brake: $("#m-brake"),
    brakeBar: $("#m-brake-bar"),
    drs: $("#m-drs"),
    compound: $("#car-compound"),
    stale: $("#car-empty"),
  };
  let lastRev = -1;

  function update(state) {
    const k = `${state.epoch}:${state.rev.telemetry}:${state.rev.carState}`;
    if (k === lastRev) return;
    lastRev = k;
    const t = state.telemetry;
    const cs = latestCarState(state);
    const row = state.cars.get(state.ourCar)?.row;
    m.stale.hidden = !!t;
    for (const key of ["fl", "fr", "rl", "rr"]) {
      const temp = t?.[`tire_temp_${key}_c`];
      const pres = t?.[`tire_pressure_${key}_psi`];
      const ty = tyres[key];
      ty.rect.style.fill = heatColor(temp);
      setText(ty.temp, isNum(temp) ? `${Math.round(temp)}°` : "—");
      setText(ty.pres, isNum(pres) ? `${pres.toFixed(1)} psi` : "— psi");
      const hot = key === "fl" && (cs?.anomaly_tire_temp_fl || cs?.anomaly_tire_pressure_fl);
      toggleClass(ty.g, "is-alert", !!hot);
    }
    setAttr(svg, "aria-label", t ? `Tyres: FL ${Math.round(t.tire_temp_fl_c)}°C, FR ${Math.round(t.tire_temp_fr_c)}°C, RL ${Math.round(t.tire_temp_rl_c)}°C, RR ${Math.round(t.tire_temp_rr_c)}°C` : "Top-down view of car 88, no telemetry yet");
    setText(m.compound, row ? `${row.tire_compound} · ${row.tire_age_laps} laps` : "—");
    m.compound.dataset.compound = row?.tire_compound || "";

    const eng = t?.engine_temp_c;
    setText(m.engine, isNum(eng) ? `${eng.toFixed(1)}°C` : "—");
    m.engineBar.style.transform = `scaleX(${isNum(eng) ? clamp((eng - 90) / 45, 0.02, 1) : 0})`;
    m.engineBar.style.background = isNum(eng) ? (cs?.anomaly_engine_temp ? "var(--red)" : eng > 126 ? "var(--amber)" : "var(--accent)") : "";
    for (const [el, v] of [[m.brakeFl, t?.brake_temp_fl_c], [m.brakeFr, t?.brake_temp_fr_c]]) {
      setText(el, isNum(v) ? `${Math.round(v)}°` : "—");
      el.style.color = isNum(v) ? brakeColor(v) : "";
    }
    const fuel = t?.fuel_remaining_kg;
    const fuelMax = Math.max(state.fuelMax || 0, 1);
    setText(m.fuel, isNum(fuel) ? `${fuel.toFixed(1)} kg` : "—");
    m.fuelBar.style.transform = `scaleX(${isNum(fuel) ? clamp(fuel / fuelMax, 0, 1) : 0})`;
    const batt = t?.battery_charge_pct;
    setText(m.batt, isNum(batt) ? `${batt.toFixed(0)}%` : "—");
    m.battBar.style.transform = `scaleX(${isNum(batt) ? clamp(batt / 100, 0, 1) : 0})`;
    setText(m.speed, isNum(t?.speed_kph) ? `${Math.round(t.speed_kph)}` : "—");
    setText(m.throttle, isNum(t?.throttle_pct) ? `${Math.round(t.throttle_pct)}%` : "—");
    m.throttleBar.style.transform = `scaleX(${isNum(t?.throttle_pct) ? clamp(t.throttle_pct / 100, 0, 1) : 0})`;
    setText(m.brake, isNum(t?.brake_pct) ? `${Math.round(t.brake_pct)}%` : "—");
    m.brakeBar.style.transform = `scaleX(${isNum(t?.brake_pct) ? clamp(t.brake_pct / 100, 0, 1) : 0})`;
    toggleClass(m.drs, "is-on", !!t?.drs_active);
    setText(m.drs, t?.drs_active ? "DRS OPEN" : "DRS");
  }

  return { update };
}
