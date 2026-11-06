// Strategy timeline: one cell per lap coloured by the strategist's call, with anomaly,
// pit-stop, scenario and safety-car markers and a current-lap cursor. Cells update in place.

import { $, h, icon, iconName, setText, setAttr, toggleClass, setDisabled } from "./dom.js";
import { decisionClass, compoundColor, SIGNALS, stripBold, firstSentence } from "./format.js";

export function createTimeline({ onOpenDecision }) {
  const grid = $("#tl-grid");
  const axis = $("#tl-axis");
  const cursor = $("#tl-cursor");
  let cells = [];
  let total = 0;
  let key = "";

  function build(n) {
    total = n;
    grid.style.setProperty("--laps", n);
    axis.style.setProperty("--laps", n);
    cells = [];
    grid.replaceChildren();
    axis.replaceChildren();
    for (let lap = 1; lap <= n; lap++) {
      const top = h("span", { class: "tl-top" });
      const bar = h("span", { class: "tl-bar" });
      const bot = h("span", { class: "tl-bot" });
      const b = h("button", { class: "tl-cell", type: "button", dataset: { lap: String(lap) } }, top, bar, bot);
      b.addEventListener("click", () => {
        if (b.getAttribute("aria-disabled") === "true") return;
        onOpenDecision(lap);
      });
      grid.append(b);
      cells.push({ b, top, bar, bot, sig: "" });
      axis.append(h("span", { class: lap % 5 === 0 || lap === 1 ? "tl-num is-major" : "tl-num", text: lap % 5 === 0 || lap === 1 ? String(lap) : "" }));
    }
    grid.append(cursor);
  }

  function update(state) {
    const n = state.totalLaps || 60;
    const k = `${state.epoch}:${n}:${state.rev.decisions}:${state.rev.carState}:${state.rev.events}:${state.lap}:${state.flag}`;
    if (k === key) return;
    key = k;
    if (n !== total) build(n);
    const hero = state.cars.get(state.ourCar);
    const pitByLap = new Map();
    for (const p of state.pitStops) if (Number(p.car_number) === state.ourCar) pitByLap.set(p.lap, p);
    const scenByLap = new Map();
    for (const sc of state.scenarios) if (sc.kind !== "safety_car") scenByLap.set(sc.lap, sc);
    const boxByLap = new Map(state.boxCalls.map((b) => [b.lap, b]));
    for (let i = 0; i < cells.length; i++) {
      const lap = i + 1;
      const c = cells[i];
      const d = state.decisionByLap.get(lap);
      const anomalies = state.anomalyLaps.get(lap);
      const pit = pitByLap.get(lap);
      const scen = scenByLap.get(lap);
      const sc = state.scLaps.has(lap);
      const cls = d ? decisionClass(d.suggestion) : "none";
      const sig = `${cls}|${anomalies ? anomalies.join(",") : ""}|${pit ? pit.to_compound : ""}|${scen ? scen.kind : ""}|${sc}|${lap === state.lap}|${lap > state.lap}`;
      if (sig === c.sig) continue;
      c.sig = sig;
      c.b.dataset.call = cls;
      toggleClass(c.b, "is-sc", sc);
      toggleClass(c.b, "is-current", lap === state.lap);
      toggleClass(c.b, "is-future", lap > state.lap);
      // top: anomaly / scenario
      c.top.replaceChildren();
      if (scen) c.top.append(h("span", { class: "tl-scn" }, icon(iconName(null, scen.kind), { size: 11 })));
      if (anomalies) c.top.append(h("span", { class: "tl-anom", text: "▲", "aria-hidden": "true" }));
      // bottom: pit stop
      c.bot.replaceChildren();
      if (pit) c.bot.append(h("span", { class: "tl-pit", text: "P", style: { "--c": compoundColor(pit.to_compound) } }));
      const parts = [`Lap ${lap}`];
      if (d) parts.push(`${d.suggestion}: ${firstSentence(stripBold(d.condition_summary), 90)}`);
      else parts.push(lap > state.lap ? "not raced yet" : "no decision yet");
      if (hero && hero.positions[lap]) parts.push(`P${hero.positions[lap]}`);
      if (anomalies) parts.push(`Anomaly: ${anomalies.map((k) => SIGNALS[k]?.label ?? k).join(", ")}`);
      if (pit) parts.push(`Pit stop ${pit.from_compound} → ${pit.to_compound}`);
      if (boxByLap.get(lap)) parts.push(`Box call (${boxByLap.get(lap).by})`);
      if (scen) parts.push(`${scen.label}${scen.source === "scripted" ? " (scripted)" : ""}`);
      if (sc) parts.push("Safety car");
      const tip = parts.join(" · ");
      c.b.dataset.tip = tip;
      setAttr(c.b, "aria-label", d ? `${tip}. Open decision` : tip);
      setDisabled(c.b, !d);
    }
    const cur = Math.min(Math.max(state.lap, 0), n);
    cursor.hidden = !cur;
    if (cur) cursor.style.setProperty("--lap", cur);
  }

  return { update };
}
