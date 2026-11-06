// AI Strategist panel: current call (animated), recommendation, reasoning, which brain;
// decision feed + race log (incremental, newest first); decision detail modal.

import { $, h, icon, iconName, setText, setAttr, toggleClass, renderRich, tyreIcon, openModal, reducedMotion } from "./dom.js";
import { decisionClass, brainLabel, fmtMs, firstSentence, stripBold, isNum, fmtNum, SIGNALS, compoundColor } from "./format.js";
import { latestDecision, stintWindow, isDeliberating, decisionsForLap } from "./store.js";

const LOG_ICONS = {
  race_start: "flag", flag: "flag", scenario: "alert", scenario_end: "check", box_call: "wrench", pit_stop: "wrench",
  paused: "pause", resumed: "play", settings: "info", speed: "info", finish: "flag", abandoned: "restart",
};

export function logMessage(e) {
  const d = e.data || {};
  if (e.kind === "settings") {
    const parts = [];
    if (isNum(d.seconds_per_lap)) parts.push(`${d.seconds_per_lap}s/lap`);
    if (d.autopilot != null) parts.push(`autopilot ${d.autopilot ? "on" : "off"}`);
    if (d.scripted_incident != null) parts.push(`scripted incident ${d.scripted_incident ? "on" : "off"}`);
    return `Settings: ${parts.join(" · ") || "updated"}`;
  }
  if (e.kind === "box_call" && !e.message) return `Box call: ${d.compound} (${d.by})`;
  return e.message || e.kind;
}

