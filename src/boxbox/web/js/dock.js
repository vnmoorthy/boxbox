// Race control dock + idle hero card + BOX compound picker.
// Every control: immediate feedback (busy/pending), error toast, then reflects authoritative status.

import { $, h, icon, iconName, setText, setAttr, toggleClass, setDisabled, isDisabled, tyreIcon, pushOverlay, reducedMotion } from "./dom.js";
import { speedLabel, COMPOUNDS, compoundColor } from "./format.js";
import { LIVE_ONLY_HINT } from "./sources.js";
import { DEFAULT_SPEEDS } from "./grid.js";

const COMPOUND_NOTES = { SOFT: "Fastest, shortest life", MEDIUM: "Balanced: one stint to the flag", HARD: "Slowest, longest life" };

export function createDock({ source, actions }) {
  const live = source.kind === "live";
  const el = {
    start: $("#btn-start"),
    pause: $("#btn-pause"),
    pauseIcon: $("#btn-pause .btn-ico"),
    pauseText: $("#btn-pause .btn-txt"),
    restart: $("#btn-restart"),
    report: $("#btn-report"),
    pace: $("#pace-seg"),
    autopilot: $("#sw-autopilot"),
    scripted: $("#sw-scripted"),
    scenarios: $("#scenario-list"),
    box: $("#btn-box"),
    idle: $("#idle-card"),
    idleStart: $("#idle-start"),
    idlePace: $("#idle-pace"),
  };
  let paceKey = "";
  let scenarioKey = "";
  let picker = null;
  const pending = { autopilot: null, scripted: null, pace: null };

  // ---------------- buttons
  el.start.addEventListener("click", () => !isDisabled(el.start) && actions.control("start", {}, el.start));
  el.pause.addEventListener("click", () => {
    if (isDisabled(el.pause)) return;
    const st = source.store.state.raceState;
    actions.control(st === "paused" || (source.kind === "replay" && !source.playing) ? "resume" : "pause", {}, el.pause);
  });
  el.restart.addEventListener("click", () => !isDisabled(el.restart) && actions.restart(el.restart));
  el.report.addEventListener("click", () => actions.openReport());
  el.box.addEventListener("click", () => !isDisabled(el.box) && togglePicker());

  function toggleSwitch(btn, key, command) {
    btn.addEventListener("click", async () => {
      if (isDisabled(btn)) return;
      const next = btn.getAttribute("aria-checked") !== "true";
      pending[key] = next;
      render(source.store.state);
      try {
        await actions.control(command, { enabled: next }, btn);
      } finally {
        pending[key] = null;
        render(source.store.state);
      }
    });
  }
  toggleSwitch(el.autopilot, "autopilot", "autopilot");
  toggleSwitch(el.scripted, "scripted", "scripted_incident");

  // ---------------- pace
  function buildPace(speeds) {
    const key = speeds.join(",");
    if (key === paceKey) return;
    paceKey = key;
    const base = Math.max(...speeds);
    const mk = (container, idPrefix) => {
      container.replaceChildren(
        ...speeds.map((spl, i) => {
          const b = h("button", { class: "seg-btn", type: "button", role: "radio", "aria-checked": "false", dataset: { spl: String(spl) }, id: `${idPrefix}-${spl}` },
            h("span", { class: "seg-main", text: `${spl}s` }),
            h("span", { class: "seg-sub", text: `${base / spl}×` }));
          b.dataset.tip = `${speedLabel(spl, base)} · key ${i + 1}`;
          b.addEventListener("click", () => selectPace(spl, b));
          return b;
        }),
      );
    };
    mk(el.pace, "pace");
    mk(el.idlePace, "idle-pace");
  }

  async function selectPace(spl, btn) {
    if (isDisabled(btn)) return;
    const st = source.store.state;
    if (st.status?.race?.seconds_per_lap === spl) return;
    pending.pace = spl;
    render(st);
    try {
      await actions.control("speed", { seconds_per_lap: spl }, btn);
    } finally {
      pending.pace = null;
      render(source.store.state);
    }
  }

  // ---------------- scenarios
  function buildScenarios(list) {
    const key = list.map((x) => x.kind).join(",");
    if (key === scenarioKey) return;
    scenarioKey = key;
    el.scenarios.replaceChildren(
      ...list.map((sc) => {
        const b = h("button", { class: "scn-btn", type: "button", dataset: { kind: sc.kind } },
          h("span", { class: "scn-ico" }, icon(iconName(sc.icon, sc.kind), { size: 16 })),
          h("span", { class: "scn-txt", text: sc.label || sc.kind }));
        b.dataset.tip = sc.description || sc.label || sc.kind;
        setAttr(b, "aria-label", `Inject: ${sc.label || sc.kind}. ${sc.description || ""}`);
        b.addEventListener("click", () => !isDisabled(b) && actions.control("scenario", { kind: sc.kind }, b, { successToast: `${sc.label || sc.kind} injected` }));
        return b;
      }),
    );
  }

  // ---------------- box picker
  function togglePicker() {
    if (picker) closePicker();
    else openPicker();
  }

  function openPicker() {
    if (picker || isDisabled(el.box)) return;
    const st = source.store.state;
    const current = st.cars.get(st.ourCar)?.row?.tire_compound;
    const rec = st.decisions.length ? st.decisions[st.decisions.length - 1].recommended_tire_compound : null;
    const opts = COMPOUNDS.map((c) => {
      const b = h("button", { class: "pick-btn", type: "button", dataset: { compound: c }, style: { "--c": compoundColor(c) } },
        tyreIcon(c, 30),
        h("span", { class: "pick-txt" }, h("strong", { text: c }), h("small", { text: COMPOUND_NOTES[c] })),
        rec === c ? h("span", { class: "pick-rec", text: "AI pick" }) : null,
        current === c ? h("span", { class: "pick-cur", text: "fitted" }) : null);
      b.addEventListener("click", async () => {
        closePicker();
        await actions.control("box", { compound: c }, el.box, { successToast: `Box call sent: #${st.ourCar} pits next lap for ${c}` });
      });
      return b;
    });
    const pop = h("div", { class: "box-picker", role: "dialog", "aria-modal": "false", "aria-label": "Choose tyre compound for the pit stop" },
      h("div", { class: "pick-head" }, h("strong", { text: "Box this car" }), h("span", { text: "Engineer override · pits next lap" })),
      ...opts,
      h("div", { class: "pick-keys", text: "S / M / H to choose · Esc to cancel" }));
    const onKey = (e) => {
      const k = e.key.toLowerCase();
      const map = { s: "SOFT", m: "MEDIUM", h: "HARD", 1: "SOFT", 2: "MEDIUM", 3: "HARD" };
      if (map[k]) {
        e.preventDefault();
        e.stopPropagation();
        pop.querySelector(`[data-compound="${map[k]}"]`)?.click();
      }
    };
    const onDoc = (e) => {
      if (!pop.contains(e.target) && !el.box.contains(e.target)) closePicker();
    };
    pop.addEventListener("keydown", onKey);
    el.box.parentElement.append(pop);
    const unregister = pushOverlay({ el: pop, close: closePicker, trap: true });
    setTimeout(() => document.addEventListener("mousedown", onDoc), 0);
    setAttr(el.box, "aria-expanded", "true");
    picker = { pop, unregister, onDoc };
    setTimeout(() => (pop.querySelector(`[data-compound="${rec || "MEDIUM"}"]`) || opts[0]).focus(), 0);
  }

  function closePicker() {
    if (!picker) return;
    const p = picker;
    picker = null;
    p.unregister();
    document.removeEventListener("mousedown", p.onDoc);
    setAttr(el.box, "aria-expanded", "false");
    p.pop.classList.add("is-leaving");
    setTimeout(() => p.pop.remove(), reducedMotion() ? 0 : 140);
    el.box.focus({ preventScroll: true });
  }

  // ---------------- idle card
  el.idleStart.addEventListener("click", () => actions.control("start", {}, el.idleStart));

  // ---------------- render from authoritative status
  function render(state) {
    const st = state.status;
    const caps = st?.capabilities || {};
    const canControl = live && !!caps.control;
    const raceState = state.raceState;
    const running = raceState === "running";
    const paused = raceState === "paused";
    const idle = raceState === "idle";
    const finished = raceState === "finished";
    const liveHint = live ? (caps.control ? null : "This server does not accept control commands") : LIVE_ONLY_HINT;
    const disconnected = live && source.conn?.state !== "open";
    const connHint = "Waiting for the connection to the race server";

    // start / pause / restart
    const showStart = live ? idle || finished : false;
    el.start.hidden = !showStart;
    el.pause.hidden = showStart;
    if (live) {
      setDisabled(el.start, !canControl || disconnected, disconnected ? connHint : liveHint);
      setDisabled(el.pause, !canControl || disconnected || !(running || paused), disconnected ? connHint : !(running || paused) ? "No race running" : liveHint);
      setDisabled(el.restart, !canControl || disconnected || idle, disconnected ? connHint : idle ? "No race to restart" : liveHint);
    } else {
      setDisabled(el.pause, false);
      setDisabled(el.restart, false);
    }
    const isPausedUi = source.kind === "replay" ? !source.playing : paused;
    el.pauseIcon.replaceChildren(icon(isPausedUi ? "play" : "pause", { size: 15 }));
    setText(el.pauseText, isPausedUi ? (source.kind === "replay" && source.finished ? "Replay" : "Resume") : "Pause");
    el.pause.dataset.tip = `${isPausedUi ? "Resume" : "Pause"} ${source.kind === "replay" ? "the replay" : "the race"} · Space`;
    el.restart.dataset.tip = source.kind === "replay" ? "Restart the replay from lap 1 · R" : "Abandon this race and start a new one · R";
    el.report.hidden = !state.finish;

    // pace
    const speeds = caps.speeds?.length ? caps.speeds : DEFAULT_SPEEDS;
    buildPace(speeds);
    const spl = pending.pace ?? st?.race?.seconds_per_lap;
    for (const container of [el.pace, el.idlePace]) {
      for (const b of container.children) {
        const v = Number(b.dataset.spl);
        setAttr(b, "aria-checked", v === spl ? "true" : "false");
        toggleClass(b, "is-pending", pending.pace === v);
        setDisabled(b, !canControl || disconnected, disconnected ? connHint : liveHint);
      }
    }

    // switches
    const ap = pending.autopilot ?? !!st?.race?.autopilot;
    const si = pending.scripted ?? !!st?.race?.scripted_incident;
    setAttr(el.autopilot, "aria-checked", ap ? "true" : "false");
    setAttr(el.scripted, "aria-checked", si ? "true" : "false");
    toggleClass(el.autopilot, "is-pending", pending.autopilot != null);
    toggleClass(el.scripted, "is-pending", pending.scripted != null);
    setDisabled(el.autopilot, !canControl || disconnected, disconnected ? connHint : liveHint);
    setDisabled(el.scripted, !canControl || disconnected, disconnected ? connHint : liveHint);
    el.autopilot.dataset.tip = canControl ? (ap ? "On: the car obeys the strategist's PIT NOW" : "Off: the strategist advises, you press BOX") : liveHint;
    el.scripted.dataset.tip = canControl ? "When on, each race schedules a front-left overheat at lap 24" : liveHint;

    // scenarios
    const list = caps.scenarios?.length ? caps.scenarios : [];
    buildScenarios(list);
    const active = new Set((st?.race?.active_scenarios || state.activeScenarios || []).map((a) => a.kind));
    for (const b of el.scenarios.children) {
      const isActive = active.has(b.dataset.kind);
      toggleClass(b, "is-active", isActive);
      const reason = !live ? LIVE_ONLY_HINT : disconnected ? connHint : !canControl ? liveHint : !running ? "Start the race to inject incidents" : isActive ? "Already active" : null;
      setDisabled(b, !!reason, reason);
    }

    // box
    const heroRow = state.cars.get(state.ourCar)?.row;
    const boxReason = !live ? LIVE_ONLY_HINT : disconnected ? connHint : !canControl ? liveHint : !running ? "Box calls work while the race is running" : heroRow?.in_pit_lane ? "Already in the pit lane" : null;
    setDisabled(el.box, !!boxReason, boxReason);
    el.box.dataset.tip = boxReason ? "" : "Engineer override: pit #" + state.ourCar + " next lap · B";
    if (boxReason && picker) closePicker();

    // idle card (live only)
    const showIdle = live && idle;
    if (el.idle.hidden === showIdle) {
      el.idle.hidden = !showIdle;
    }
    setDisabled(el.idleStart, !canControl || disconnected, disconnected ? connHint : liveHint);
  }

  return {
    update: render,
    openPicker,
    closePicker,
    get pickerOpen() {
      return !!picker;
    },
    paceButtons: () => [...el.pace.children],
  };
}
