// Timing tower: 22 rows created once, positioned with translateY so position changes slide.
// Cells are updated in place; nothing is rebuilt on a telemetry tick.

import { $, h, setText, setAttr, toggleClass, tyreIcon, updateTyreIcon } from "./dom.js";
import { getOrder, heroPitStops } from "./store.js";
import { fmtGap, isNum, fmtLapTime } from "./format.js";

export function createTower({ ui, onFocusCar }) {
  const body = $("#tower-body");
  const toggle = $("#gap-toggle");
  const gapHead = $("#gap-head");
  const empty = $("#tower-empty");
  const rows = new Map(); // car_number -> row record
  let epoch = -1;
  let lastRev = -1;
  let lastMode = null;
  let lastFocus = null;
  let rowH = 0;

  function measure() {
    const v = getComputedStyle(body).getPropertyValue("--row-h");
    rowH = parseFloat(v) || 26;
  }
  measure();
  window.addEventListener("resize", () => {
    const before = rowH;
    measure();
    if (before !== rowH) lastRev = -1;
  });

  toggle.addEventListener("click", () => {
    ui.gapMode = ui.gapMode === "leader" ? "interval" : "leader";
    ui.dirty = true;
  });

  function makeRow(car) {
    const pos = h("span", { class: "t-pos" });
    const bar = h("span", { class: "t-bar" });
    const code = h("span", { class: "t-code" });
    const num = h("span", { class: "t-num" });
    const tyre = tyreIcon(null, 16);
    const age = h("span", { class: "t-age" });
    const gap = h("span", { class: "t-gap" });
    const stops = h("span", { class: "t-stops" });
    const flag = h("span", { class: "t-flag" });
    const el = h(
      "button",
      { class: "trow", type: "button", role: "listitem" },
      pos,
      bar,
      h("span", { class: "t-driver" }, code, num),
      h("span", { class: "t-tyre" }, tyre, age),
      gap,
      stops,
      flag,
    );
    el.addEventListener("click", () => onFocusCar(car.car_number));
    body.append(el);
    const r = { el, pos, bar, code, num, tyre, age, gap, stops, flag, changeSeq: car.posChangeSeq, flagTimer: null, y: null };
    rows.set(car.car_number, r);
    return r;
  }

  function showChange(r, delta) {
    clearTimeout(r.flagTimer);
    r.flag.dataset.kind = delta > 0 ? "up" : "down";
    setText(r.flag, `${delta > 0 ? "▲" : "▼"}${Math.abs(delta)}`);
    r.el.classList.remove("is-gain", "is-loss");
    void r.el.offsetWidth;
    r.el.classList.add(delta > 0 ? "is-gain" : "is-loss");
    r.flagTimer = setTimeout(() => {
      r.flag.dataset.kind = "";
      setText(r.flag, "");
      r.el.classList.remove("is-gain", "is-loss");
      r.flagTimer = null;
      lastRev = -1;
    }, 4000);
  }

  function update(state) {
    if (state.epoch !== epoch) {
      epoch = state.epoch;
      for (const r of rows.values()) {
        clearTimeout(r.flagTimer);
        r.el.remove();
      }
      rows.clear();
      lastRev = -1;
    }
    if (lastRev === state.rev.standings && lastMode === ui.gapMode && lastFocus === ui.focusCar && state.cars.size === rows.size) return;
    lastRev = state.rev.standings;
    lastMode = ui.gapMode;
    lastFocus = ui.focusCar;

    setText(gapHead, ui.gapMode === "leader" ? "GAP" : "INT");
    setAttr(toggle, "aria-label", ui.gapMode === "leader" ? "Showing gap to leader. Switch to interval" : "Showing interval to car ahead. Switch to gap to leader");
    toggle.dataset.tip = ui.gapMode === "leader" ? "Gap to leader · click for interval" : "Interval to car ahead · click for gap to leader";

    const order = getOrder(state);
    empty.hidden = order.length > 0;
    body.style.height = `${order.length * rowH}px`;
    order.forEach((car, i) => {
      const r = rows.get(car.car_number) || makeRow(car);
      const row = car.row;
      const position = row?.position ?? car.start_position ?? i + 1;
      const y = i * rowH;
      if (r.y !== y) {
        r.el.style.transform = `translateY(${y}px)`;
        r.y = y;
      }
      setText(r.pos, String(position));
      r.bar.style.background = car.team_color;
      setText(r.code, car.driver_code);
      setText(r.num, String(car.car_number));
      updateTyreIcon(r.tyre, row?.tire_compound ?? car.start_tire ?? "SOFT");
      setText(r.age, row ? String(row.tire_age_laps ?? 0) : "0");
      let gapText = "—";
      if (row) {
        if (position === 1) gapText = "LEADER";
        else gapText = fmtGap(ui.gapMode === "leader" ? row.gap_to_leader_sec : row.gap_to_ahead_sec);
      }
      setText(r.gap, gapText);
      toggleClass(r.gap, "is-leader", gapText === "LEADER");
      const nStops = row?.pit_stops ?? 0;
      setText(r.stops, String(nStops));
      toggleClass(r.stops, "is-zero", !nStops);
      const isHero = car.car_number === state.ourCar;
      toggleClass(r.el, "is-hero", isHero);
      toggleClass(r.el, "is-focus", ui.focusCar === car.car_number);
      setAttr(r.el, "aria-pressed", ui.focusCar === car.car_number ? "true" : "false");
      const inPit = !!row?.in_pit_lane;
      toggleClass(r.el, "in-pit", inPit);
      if (car.posChangeSeq !== r.changeSeq) {
        r.changeSeq = car.posChangeSeq;
        if (car.posDelta) showChange(r, car.posDelta);
      }
      if (inPit) {
        r.flag.dataset.kind = "pit";
        setText(r.flag, "PIT");
      } else if (!r.flagTimer) {
        r.flag.dataset.kind = "";
        setText(r.flag, "");
      }
      const lastLap = isNum(row?.last_lap_time_sec) ? `, last lap ${fmtLapTime(row.last_lap_time_sec)}` : "";
      setAttr(
        r.el,
        "aria-label",
        `P${position} ${car.driver}, ${car.team}${isHero ? " (our car)" : ""}, ${gapText === "LEADER" ? "leader" : `gap ${gapText}`}, ` +
          `${row?.tire_compound ?? car.start_tire ?? ""} tyres ${row?.tire_age_laps ?? 0} laps, ${nStops} stops${inPit ? ", in pit lane" : ""}${lastLap}. Track on map.`,
      );
    });
    // the hero's pit count is also shown in the panel header
    const hero = state.cars.get(state.ourCar);
    const hp = $("#tower-hero");
    if (hp) setText(hp, hero?.row ? `#${state.ourCar} P${hero.row.position} · ${heroPitStops(state).length} stop${heroPitStops(state).length === 1 ? "" : "s"}` : "");
  }

  return { update, measure };
}