export function createStrategist({ ui, onOpenDecision }) {
  const el = {
    call: $("#call"),
    callLap: $("#call-lap"),
    callText: $("#call-text"),
    callSub: $("#call-sub"),
    delibText: $("#call-delib-text"),
    brain: $("#call-brain"),
    rec: $("#call-rec"),
    condition: $("#call-condition"),
    context: $("#call-context"),
    reasoning: $("#call-reasoning"),
    reasoningBody: $("#call-reasoning-body"),
    feed: $("#feed-decisions"),
    log: $("#feed-log"),
    tabs: [$("#tab-decisions"), $("#tab-log")],
    panes: [$("#pane-decisions"), $("#pane-log")],
    feedCount: $("#feed-count"),
    logCount: $("#log-count"),
  };
  let epoch = -1;
  let shownKey = null;
  let animateNext = false;
  let nDecisions = 0;
  let nLog = 0;

  // tabs (roving, arrow keys)
  el.tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => selectTab(i));
    tab.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        const j = (i + (e.key === "ArrowRight" ? 1 : -1) + el.tabs.length) % el.tabs.length;
        selectTab(j);
        el.tabs[j].focus();
      }
    });
  });
  function selectTab(i) {
    el.tabs.forEach((t, j) => {
      setAttr(t, "aria-selected", i === j ? "true" : "false");
      t.tabIndex = i === j ? 0 : -1;
      el.panes[j].hidden = i !== j;
    });
  }
  selectTab(0);

  function renderCall(state) {
    const d = latestDecision(state);
    const key = d ? `${d.lap}:${d.suggestion}:${d._seq}:${d.phase}` : "none";
    if (key === shownKey) return;
    const deliberating = isDeliberating(state);
    toggleClass(el.call, "is-deliberating", deliberating);
    if (deliberating) {
      const model = state.status?.agent?.model;
      setText(el.delibText, `Reflex call from the rules engine · ${model ? brainLabel("claude", model) : "Claude"} deliberating…`);
    }
    const prevSuggestion = el.call.dataset.call;
    shownKey = key;
    if (!d) {
      el.call.dataset.call = "none";
      setText(el.callLap, state.lap ? `LAP ${state.lap}` : "STANDING BY");
      setText(el.callText, "AWAITING CALL");
      setText(el.callSub, "The strategist reads every 20-second window and calls once per lap.");
      setText(el.brain, "—");
      el.rec.hidden = true;
      setText(el.condition, "—");
      setText(el.context, "—");
      el.reasoning.hidden = true;
      return;
    }
    const cls = decisionClass(d.suggestion);
    // animate only real-time changes, never the first render after load/seek (screenshots)
    if (animateNext && prevSuggestion !== cls && !reducedMotion()) {
      el.call.classList.remove("is-swap");
      void el.call.offsetWidth;
      el.call.classList.add("is-swap");
    }
    el.call.dataset.call = cls;
    setText(el.callLap, `LAP ${d.lap} ${d.phase === "reflex" ? "REFLEX" : "CALL"}`);
    setText(el.callText, d.suggestion);
    setText(el.callSub, d.suggestion === "PIT NOW" ? "Box this lap" : d.suggestion === "PIT SOON" ? "Pit window open" : "Hold track position");
    const brain = brainLabel(d.agent, d.model);
    setText(el.brain, `${brain}${isNum(d.latency_ms) ? ` · ${fmtMs(d.latency_ms)}` : ""}`);
    el.brain.dataset.tip = `${d.phase === "reflex" ? "Reflex call" : "Decided"} by ${d.agent === "rules" ? "the rules engine" : "Claude"}${d.model ? ` (${d.model})` : ""}${isNum(d.latency_ms) ? ` in ${fmtMs(d.latency_ms)}` : ""}`;
    toggleClass(el.brain, "is-rules", d.agent === "rules");

    if (d.recommended_tire_compound) {
      el.rec.hidden = false;
      el.rec.replaceChildren(
        tyreIcon(d.recommended_tire_compound, 26),
        h("div", { class: "rec-main" },
          h("strong", { text: d.recommended_tire_compound, style: { color: compoundColor(d.recommended_tire_compound) } }),
          h("span", { text: isNum(d.recommended_stint_laps) ? `${d.recommended_stint_laps}-lap stint` : "" })),
        h("p", { class: "rec-reason", text: stripBold(d.recommended_reason || "") }),
      );
    } else el.rec.hidden = true;
    setText(el.condition, stripBold(d.condition_summary || "—"));
    setText(el.context, stripBold(d.race_context || "—"));
    el.reasoning.hidden = !d.reasoning;
    renderRich(el.reasoningBody, d.reasoning || "");
  }

  function feedItem(d) {
    const cls = decisionClass(d.suggestion);
    const b = h("button", { class: `feed-item fi-${cls}`, type: "button", "aria-label": `Lap ${d.lap}${d.phase === "reflex" ? " reflex" : ""}: ${d.suggestion}. ${stripBold(d.condition_summary || "")} Open details` },
      h("span", { class: "fi-lap", text: `L${d.lap}` }),
      h("span", {}, h("span", { class: `chip chip-${cls}`, text: d.suggestion }), d.phase === "reflex" ? h("span", { class: "fi-phase", text: "REFLEX" }) : null),
      h("span", { class: "fi-sum", text: firstSentence(stripBold(d.condition_summary || d.reasoning || ""), 110) }),
      h("span", { class: `fi-brain ${d.agent === "rules" ? "is-rules" : ""}`, text: d.agent === "rules" ? "RULES" : "AI", "aria-hidden": "true" }));
    b.addEventListener("click", () => onOpenDecision(d.lap));
    return h("li", {}, b);
  }

  function logItem(e, state) {
    const d = e.data || {};
    const heroish = Number(d.car_number) === state.ourCar || ["scenario", "scenario_end", "flag", "finish", "race_start", "abandoned"].includes(e.kind);
    const ico = e.kind === "scenario" ? iconName(null, d.kind) : LOG_ICONS[e.kind] || "info";
    const kindCls = e.kind === "flag" ? `log-flag-${String(d.flag || "").toLowerCase()}` : `log-${e.kind}`;
    return h("li", { class: `log-item ${kindCls} ${heroish ? "is-hero" : "is-rival"}` },
      h("span", { class: "log-ico" }, icon(ico, { size: 14 })),
      h("span", { class: "fi-lap", text: isNum(e.lap) && e.lap > 0 ? `L${e.lap}` : "—" }),
      h("span", { class: "log-msg", text: logMessage(e) }));
  }

  function renderFeeds(state) {
    const decs = state.decisions;
    if (decs.length < nDecisions) {
      el.feed.replaceChildren();
      nDecisions = 0;
    }
    if (decs.length > nDecisions) {
      const frag = document.createDocumentFragment();
      for (let i = decs.length - 1; i >= nDecisions; i--) frag.append(feedItem(decs[i]));
      el.feed.prepend(frag);
      nDecisions = decs.length;
    }
    setText(el.feedCount, String(decs.length));
    const log = state.raceEvents;
    if (log.length < nLog) {
      el.log.replaceChildren();
      nLog = 0;
    }
    if (log.length > nLog) {
      const frag = document.createDocumentFragment();
      for (let i = log.length - 1; i >= nLog; i--) frag.append(logItem(log[i], state));
      el.log.prepend(frag);
      nLog = log.length;
    }
    setText(el.logCount, String(log.length));
    el.feed.parentElement.classList.toggle("is-empty", !decs.length);
    el.log.parentElement.classList.toggle("is-empty", !log.length);
  }

  function update(state) {
    animateNext = state.epoch === epoch && shownKey !== null;
    if (state.epoch !== epoch) {
      epoch = state.epoch;
      shownKey = null;
      el.call.classList.remove("is-swap");
      el.feed.replaceChildren();
      el.log.replaceChildren();
      nDecisions = 0;
      nLog = 0;
    }
    renderCall(state);
    renderFeeds(state);
  }

  return { update, selectTab };
}

