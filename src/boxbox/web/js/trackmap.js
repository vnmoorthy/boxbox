// Track map: equirectangular projection of a circuit geojson fit to the panel, glowing
// track, start/finish, sectors, and every car animated at 60 fps.
//   hero:   lap_fraction from telemetry, extrapolated between readings and eased.
//   others: hero_fraction + (hero.gap - car.gap) / lap_time, gliding when gaps update.

import { s, $, setText, toggleClass, setAttr } from "./dom.js";
import { getOrder, heroCar } from "./store.js";
import { isNum, clamp } from "./format.js";

const TAU = Math.PI * 2;

export function createTrackMap({ root, store, source, ui, onFocusCar }) {
  const svg = s("svg", { class: "map-svg", role: "img", "aria-label": "Track map with live car positions" });
  const defs = s("defs");
  defs.innerHTML = `
    <filter id="trk-glow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="4" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="trk-bloom" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="10"/></filter>
    <radialGradient id="hero-halo">
      <stop offset="0" stop-color="#12e3a5" stop-opacity=".55"/>
      <stop offset=".55" stop-color="#12e3a5" stop-opacity=".16"/>
      <stop offset="1" stop-color="#12e3a5" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="trail-grad" gradientUnits="userSpaceOnUse"/>
    <pattern id="checker" width="4" height="4" patternUnits="userSpaceOnUse">
      <rect width="4" height="4" fill="#f4f6f8"/><rect width="2" height="2" fill="#0b0d10"/><rect x="2" y="2" width="2" height="2" fill="#0b0d10"/>
    </pattern>`;
  const gTrack = s("g", { class: "trk" });
  const gTrail = s("g", { class: "trail" });
  const trail = s("path", { class: "hero-trail" });
  gTrail.append(trail);
  const gCars = s("g", { class: "cars" });
  const scCar = s("g", { class: "sc-car", style: { display: "none" } }, s("circle", { r: 6 }), s("text", { y: -11, "text-anchor": "middle" }, "SC"));
  svg.append(defs, gTrack, gTrail, gCars, scCar);
  root.prepend(svg);

  const scChip = $("#sc-chip");
  const hud = {
    speed: $("#hud-speed"),
    throttle: $("#hud-throttle"),
    brake: $("#hud-brake"),
    drs: $("#hud-drs"),
    lap: $("#hud-lap"),
    wrap: $("#hud"),
  };

  let geo = null; // [[lon, lat], ...]
  let pts = []; // projected [x, y]
  let cum = null; // cumulative distance
  let total = 0;
  let W = 0;
  let H = 0;
  let circuitKey = null;
  let loadToken = 0;

  const cars = new Map(); // car_number -> {g, dot, ring, label, pit, off}
  let epoch = -1;
  let heroP = null;
  let lastFrame = 0;
  let lapTime = 90;
  let shownSpeed = null;
  let lastRev = -1;
  let lastFocus = undefined;

  // ------------------------------------------------------------ circuit
  async function setCircuit(key) {
    if (!key || key === circuitKey) return;
    circuitKey = key;
    const token = ++loadToken;
    root.classList.add("is-loading");
    try {
      const r = await fetch(new URL(`circuits/${encodeURIComponent(key)}.geojson`, location.href));
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (token !== loadToken) return;
      const feat = j.type === "FeatureCollection" ? j.features.find((f) => f.geometry?.type === "LineString") : j;
      const coords = feat?.geometry?.coordinates || [];
      if (coords.length < 3) throw new Error("no LineString");
      geo = coords;
      layout();
    } catch (e) {
      console.warn("circuit load failed", key, e);
      geo = null;
      gTrack.replaceChildren();
    } finally {
      if (token === loadToken) root.classList.remove("is-loading");
    }
  }

  function layout() {
    const rect = root.getBoundingClientRect();
    W = Math.max(10, Math.round(rect.width));
    H = Math.max(10, Math.round(rect.height));
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    if (!geo) return;
    let lat0 = 0;
    for (const c of geo) lat0 += c[1];
    lat0 = (lat0 / geo.length) * (Math.PI / 180);
    const kx = Math.cos(lat0);
    let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
    const raw = geo.map(([lon, lat]) => {
      const x = lon * kx;
      const y = -lat;
      if (x < minx) minx = x;
      if (x > maxx) maxx = x;
      if (y < miny) miny = y;
      if (y > maxy) maxy = y;
      return [x, y];
    });
    const padX = Math.max(30, W * 0.07);
    const padTop = Math.max(34, H * 0.09);
    const padBot = Math.max(34, H * 0.09);
    const sc = Math.min((W - 2 * padX) / (maxx - minx || 1), (H - padTop - padBot) / (maxy - miny || 1));
    const ox = (W - (maxx - minx) * sc) / 2;
    const oy = padTop + (H - padTop - padBot - (maxy - miny) * sc) / 2;
    pts = raw.map(([x, y]) => [ox + (x - minx) * sc, oy + (y - miny) * sc]);
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (Math.hypot(first[0] - last[0], first[1] - last[1]) > 0.5) pts.push([first[0], first[1]]);
    cum = new Float64Array(pts.length);
    for (let i = 1; i < pts.length; i++) cum[i] = cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    total = cum[pts.length - 1];
    drawTrack();
    lastRev = -1;
  }

  function pointAt(frac) {
    let f = frac % 1;
    if (f < 0) f += 1;
    const d = f * total;
    let lo = 0;
    let hi = cum.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= d) lo = mid;
      else hi = mid;
    }
    const seg = cum[hi] - cum[lo] || 1;
    const t = (d - cum[lo]) / seg;
    const a = pts[lo];
    const b = pts[hi];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    return { x: a[0] + dx * t, y: a[1] + dy * t, tx: dx / len, ty: dy / len };
  }

  function polyline(f0, f1, n) {
    let d = "";
    for (let i = 0; i <= n; i++) {
      const p = pointAt(f0 + ((f1 - f0) * i) / n);
      d += (i ? "L" : "M") + p.x.toFixed(1) + "," + p.y.toFixed(1);
    }
    return d;
  }

  function segmentPath(f0, f1) {
    // exact vertices between f0 and f1 (no wrap)
    const a = pointAt(f0);
    let d = `M${a.x.toFixed(1)},${a.y.toFixed(1)}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const fi = cum[i] / total;
      if (fi > f0 && fi < f1) d += `L${pts[i][0].toFixed(1)},${pts[i][1].toFixed(1)}`;
    }
    const b = pointAt(f1 >= 1 ? 0.99999 : f1);
    return d + `L${b.x.toFixed(1)},${b.y.toFixed(1)}`;
  }

  function drawTrack() {
    gTrack.replaceChildren();
    const d = "M" + pts.map((p) => p[0].toFixed(1) + "," + p[1].toFixed(1)).join("L") + "Z";
    const w = clamp(Math.min(W, H) / 46, 7, 13);
    gTrack.append(
      s("path", { d, class: "trk-bloom", "stroke-width": w * 3.2, filter: "url(#trk-bloom)" }),
      s("path", { d, class: "trk-edge", "stroke-width": w + 3 }),
      s("path", { d, class: "trk-asphalt", "stroke-width": w }),
    );
    const sectors = [
      [0, 1 / 3, "s1"],
      [1 / 3, 2 / 3, "s2"],
      [2 / 3, 1, "s3"],
    ];
    for (const [a, b, cls] of sectors) gTrack.append(s("path", { d: segmentPath(a, b), class: `trk-line ${cls}`, filter: "url(#trk-glow)" }));
    // sector boundaries
    for (const [f, label] of [[1 / 3, "S2"], [2 / 3, "S3"]]) {
      const p = pointAt(f);
      const nx = -p.ty;
      const ny = p.tx;
      gTrack.append(
        s("line", { x1: p.x - nx * w * 0.9, y1: p.y - ny * w * 0.9, x2: p.x + nx * w * 0.9, y2: p.y + ny * w * 0.9, class: "trk-tick" }),
        s("text", { x: p.x + nx * (w + 10), y: p.y + ny * (w + 10), class: "trk-label", "text-anchor": "middle", "dominant-baseline": "central" }, label),
      );
    }
    // start / finish line
    const p0 = pointAt(0);
    const ang = (Math.atan2(p0.ty, p0.tx) * 180) / Math.PI;
    const sf = s("g", { class: "trk-sf", transform: `translate(${p0.x.toFixed(1)} ${p0.y.toFixed(1)}) rotate(${ang.toFixed(1)})` });
    sf.append(s("rect", { x: -2.5, y: -w * 1.05, width: 5, height: w * 2.1, fill: "url(#checker)", stroke: "#0b0d10", "stroke-width": 0.6 }));
    gTrack.append(sf);
    const nx0 = -p0.ty;
    const ny0 = p0.tx;
    gTrack.append(s("text", { x: p0.x - nx0 * (w + 12), y: p0.y - ny0 * (w + 12), class: "trk-label trk-sf-label", "text-anchor": "middle", "dominant-baseline": "central" }, "S/F"));
    // direction chevron
    const pa = pointAt(0.035);
    const a2 = (Math.atan2(pa.ty, pa.tx) * 180) / Math.PI;
    gTrack.append(s("path", { d: "M-4,-4 L2,0 L-4,4", class: "trk-dir", transform: `translate(${pa.x.toFixed(1)} ${pa.y.toFixed(1)}) rotate(${a2.toFixed(1)})` }));
  }

  // ------------------------------------------------------------ cars
  function makeCar(car, isHero) {
    const g = s("g", { class: isHero ? "car car-hero" : "car" });
    let halo = null;
    let label = null;
    if (isHero) {
      halo = s("circle", { class: "car-halo", r: 17, fill: "url(#hero-halo)" });
      g.append(halo);
    }
    const ring = s("circle", { class: "car-ring", r: isHero ? 11 : 9 });
    const dot = s("circle", { class: "car-dot", r: isHero ? 7 : 5, fill: car.team_color });
    g.append(ring, dot);
    if (isHero) {
      label = s("g", { class: "car-tag", transform: "translate(0 -21)" }, s("rect", { x: -13, y: -8, width: 26, height: 15, rx: 3 }), s("text", { y: 0.5, "text-anchor": "middle", "dominant-baseline": "central" }, String(car.car_number)));
    } else {
      label = s("g", { class: "car-code", transform: "translate(0 -15)" }, s("text", { "text-anchor": "middle", "dominant-baseline": "central" }, car.driver_code));
    }
    const pit = s("g", { class: "car-pit", transform: `translate(${isHero ? 16 : 12} 0)`, style: { display: "none" } }, s("rect", { x: 0, y: -6, width: 22, height: 12, rx: 2 }), s("text", { x: 11, y: 0.5, "text-anchor": "middle", "dominant-baseline": "central" }, "PIT"));
    g.append(label, pit);
    const title = s("title", {}, `${car.driver_code} · ${car.driver}`);
    g.append(title);
    g.addEventListener("click", () => onFocusCar(car.car_number));
    const rec = { g, dot, ring, label, pit, title, off: null, x: 0, y: 0, isHero, inPit: false, lane: 0 };
    cars.set(car.car_number, rec);
    if (isHero) gCars.append(g);
    else gCars.prepend(g);
    return rec;
  }

  function computeLapTime(state) {
    const hero = heroCar(state);
    if (!hero) return 90;
    const xs = [];
    for (let l = state.lap; l > state.lap - 6 && l > 0; l--) {
      const t = hero.lapTimes[l];
      if (isNum(t) && t > 50 && t < 160) xs.push(t);
    }
    if (!xs.length) return 90;
    xs.sort((a, b) => a - b);
    return xs[Math.floor(xs.length / 2)];
  }

  function update(state) {
    if (state.epoch !== epoch) {
      epoch = state.epoch;
      for (const c of cars.values()) c.g.remove();
      cars.clear();
      heroP = null;
      lastRev = -1;
    }
    const sc = state.flag === "SC";
    toggleClass(svg, "is-sc", sc);
    if (scChip) scChip.hidden = !sc;
    toggleClass(svg, "is-finished", state.raceState === "finished");
    if (lastRev === state.rev.standings && lastFocus === ui.focusCar) return;
    lastRev = state.rev.standings;
    lastFocus = ui.focusCar;
    lapTime = computeLapTime(state);
    for (const car of state.cars.values()) {
      const isHero = car.car_number === state.ourCar;
      const rec = cars.get(car.car_number) || makeCar(car, isHero);
      rec.dot.setAttribute("fill", car.team_color);
      const inPit = !!car.row?.in_pit_lane;
      if (inPit !== rec.inPit) {
        rec.inPit = inPit;
        rec.pit.style.display = inPit ? "" : "none";
      }
      const focused = ui.focusCar === car.car_number;
      toggleClass(rec.g, "is-focus", focused);
      if (focused) gCars.append(rec.g); // on top
    }
    const heroRec = cars.get(state.ourCar);
    if (heroRec && ui.focusCar !== state.ourCar) gCars.append(heroRec.g);
  }

  function frame(now) {
    const dt = lastFrame ? Math.min(100, now - lastFrame) : 16;
    lastFrame = now;
    if (!pts.length) return;
    const state = store.state;
    const tel = state.telemetry;
    const order = getOrder(state);
    if (!order.length) {
      trail.setAttribute("d", "");
      return;
    }
    const hero = heroCar(state);
    const gridMode = !tel;

    if (!gridMode) {
      const base = tel.lap - 1 + (tel.lap_fraction || 0);
      const paused = source.isPaused() || state.raceState === "finished" || state.raceState === "idle";
      const lapMs = Math.max(200, source.lapWallMs());
      const ahead = paused ? 0 : clamp((now - state.telemetryAt) / lapMs, 0, 0.11);
      const target = base + ahead;
      if (heroP == null || Math.abs(target - heroP) > 0.5) heroP = target;
      else {
        const k = 1 - Math.exp(-dt / 110);
        const next = heroP + (target - heroP) * k;
        if (next >= heroP || heroP - target > 0.05) heroP = next;
      }
    }

    const heroGap = hero?.row?.gap_to_leader_sec ?? 0;
    const kGlide = 1 - Math.exp(-dt / 450);
    let leaderFrac = null;
    for (const car of order) {
      const rec = cars.get(car.car_number);
      if (!rec) continue;
      let frac;
      let lateral = 0;
      if (gridMode) {
        const sp = car.start_position ?? 1;
        frac = 1 - 0.0055 * sp - 0.004;
        lateral = sp % 2 ? -4 : 4;
      } else {
        const target = car.car_number === state.ourCar ? 0 : (heroGap - (car.row?.gap_to_leader_sec ?? heroGap)) / lapTime;
        if (rec.off == null || Math.abs(target - rec.off) > 3) rec.off = target;
        else rec.off += (target - rec.off) * kGlide;
        frac = heroP + rec.off;
        if (rec.inPit) lateral = 11;
      }
      const p = pointAt(frac);
      const x = p.x - p.ty * lateral;
      const y = p.y + p.tx * lateral;
      if (Math.abs(x - rec.x) > 0.05 || Math.abs(y - rec.y) > 0.05) {
        rec.x = x;
        rec.y = y;
        rec.g.setAttribute("transform", `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
      }
      if (car.row?.position === 1 || (leaderFrac == null && gridMode)) leaderFrac = frac;
    }

    // safety car just ahead of the leader
    if (state.flag === "SC" && leaderFrac != null) {
      const p = pointAt(leaderFrac + 0.014);
      scCar.style.display = "";
      scCar.setAttribute("transform", `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`);
    } else if (scCar.style.display !== "none") scCar.style.display = "none";

    // hero trail
    if (!gridMode && heroP != null) trail.setAttribute("d", polyline(heroP - 0.045, heroP, 18));
    else trail.setAttribute("d", "");

    // HUD speed eases toward the latest reading
    if (tel && isNum(tel.speed_kph)) {
      shownSpeed = shownSpeed == null ? tel.speed_kph : shownSpeed + (tel.speed_kph - shownSpeed) * (1 - Math.exp(-dt / 140));
      setText(hud.speed, String(Math.round(shownSpeed)));
    }
  }

  function updateHud(state) {
    const t = state.telemetry;
    toggleClass(hud.wrap, "is-empty", !t);
    if (!t) {
      setText(hud.speed, "–");
      shownSpeed = null;
      hud.throttle.style.transform = "scaleX(0)";
      hud.brake.style.transform = "scaleX(0)";
      toggleClass(hud.drs, "is-on", false);
      setText(hud.lap, "");
      return;
    }
    hud.throttle.style.transform = `scaleX(${clamp((t.throttle_pct ?? 0) / 100, 0, 1)})`;
    hud.brake.style.transform = `scaleX(${clamp((t.brake_pct ?? 0) / 100, 0, 1)})`;
    toggleClass(hud.drs, "is-on", !!t.drs_active);
    setAttr(hud.drs, "aria-label", t.drs_active ? "DRS open" : "DRS closed");
    setText(hud.lap, `L${t.lap} · ${Math.round((t.lap_fraction ?? 0) * 100)}%`);
  }

  const ro = new ResizeObserver(() => layout());
  ro.observe(root);

  return {
    setCircuit,
    update(state) {
      update(state);
      updateHud(state);
    },
    frame,
    get circuit() {
      return circuitKey;
    },
  };
}
