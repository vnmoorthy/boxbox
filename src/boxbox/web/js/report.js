// Post-race report modal: classification, hero summary, decisions breakdown, position chart.

import { h, icon, openModal } from "./dom.js";
import { createPositionChart } from "./charts.js";
import { heroSummary, heroPitStops } from "./store.js";
import { fmtMs, isNum, DECISIONS, DECISION_COLORS, decisionClass, SIGNALS } from "./format.js";

export function openReport({ getState, source, actions }) {
  const state = getState();
  const fin = state.finish;
  const sum = fin?.summary || heroSummary(state);
  const results = (fin?.results || []).slice().sort((a, b) => a.position - b.position);
  const hero = state.cars.get(state.ourCar);
  const heroResult = results.find((r) => Number(r.car_number) === state.ourCar);
  const top = results.slice(0, 10);
  const showHeroExtra = heroResult && heroResult.position > 10;

  const codeOf = (r) => r.driver_code || state.cars.get(Number(r.car_number))?.driver_code || String(r.car_number);
  const row = (r) =>
    h("tr", { class: Number(r.car_number) === state.ourCar ? "is-hero" : "" },
      h("td", { class: "rp-pos", text: String(r.position) }),
      h("td", {}, h("span", { class: "rp-bar", style: { background: r.team_color || "#888" } })),
      h("td", { class: "rp-driver" }, h("strong", { text: codeOf(r) }), h("span", { text: ` ${r.driver}` })),
      h("td", { class: "rp-team", text: r.team || "" }),
      h("td", { class: "rp-gap num", text: r.position === 1 ? "WINNER" : isNum(r.gap_to_leader_sec) ? `+${r.gap_to_leader_sec.toFixed(1)}s` : "—" }),
      h("td", { class: "num", text: String(r.pit_stops ?? "—") }));

  const table = h("table", { class: "rp-table" },
    h("caption", { class: "sr-only", text: "Final classification" }),
    h("thead", {}, h("tr", {}, ...["Pos", "", "Driver", "Team", "Gap", "Stops"].map((t) => h("th", { scope: "col", text: t })))),
    h("tbody", {}, ...top.map(row), showHeroExtra ? h("tr", { class: "rp-sep" }, h("td", { colspan: 6, text: "⋯" })) : null, showHeroExtra ? row(heroResult) : null));

  const dec = sum.decisions || {};
  const totalDec = DECISIONS.reduce((a, k) => a + (dec[k] || 0), 0) || 1;
  const bar = h("div", { class: "dec-bar", role: "img", "aria-label": DECISIONS.map((k) => `${dec[k] || 0} ${k}`).join(", ") },
    ...DECISIONS.filter((k) => dec[k]).map((k) => h("span", { class: `dec-seg seg-${decisionClass(k)}`, style: { flex: String(dec[k]), background: DECISION_COLORS[k] }, title: `${dec[k]} × ${k}` })));
  const legend = h("div", { class: "dec-legend" }, ...DECISIONS.map((k) => h("span", { class: `dec-key key-${decisionClass(k)}` }, h("i", { style: { background: DECISION_COLORS[k] } }), `${k} `, h("b", { text: String(dec[k] || 0) }))));

  const gained = sum.positions_gained;
  const stops = heroPitStops(state);
  // group consecutive laps with the same signals: "L24 (FL TEMP), L47–50 (ENGINE)"
  const groups = [];
  for (const l of [...(sum.anomaly_laps || [])].sort((a, b) => a - b)) {
    const sig = (state.anomalyLaps.get(l) || []).map((k) => SIGNALS[k]?.short ?? k).join(", ");
    const g = groups[groups.length - 1];
    if (g && l === g.to + 1 && g.sig === sig) g.to = l;
    else groups.push({ from: l, to: l, sig });
  }
  const anomalyText = groups.length
    ? groups.map((g) => `L${g.from}${g.to > g.from ? `–${g.to}` : ""}${g.sig ? ` (${g.sig})` : ""}`).join(", ")
    : "none";
  const stat = (label, value, sub, cls = "") => h("div", { class: `rp-stat ${cls}` }, h("span", { class: "rp-stat-label", text: label }), h("strong", { class: "rp-stat-value", text: value }), sub ? h("span", { class: "rp-stat-sub", text: sub }) : null);

  const chartWrap = h("div", { class: "rp-chart" });
  const body = h("div", { class: "report" },
    h("div", { class: "rp-hero" },
      h("div", { class: "rp-finish" },
        h("span", { class: "rp-finish-label", text: fin ? "Finished" : "Running" }),
        h("strong", { class: "rp-finish-pos", text: `P${sum.our_position ?? hero?.row?.position ?? "?"}` }),
        h("span", { class: "rp-finish-who", text: `#${state.ourCar} ${hero?.driver ?? ""}` })),
      h("div", { class: "rp-stats" },
        stat("Start → finish", `P${sum.start_position ?? "?"} → P${sum.our_position ?? "?"}`, isNum(gained) ? `${gained > 0 ? "+" : ""}${gained} positions` : "", isNum(gained) && gained > 0 ? "is-good" : isNum(gained) && gained < 0 ? "is-bad" : ""),
        stat("Pit stops", (sum.pit_laps || []).length ? (sum.pit_laps || []).map((l) => `L${l}`).join(", ") : "none", stops.map((s) => `${s.from_compound} → ${s.to_compound}`).join(" · ")),
        stat("Anomalies", anomalyText, "laps flagged by the detector", (sum.anomaly_laps || []).length ? "is-warn" : ""),
        stat("Avg decision latency", isNum(sum.avg_decision_latency_ms) ? fmtMs(sum.avg_decision_latency_ms) : "—", `${totalDec} strategist calls`))),
    h("div", { class: "rp-decisions" }, h("h3", { class: "rp-h", text: "Strategist calls" }), bar, legend),
    h("div", { class: "rp-grid" },
      h("div", {}, h("h3", { class: "rp-h", text: "Classification" }), results.length ? table : h("p", { class: "muted", text: "No classification yet." })),
      h("div", {}, h("h3", { class: "rp-h", text: "Position over laps" }), chartWrap)));

  const again = h("button", { class: "btn btn-primary", type: "button" }, icon("restart", { size: 15 }), source.kind === "replay" ? "Watch again" : "Race again");
  const dl = h("button", { class: "btn btn-ghost", type: "button" }, icon("download", { size: 15 }), "Download session JSON");
  const close = h("button", { class: "btn btn-ghost", type: "button", text: "Close" });
  const modal = openModal({
    title: fin ? "Race report" : "Race report (in progress)",
    subtitle: `Race ${state.raceId ?? ""} · ${state.totalLaps} laps${state.circuit ? ` · ${state.circuit.replace(/_/g, " ")}` : ""}`,
    body,
    size: "xl",
    className: "modal-report",
    footer: [dl, h("span", { class: "spacer" }), close, again],
  });
  setTimeout(() => {
    const chart = createPositionChart(chartWrap, { height: 220, rivals: true, label: "Our position over laps" });
    chart.update(getState());
  }, 0);
  again.addEventListener("click", async () => {
    modal.close();
    await actions.control("restart", {}, null);
  });
  dl.addEventListener("click", () => actions.downloadSession(dl));
  close.addEventListener("click", () => modal.close());
  return modal;
}