// ---------------------------------------------------------------- detail modal
function field(label, value, cls = "") {
  return [h("dt", { text: label }), h("dd", { class: cls }, value instanceof Node ? value : String(value ?? "—"))];
}

export function openDecisionDetail(getState, lap) {
  let current = lap;
  let modal = null;
  const body = h("div", { class: "detail" });
  const prev = h("button", { class: "btn btn-ghost", type: "button" }, icon("chevron", { size: 14, cls: "flip" }), "Previous lap");
  const next = h("button", { class: "btn btn-ghost", type: "button" }, "Next lap", icon("chevron", { size: 14 }));
  const counter = h("span", { class: "detail-nav-label" });

  function lapsWithDecisions() {
    return [...getState().decisionByLap.keys()].sort((a, b) => a - b);
  }

  function render() {
    const state = getState();
    const d = state.decisionByLap.get(current);
    const cs = state.carStateByLap.get(current);
    const laps = lapsWithDecisions();
    const idx = laps.indexOf(current);
    prev.disabled = idx <= 0;
    next.disabled = idx < 0 || idx >= laps.length - 1;
    setText(counter, `Lap ${current} of ${state.totalLaps}`);
    const titleEl = modal?.el.querySelector(".modal-title");
    if (titleEl) titleEl.textContent = `Lap ${current} decision`;
    body.replaceChildren();
    if (!d) {
      body.append(h("p", { class: "muted", text: `No decision recorded for lap ${current} yet.` }));
      return;
    }
    const cls = decisionClass(d.suggestion);
    const anomalies = Object.entries({ "FL tyre temp": d.anomaly_tire_temp_fl, "FL tyre pressure": d.anomaly_tire_pressure_fl, Engine: d.anomaly_engine_temp })
      .filter(([, v]) => v).map(([k]) => k);
    const head = h("div", { class: `detail-head dh-${cls}` },
      h("span", { class: `chip chip-lg chip-${cls}`, text: d.suggestion }),
      h("div", { class: "detail-meta" },
        h("span", { text: `P${d.position ?? "—"}` }),
        h("span", {}, tyreIcon(d.tire_compound_current, 16), ` ${d.tire_compound_current ?? "—"} · ${d.tire_age_laps ?? "—"} laps`),
        h("span", { class: anomalies.length ? "is-bad" : "is-ok", text: anomalies.length ? `Anomaly: ${anomalies.join(", ")}` : "No anomalies" })));
    const rich = h("div", { class: "rich" });
    renderRich(rich, d.reasoning || "—");
    const dl = h("dl", { class: "detail-grid" },
      field("Condition", stripBold(d.condition_summary)),
      field("Race context", stripBold(d.race_context)),
      field("Recommended compound", d.recommended_tire_compound ? h("span", {}, tyreIcon(d.recommended_tire_compound, 16), ` ${d.recommended_tire_compound}`) : "—"),
      field("Recommended stint", isNum(d.recommended_stint_laps) ? `${d.recommended_stint_laps} laps` : "—"),
      field("Recommended reason", stripBold(d.recommended_reason ?? "—")),
      field("Brain", `${brainLabel(d.agent, d.model)} (agent: ${d.agent ?? "—"}${d.model ? `, model: ${d.model}` : ""})`),
      field("Phase", d.phase === "reflex" ? "reflex (instant rules-engine call; the LLM's final call follows)" : "final"),
      field("Latency", isNum(d.latency_ms) ? fmtMs(d.latency_ms) : "—"),
      // Windows are 20 s of simulation time per lap, so show them as race time, not a wall clock.
      field("Window (race time)", isNum(d.lap) ? `${raceClock((d.lap - 1) * 20)}–${raceClock(d.lap * 20)}` : "—", "mono"),
      field("Decided at", isNum(d.decided_at) ? new Date(d.decided_at).toLocaleTimeString([], { hour12: false }) : "—", "mono"));
    const sections = [head, h("h3", { class: "detail-h", text: "Reasoning" }), rich, dl];
    const others = decisionsForLap(state, current).filter((x) => x !== d);
    if (others.length) {
      sections.push(h("h3", { class: "detail-h", text: "Other calls this lap" }),
        h("ul", { class: "detail-others" }, ...others.map((x) => h("li", {},
          h("span", { class: `chip chip-${decisionClass(x.suggestion)}`, text: x.suggestion }),
          ` ${x.phase} · ${brainLabel(x.agent, x.model)}${isNum(x.latency_ms) ? ` · ${fmtMs(x.latency_ms)}` : ""} · `,
          stripBold(firstSentence(x.condition_summary || x.reasoning || "", 120))))));
    }
    if (cs) {
      const rows = Object.entries(SIGNALS).map(([k, sig]) => {
        const b = cs.bounds?.[k];
        const bad = !!cs[sig.anomaly];
        return h("tr", { class: bad ? "is-bad" : "" },
          h("th", { scope: "row", text: sig.label }),
          h("td", { text: `${fmtNum(cs[k], sig.decimals)} ${sig.unit}` }),
          h("td", { text: b ? fmtNum(b.expected, sig.decimals) : "training" }),
          h("td", { text: b ? `${fmtNum(b.lower, sig.decimals)} – ${fmtNum(b.upper, sig.decimals)}` : `${Math.min(stintWindow(state, cs, k), 6)}/6` }),
          h("td", { text: bad ? "ANOMALY" : b ? "nominal" : "—" }));
      });
      sections.push(h("h3", { class: "detail-h", text: "Detector window (car_state)" }),
        h("div", { class: "table-wrap" }, h("table", { class: "mini-table" },
          h("thead", {}, h("tr", {}, ...["Signal", "Window avg", "Expected", "Band", "Verdict"].map((t) => h("th", { scope: "col", text: t })))),
          h("tbody", {}, ...rows))));
    }
    const raw = h("pre", { class: "raw" });
    raw.textContent = d.raw_response ?? "—";
    sections.push(h("details", { class: "raw-wrap" }, h("summary", { text: "Raw model response" }), raw));
    body.append(...sections);
  }

  prev.addEventListener("click", () => {
    const laps = lapsWithDecisions();
    const i = laps.indexOf(current);
    if (i > 0) {
      current = laps[i - 1];
      render();
    }
  });
  next.addEventListener("click", () => {
    const laps = lapsWithDecisions();
    const i = laps.indexOf(current);
    if (i >= 0 && i < laps.length - 1) {
      current = laps[i + 1];
      render();
    }
  });
  modal = openModal({
    title: `Lap ${lap} decision`,
    subtitle: "Every field the strategist produced for this window",
    body,
    size: "lg",
    footer: [prev, counter, next],
    className: "modal-detail",
  });
  modal.el.addEventListener("keydown", (e) => {
    if (e.target.closest("pre, summary")) return;
    if (e.key === "ArrowLeft") prev.click();
    if (e.key === "ArrowRight") next.click();
  });
  render();
  return modal;
}

function raceClock(totalSec) {
  const m = Math.floor(totalSec / 60);
  return `${m}:${String(Math.round(totalSec - m * 60)).padStart(2, "0")}`;
}
