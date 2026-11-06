// Hand-rolled SVG charts.
//   createBandChart: a car_state signal per window with the detector's expected line,
//     lower–upper band, anomaly markers, pit markers, SC/training shading, live reading.
//   createPositionChart: hero position over laps (inverted), rivals faint, pit markers.

import { s, h, showTip, hideTip, setAttr } from "./dom.js";
import { SIGNALS, isNum, fmtNum, compoundColor, clamp } from "./format.js";
import { heroPitStops, getOrder, stintWindow } from "./store.js";

let chartSeq = 0;

function niceStep(span, target = 4) {
  const raw = span / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
}

function pathFrom(points) {
  let d = "";
  points.forEach(([x, y], i) => (d += (i ? "L" : "M") + x.toFixed(1) + "," + y.toFixed(1)));
  return d;
}

function observeWidth(el, cb) {
  let w = 0;
  const ro = new ResizeObserver((entries) => {
    const nw = Math.round(entries[0].contentRect.width);
    if (nw && nw !== w) {
      w = nw;
      cb(nw);
    }
  });
  ro.observe(el);
  return () => ro.disconnect();
}

// ---------------------------------------------------------------- band chart
export function createBandChart(container, { signal, height = 200, compact = false, label }) {
  const sig = SIGNALS[signal];
  const id = `bc${++chartSeq}`;
  const svg = s("svg", { class: `chart band-chart ${compact ? "is-compact" : ""}`, role: "img", tabindex: "0", "aria-label": `${label || sig.label} per lap with detector bounds` });
  const defs = s("defs");
  defs.innerHTML = `
    <pattern id="${id}-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="0" y2="6" stroke="rgba(255,255,255,.07)" stroke-width="2"/></pattern>
    <linearGradient id="${id}-area" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="#12e3a5" stop-opacity=".22"/><stop offset="1" stop-color="#12e3a5" stop-opacity="0"/></linearGradient>
    <filter id="${id}-glow" x="-100%" y="-100%" width="300%" height="300%">
      <feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`;
  const g = {};
  for (const k of ["grid", "shade", "band", "expected", "area", "actual", "pit", "anom", "live", "hover"]) g[k] = s("g", { class: `bc-${k}` });
  svg.append(defs, ...Object.values(g));
  container.append(svg);

  let W = Math.max(200, container.clientWidth || 400);
  const H = height;
  const pad = compact ? { l: 38, r: 10, t: 8, b: 18 } : { l: 44, r: 14, t: 12, b: 24 };
  let key = "";
  let liveKey = "";
  let model = null; // {xs, ys, rows, x(), y(), total}
  let hoverLap = null;
  let state = null;

  const liveDot = s("g", { class: "bc-live-dot", style: { display: "none" } }, s("circle", { class: "pulse", r: 7 }), s("circle", { class: "core", r: 3.5 }));
  g.live.append(liveDot);
  const guide = s("line", { class: "bc-guide", y1: pad.t, y2: H - pad.b, style: { display: "none" } });
  const hoverDot = s("circle", { class: "bc-hover-dot", r: 4.5, style: { display: "none" } });
  g.hover.append(guide, hoverDot);

  function render(st) {
    state = st;
    const rows = st.carStates;
    const total = st.totalLaps || 60;
    const k = `${st.epoch}:${st.rev.carState}:${W}:${total}:${st.pitStops.length}:${st.scLaps.size}`;
    if (k !== key) {
      key = k;
      draw(st, rows, total);
    }
    drawLive(st);
  }

  function domain(rows, st) {
    let lo = Infinity;
    let hi = -Infinity;
    const take = (v) => {
      if (isNum(v)) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    };
    for (const r of rows) {
      take(r[signal]);
      const b = r.bounds?.[signal];
      if (b) {
        take(b.lower);
        take(b.upper);
      }
    }
    if (st.telemetry) take(st.telemetry[signal]);
    if (!isFinite(lo)) {
      const mid = signal === "tire_pressure_fl_psi" ? 21 : signal === "engine_temp_c" ? 120 : 100;
      lo = mid - 5;
      hi = mid + 5;
    }
    const minSpan = signal === "tire_pressure_fl_psi" ? 0.8 : 8;
    if (hi - lo < minSpan) {
      const m = (hi + lo) / 2;
      lo = m - minSpan / 2;
      hi = m + minSpan / 2;
    }
    const padV = (hi - lo) * 0.1;
    return [lo - padV, hi + padV];
  }

  function draw(st, rows, total) {
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("width", W);
    svg.setAttribute("height", H);
    const [y0, y1] = domain(rows, st);
    const iw = W - pad.l - pad.r;
    const ih = H - pad.t - pad.b;
    const x = (lap) => pad.l + (clamp(lap, 0, total) / total) * iw;
    const y = (v) => pad.t + (1 - (v - y0) / (y1 - y0)) * ih;
    model = { x, y, total, rows, y0, y1 };
    for (const k of ["grid", "shade", "band", "expected", "area", "actual", "pit", "anom"]) g[k].replaceChildren();

    // grid + axes
    const step = niceStep(y1 - y0, compact ? 3 : 4);
    for (let v = Math.ceil(y0 / step) * step; v <= y1; v += step) {
      const yy = y(v);
      g.grid.append(s("line", { x1: pad.l, x2: W - pad.r, y1: yy, y2: yy, class: "grid-line" }));
      g.grid.append(s("text", { x: pad.l - 6, y: yy, class: "axis-label", "text-anchor": "end", "dominant-baseline": "central" }, fmtNum(v, step < 0.1 ? 2 : step < 1 ? 1 : 0)));
    }
    const lapStep = W < 420 ? 20 : 10;
    for (let l = 0; l <= total; l += lapStep) {
      g.grid.append(s("line", { x1: x(l), x2: x(l), y1: H - pad.b, y2: H - pad.b + 3, class: "axis-tick" }));
      g.grid.append(s("text", { x: x(l), y: H - pad.b + (compact ? 11 : 14), class: "axis-label", "text-anchor": "middle" }, l === 0 ? "" : `L${l}`));
    }
    g.grid.append(s("line", { x1: pad.l, x2: W - pad.r, y1: H - pad.b, y2: H - pad.b, class: "axis-line" }));

    // SC shading
    for (const lap of st.scLaps) g.shade.append(s("rect", { x: x(lap - 1), y: pad.t, width: Math.max(1, x(lap) - x(lap - 1)), height: ih, class: "shade-sc" }));
    // training shading (bounds null)
    let trainStart = null;
    const trainRuns = [];
    rows.forEach((r, i) => {
      const t = !r.bounds?.[signal];
      if (t && trainStart == null) trainStart = r.lap;
      const nextT = rows[i + 1] && !rows[i + 1].bounds?.[signal];
      if (t && !nextT) {
        trainRuns.push([trainStart, r.lap]);
        trainStart = null;
      }
    });
    for (const [a, b] of trainRuns) {
      g.shade.append(s("rect", { x: x(a - 1), y: pad.t, width: Math.max(1, x(b) - x(a - 1)), height: ih, fill: `url(#${id}-hatch)`, class: "shade-train" }));
      if (!compact && x(b) - x(a - 1) > 50) g.shade.append(s("text", { x: (x(a - 1) + x(b)) / 2, y: pad.t + 10, class: "shade-label", "text-anchor": "middle" }, "TRAINING"));
    }

    // band + expected, split into runs where bounds exist
    const runs = [];
    let cur = null;
    for (const r of rows) {
      const b = r.bounds?.[signal];
      if (b && isNum(b.lower) && isNum(b.upper)) {
        if (!cur || r.lap !== cur[cur.length - 1].lap + 1 || (r.pit_stops ?? 0) !== (cur[cur.length - 1].pit_stops ?? 0)) runs.push((cur = []));
        cur.push(r);
      } else cur = null;
    }
    for (const run of runs) {
      const up = run.map((r) => [x(r.lap), y(r.bounds[signal].upper)]);
      const dn = run.map((r) => [x(r.lap), y(r.bounds[signal].lower)]).reverse();
      if (run.length === 1) {
        const [px, pu] = up[0];
        const pl = dn[0][1];
        g.band.append(s("rect", { x: px - 3, y: pu, width: 6, height: Math.max(1, pl - pu), class: "band" }));
      } else g.band.append(s("path", { d: pathFrom(up) + "L" + pathFrom(dn).slice(1) + "Z", class: "band" }));
      g.band.append(s("path", { d: pathFrom(up), class: "band-edge" }), s("path", { d: pathFrom([...dn].reverse()), class: "band-edge" }));
      g.expected.append(s("path", { d: pathFrom(run.map((r) => [x(r.lap), y(r.bounds[signal].expected)])), class: "expected" }));
    }

    // actual series
    const pts = rows.filter((r) => isNum(r[signal])).map((r) => [x(r.lap), y(r[signal])]);
    if (pts.length) {
      if (!compact && pts.length > 1) g.area.append(s("path", { d: pathFrom(pts) + `L${pts[pts.length - 1][0].toFixed(1)},${(H - pad.b).toFixed(1)}L${pts[0][0].toFixed(1)},${(H - pad.b).toFixed(1)}Z`, fill: `url(#${id}-area)` }));
      g.actual.append(s("path", { d: pathFrom(pts), class: "actual" }));
      if (!compact) for (const [px, py] of pts) g.actual.append(s("circle", { cx: px, cy: py, r: 1.6, class: "actual-pt" }));
    }

    // pit markers (hero)
    for (const p of heroPitStops(st)) {
      const px = x(p.lap - 0.5);
      g.pit.append(s("line", { x1: px, x2: px, y1: pad.t, y2: H - pad.b, class: "pit-line" }));
      const tag = s("g", { transform: `translate(${px.toFixed(1)} ${pad.t + 1})` },
        s("rect", { x: -11, y: 0, width: 22, height: 12, rx: 2, class: "pit-tag", style: { fill: compoundColor(p.to_compound) } }),
        s("text", { x: 0, y: 6.5, "text-anchor": "middle", "dominant-baseline": "central", class: "pit-tag-text" }, "PIT"));
      g.pit.append(tag);
    }

    // anomalies
    for (const r of rows) {
      if (!r[sig.anomaly] || !isNum(r[signal])) continue;
      const px = x(r.lap);
      const py = y(r[signal]);
      g.anom.append(
        s("circle", { cx: px, cy: py, r: compact ? 7 : 10, class: "anom-halo" }),
        s("circle", { cx: px, cy: py, r: compact ? 3.5 : 4.5, class: "anom-pt", filter: `url(#${id}-glow)` }),
      );
      if (!compact) {
        const b = r.bounds?.[signal];
        const txt = b ? `+${fmtNum(r[signal] - b.upper, sig.decimals > 1 ? 2 : 1)}${sig.unit === "°C" ? "°" : ""} over` : "ANOMALY";
        const lx = px > W - 90 ? px - 12 : px + 12;
        g.anom.append(s("text", { x: lx, y: py + 4, class: "anom-label", "text-anchor": px > W - 90 ? "end" : "start" }, txt));
      }
    }
    if (hoverLap != null) showHover(hoverLap, false);
    svg.setAttribute("aria-label", ariaSummary(st, rows));
  }

  function ariaSummary(st, rows) {
    const last = rows[rows.length - 1];
    if (!last) return `${sig.label}: no windows yet`;
    const b = last.bounds?.[signal];
    return `${sig.label}, ${rows.length} windows. Lap ${last.lap}: ${fmtNum(last[signal], sig.decimals)} ${sig.unit}` +
      (b ? `, expected ${fmtNum(b.expected, sig.decimals)}, band ${fmtNum(b.lower, sig.decimals)} to ${fmtNum(b.upper, sig.decimals)}` : ", detector training") +
      (last[sig.anomaly] ? ", anomaly." : ".") + " Use arrow keys to inspect laps.";
  }

  function drawLive(st) {
    const t = st.telemetry;
    const k = `${st.rev.telemetry}:${key}`;
    if (k === liveKey) return;
    liveKey = k;
    if (!t || !model || !isNum(t[signal]) || st.raceState === "finished") {
      liveDot.style.display = "none";
      return;
    }
    const px = model.x(t.lap - 1 + (t.lap_fraction || 0));
    const py = model.y(clamp(t[signal], model.y0, model.y1));
    liveDot.style.display = "";
    liveDot.setAttribute("transform", `translate(${px.toFixed(1)} ${py.toFixed(1)})`);
    const lastRow = st.carStates[st.carStates.length - 1];
    const b = lastRow?.bounds?.[signal];
    const out = b && (t[signal] > b.upper || t[signal] < b.lower);
    liveDot.classList.toggle("is-out", !!out);
  }

  // hover / keyboard inspect
  function nearestLap(clientX) {
    const r = svg.getBoundingClientRect();
    const mx = ((clientX - r.left) / r.width) * W;
    const lap = Math.round(((mx - pad.l) / (W - pad.l - pad.r)) * model.total);
    return lap;
  }

  function showHover(lap, withTip = true) {
    if (!model || !state) return;
    const rows = model.rows;
    if (!rows.length) return hideHover();
    const lapClamped = clamp(lap, rows[0].lap, rows[rows.length - 1].lap);
    const r = state.carStateByLap.get(lapClamped);
    if (!r) return;
    hoverLap = lapClamped;
    const px = model.x(r.lap);
    guide.setAttribute("x1", px);
    guide.setAttribute("x2", px);
    guide.style.display = "";
    if (isNum(r[signal])) {
      hoverDot.setAttribute("cx", px);
      hoverDot.setAttribute("cy", model.y(r[signal]));
      hoverDot.style.display = "";
      hoverDot.classList.toggle("is-bad", !!r[sig.anomaly]);
    }
    if (!withTip) return;
    const b = r.bounds?.[signal];
    const tip = h("div", { class: "tip-chart" },
      h("strong", { text: `Lap ${r.lap} · ${fmtNum(r[signal], sig.decimals)} ${sig.unit}` }),
      h("span", { text: b ? `expected ${fmtNum(b.expected, sig.decimals)} · band ${fmtNum(b.lower, sig.decimals)}–${fmtNum(b.upper, sig.decimals)}` : `detector training (${Math.min(stintWindow(state, r, signal), 6)}/6)` }),
      h("span", { class: r[sig.anomaly] ? "tip-bad" : "tip-ok", text: r[sig.anomaly] ? "ANOMALY: outside the band" : b ? "Nominal" : "Learning this stint's normal range" }),
      r.safety_car || state.scLaps.has(r.lap) ? h("span", { class: "tip-muted", text: "Safety car window" }) : null,
      h("span", { class: "tip-muted", text: `${r.tire_compound ?? ""} · ${r.tire_age_laps ?? "?"} laps · P${r.position ?? "?"}` }));
    const sr = svg.getBoundingClientRect();
    const cx = sr.left + (px / W) * sr.width;
    const cy = sr.top + ((isNum(r[signal]) ? model.y(r[signal]) : pad.t) / H) * sr.height;
    showTip(tip, { left: cx - 1, top: cy - 6, width: 2, height: 2, bottom: cy + 6 }, { manual: true });
  }

  function hideHover() {
    hoverLap = null;
    guide.style.display = "none";
    hoverDot.style.display = "none";
    hideTip();
  }

  svg.addEventListener("mousemove", (e) => model && showHover(nearestLap(e.clientX)));
  svg.addEventListener("mouseleave", hideHover);
  svg.addEventListener("blur", hideHover);
  svg.addEventListener("focus", () => {
    const rows = model?.rows || [];
    if (rows.length) showHover(rows[rows.length - 1].lap);
  });
  svg.addEventListener("keydown", (e) => {
    if (!model?.rows.length) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      showHover((hoverLap ?? model.rows[model.rows.length - 1].lap) + (e.key === "ArrowRight" ? 1 : -1));
    } else if (e.key === "Home") showHover(model.rows[0].lap);
    else if (e.key === "End") showHover(model.rows[model.rows.length - 1].lap);
  });

  observeWidth(container, (w) => {
    W = Math.max(200, w);
    key = "";
    if (state) render(state);
  });

  return { update: render };
}

// ---------------------------------------------------------------- position chart
export function createPositionChart(container, { height = 180, rivals = true, label = "Position over laps", ui } = {}) {
  const svg = s("svg", { class: "chart pos-chart", role: "img", tabindex: "0", "aria-label": label });
  const defs = s("defs");
  const gid = `pc${++chartSeq}`;
  defs.innerHTML = `<filter id="${gid}-glow" x="-10%" y="-30%" width="120%" height="160%"><feGaussianBlur stdDeviation="2.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`;
  const gGrid = s("g");
  const gShade = s("g");
  const gRivals = s("g", { class: "pc-rivals" });
  const gFocus = s("g");
  const gHero = s("g");
  const gMarks = s("g");
  const guide = s("line", { class: "bc-guide", style: { display: "none" } });
  svg.append(defs, gGrid, gShade, gRivals, gFocus, gHero, gMarks, guide);
  container.append(svg);
  let W = Math.max(200, container.clientWidth || 400);
  const H = height;
  const pad = { l: 34, r: 12, t: 10, b: 22 };
  let key = "";
  let model = null;
  let state = null;
  let hoverLap = null;

  function render(st) {
    state = st;
    const focus = ui?.focusCar ?? null;
    const k = `${st.epoch}:${st.rev.standings}:${W}:${focus}:${st.totalLaps}`;
    if (k === key) return;
    key = k;
    draw(st, focus);
  }

  function draw(st, focus) {
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("width", W);
    svg.setAttribute("height", H);
    const total = st.totalLaps || 60;
    const n = Math.max(st.cars.size, 2);
    const iw = W - pad.l - pad.r;
    const ih = H - pad.t - pad.b;
    const x = (lap) => pad.l + (lap / total) * iw;
    const y = (p) => pad.t + ((p - 1) / (n - 1)) * ih;
    model = { x, y, total, n };
    for (const gg of [gGrid, gShade, gRivals, gFocus, gHero, gMarks]) gg.replaceChildren();
    guide.setAttribute("y1", pad.t);
    guide.setAttribute("y2", H - pad.b);
    for (const p of [1, 5, 10, 15, 20].filter((p) => p <= n)) {
      gGrid.append(s("line", { x1: pad.l, x2: W - pad.r, y1: y(p), y2: y(p), class: "grid-line" }), s("text", { x: pad.l - 6, y: y(p), class: "axis-label", "text-anchor": "end", "dominant-baseline": "central" }, `P${p}`));
    }
    const lapStep = W < 420 ? 20 : 10;
    for (let l = lapStep; l <= total; l += lapStep) gGrid.append(s("text", { x: x(l), y: H - pad.b + 14, class: "axis-label", "text-anchor": "middle" }, `L${l}`));
    for (const lap of st.scLaps) gShade.append(s("rect", { x: x(lap - 1), y: pad.t, width: Math.max(1, x(lap) - x(lap - 1)), height: ih, class: "shade-sc" }));

    const series = (car) => {
      const pts = [];
      if (isNum(car.start_position)) pts.push([x(0), y(car.start_position)]);
      for (let l = 1; l < car.positions.length; l++) if (isNum(car.positions[l])) pts.push([x(l), y(car.positions[l])]);
      return pts;
    };
    if (rivals) {
      for (const car of st.cars.values()) {
        if (car.car_number === st.ourCar || car.car_number === focus) continue;
        const pts = series(car);
        if (pts.length > 1) gRivals.append(s("path", { d: pathFrom(pts), class: "pc-rival", stroke: car.team_color }));
      }
    }
    if (focus != null && focus !== st.ourCar) {
      const car = st.cars.get(focus);
      if (car) {
        const pts = series(car);
        if (pts.length > 1) gFocus.append(s("path", { d: pathFrom(pts), class: "pc-focus", stroke: car.team_color }));
      }
    }
    const hero = st.cars.get(st.ourCar);
    if (hero) {
      const pts = series(hero);
      if (pts.length > 1) gHero.append(s("path", { d: pathFrom(pts), class: "pc-hero", filter: `url(#${gid}-glow)` }));
      if (pts.length) {
        const [lx, ly] = pts[pts.length - 1];
        gHero.append(s("circle", { cx: lx, cy: ly, r: 4, class: "pc-hero-end" }));
        const pos = hero.row?.position;
        if (isNum(pos)) gHero.append(s("text", { x: Math.min(lx + 8, W - pad.r - 2), y: ly, class: "pc-hero-label", "text-anchor": lx + 30 > W ? "end" : "start", "dominant-baseline": "central" }, `P${pos}`));
      }
      for (const p of heroPitStops(st)) {
        const pos = hero.positions[p.lap];
        if (!isNum(pos)) continue;
        gMarks.append(
          s("circle", { cx: x(p.lap), cy: y(pos), r: 7, class: "pc-pit", style: { stroke: compoundColor(p.to_compound) } }),
          s("text", { x: x(p.lap), y: y(pos) + 0.5, class: "pc-pit-text", "text-anchor": "middle", "dominant-baseline": "central" }, "P"),
        );
      }
    }
    const pos = hero?.row?.position;
    svg.setAttribute("aria-label", `${label}. ${hero ? `Our car started P${hero.start_position ?? "?"}${isNum(pos) ? `, now P${pos}` : ""}.` : "No data yet."} Use arrow keys to inspect laps.`);
    if (hoverLap != null) showHover(hoverLap);
  }

  function showHover(lap) {
    if (!model || !state) return;
    const hero = state.cars.get(state.ourCar);
    if (!hero) return;
    const maxLap = Math.max(0, hero.positions.length - 1);
    lap = clamp(lap, 0, maxLap);
    hoverLap = lap;
    const px = model.x(lap);
    guide.setAttribute("x1", px);
    guide.setAttribute("x2", px);
    guide.style.display = "";
    const pos = lap === 0 ? hero.start_position : hero.positions[lap];
    const focus = ui?.focusCar != null && ui.focusCar !== state.ourCar ? state.cars.get(ui.focusCar) : null;
    const leader = getOrder(state)[0];
    const tip = h("div", { class: "tip-chart" },
      h("strong", { text: lap === 0 ? `Grid · P${pos ?? "?"}` : `Lap ${lap} · P${pos ?? "?"}` }),
      lap > 0 && isNum(hero.gaps[lap]) ? h("span", { text: `${hero.gaps[lap] > 0 ? `+${hero.gaps[lap].toFixed(1)}s to leader` : "Leading"}` }) : null,
      focus ? h("span", { class: "tip-muted", text: `${focus.driver_code}: P${lap === 0 ? focus.start_position : focus.positions[lap] ?? "?"}` }) : null,
      heroPitStops(state).some((p) => p.lap === lap) ? h("span", { class: "tip-ok", text: "Pit stop" }) : null,
      leader && lap === maxLap && leader.car_number !== state.ourCar ? h("span", { class: "tip-muted", text: `Leader: ${leader.driver_code}` }) : null);
    const sr = svg.getBoundingClientRect();
    const cx = sr.left + (px / W) * sr.width;
    const cy = sr.top + ((isNum(pos) ? model.y(pos) : pad.t) / H) * sr.height;
    showTip(tip, { left: cx - 1, top: cy - 6, width: 2, height: 2, bottom: cy + 6 }, { manual: true });
  }

  function hide() {
    hoverLap = null;
    guide.style.display = "none";
    hideTip();
  }

  svg.addEventListener("mousemove", (e) => {
    if (!model) return;
    const r = svg.getBoundingClientRect();
    const mx = ((e.clientX - r.left) / r.width) * W;
    showHover(Math.round(((mx - pad.l) / (W - pad.l - pad.r)) * model.total));
  });
  svg.addEventListener("mouseleave", hide);
  svg.addEventListener("blur", hide);
  svg.addEventListener("focus", () => state && showHover(state.cars.get(state.ourCar)?.positions.length - 1 || 0));
  svg.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      showHover((hoverLap ?? 0) + (e.key === "ArrowRight" ? 1 : -1));
    }
  });

  observeWidth(container, (w) => {
    W = Math.max(200, w);
    key = "";
    if (state) render(state);
  });

  return { update: render, setAttr: (k, v) => setAttr(svg, k, v) };
}
