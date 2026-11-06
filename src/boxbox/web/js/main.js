// BoxBox web app bootstrap: pick a data source, build views, run the render loop.
//   live      GET ./api/status answers  -> LiveSource (WebSocket + REST)
//   replay    no backend, or ?replay=1  -> ReplaySource(./demo/session.json)
//   synthetic ?synthetic=1, or no demo  -> ReplaySource(synthetic generator)

import { Store } from "./store.js";
import { LiveSource, ReplaySource, probeLive, REPLAY_SPEEDS } from "./sources.js";
import { timeAfterDecision } from "./replaycore.js";
import {
  $, h, icon, initTooltips, toast, openModal, confirmDialog, downloadBlob, withBusy, isTypingTarget,
  topOverlay, pushOverlay, setText, reducedMotion, isDisabled,
} from "./dom.js";
import { createTopbar } from "./topbar.js";
import { createTower } from "./tower.js";
import { createTrackMap } from "./trackmap.js";
import { createDock } from "./dock.js";
import { createStrategist, openDecisionDetail } from "./strategist.js";
import { createAnomalyPanel, createCarPanel } from "./panels.js";
import { createTimeline } from "./timeline.js";
import { createPositionChart } from "./charts.js";
import { createPipeline, buildHowItWorks } from "./pipeline.js";
import { createEngineer } from "./engineer.js";
import { openReport } from "./report.js";
import { createReplayBar } from "./replaybar.js";
import { SIGNALS, fmtNum, isNum } from "./format.js";
import { DEFAULT_SPEEDS } from "./grid.js";

const params = new URLSearchParams(location.search);
const flag = (name) => params.has(name) && !["0", "false", "no"].includes(String(params.get(name)).toLowerCase());
const store = new Store({ now: () => performance.now() });
const ui = { focusCar: null, gapMode: localStorage.getItem("boxbox.gapMode") === "interval" ? "interval" : "leader", dirty: true };
let source = null;
let dirty = true;
const pipelines = new Set();

async function chooseSource() {
  const synthetic = flag("synthetic");
  const replay = flag("replay");
  if (!synthetic && !replay) {
    const status = await probeLive();
    if (status) return new LiveSource(store, status);
  }
  const src = new ReplaySource(store, { synthetic, circuit: params.get("circuit") || undefined });
  await src.load();
  return src;
}

// ------------------------------------------------------------------ circuits
const CIRCUIT_KEY = "boxbox.circuit";
let circuits = [];
let circuitFromUser = false;
let map = null;

async function loadCircuits() {
  const select = $("#circuit-select");
  try {
    const r = await fetch(new URL("circuits/index.json", location.href));
    const j = await r.json();
    circuits = j.circuits || [];
    select.replaceChildren(...circuits.map((c) => h("option", { value: c.key, text: c.label })));
    const fromUrl = params.get("circuit");
    const fromStore = localStorage.getItem(CIRCUIT_KEY);
    const known = (k) => k && circuits.some((c) => c.key === k);
    let key = j.default || circuits[0]?.key;
    if (known(fromUrl)) {
      key = fromUrl;
      circuitFromUser = true;
    } else if (known(fromStore)) {
      key = fromStore;
      circuitFromUser = true;
    } else if (known(store.state.circuit)) key = store.state.circuit;
    applyCircuit(key, false);
  } catch (e) {
    console.warn("circuit index failed", e);
    applyCircuit("silverstone", false);
  }
  select.addEventListener("change", () => {
    circuitFromUser = true;
    applyCircuit(select.value, true);
  });
}

function applyCircuit(key, persist) {
  const select = $("#circuit-select");
  if (select.value !== key) select.value = key;
  const info = circuits.find((c) => c.key === key);
  setText($("#circuit-name"), info ? info.name : key);
  setText($("#circuit-len"), info?.length_m ? `${(info.length_m / 1000).toFixed(3)} km` : "");
  map?.setCircuit(key);
  if (persist) {
    try {
      localStorage.setItem(CIRCUIT_KEY, key);
    } catch {
      /* private mode */
    }
    const u = new URL(location.href);
    u.searchParams.set("circuit", key);
    history.replaceState(null, "", u);
  }
}

// ------------------------------------------------------------------ actions
const VERBS = { start: "start the race", pause: "pause", resume: "resume", restart: "restart", speed: "change pace", scenario: "inject the incident", box: "send the box call", autopilot: "change autopilot", scripted_incident: "change the scripted incident" };

const actions = {
  async control(command, extra = {}, btn = null, opts = {}) {
    try {
      await withBusy(btn, () => source.control(command, extra));
      if (opts.successToast) toast({ kind: "success", title: opts.successToast, timeout: 3500 });
      return true;
    } catch (e) {
      toast({ kind: "danger", title: `Couldn't ${VERBS[command] || command}`, message: e.message || String(e) });
      return false;
    } finally {
      dirty = true;
    }
  },
  async restart(btn) {
    const replay = source.kind === "replay";
    const ok = await confirmDialog({
      title: replay ? "Restart the replay?" : "Restart the race?",
      message: replay ? "The replay jumps back to lap 1." : "This abandons the current race and starts a new one. The current session's data is cleared.",
      confirmLabel: replay ? "Restart replay" : "Restart race",
      danger: !replay,
    });
    if (ok) await actions.control("restart", {}, btn);
  },
  openReport() {
    return openReport({ getState: () => store.state, source, actions });
  },
  async downloadSession(btn) {
    try {
      const blob = await withBusy(btn, () => source.sessionBlob());
      const st = store.state;
      downloadBlob(blob, `boxbox-race-${st.raceId ?? "session"}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`);
    } catch (e) {
      toast({ kind: "danger", title: "Download failed", message: e.message });
    }
  },
  openDecision(lap) {
    if (!store.state.decisionByLap.has(lap)) return;
    openDecisionDetail(() => store.state, lap);
  },
  openHow() {
    if (topOverlay()?.kind === "how") return;
    const pipe = createPipeline(document.createElement("div"), { large: true });
    pipelines.add(pipe);
    pipe.update(store.state);
    const m = openModal({
      title: "How BoxBox works",
      subtitle: "Simulator → stream operators → AI strategist → closed loop",
      body: buildHowItWorks(pipe),
      size: "xl",
      className: "modal-how",
      onClose: () => pipelines.delete(pipe),
    });
    m.kind = "how";
    return m;
  },
  openShortcuts() {
    const rows = [
      ["Space", "Pause / resume"],
      ["R", "Restart (asks first)"],
      ["B", "Open the BOX compound picker"],
      ["1 – 5", source.kind === "replay" ? "Replay speed 1× · 2× · 4× · 8× · 16×" : "Pace: 20 · 10 · 5 · 2 · 1 s/lap"],
      ["E", "Race engineer chat"],
      ["H", "How it works"],
      ["?", "This help"],
      ["Esc", "Close dialogs and overlays"],
    ];
    if (source.kind === "replay") rows.splice(4, 0, ["← / →", "Replay: previous / next lap"]);
    openModal({
      title: "Keyboard shortcuts",
      size: "sm",
      body: h("dl", { class: "keys" }, ...rows.flatMap(([k, d]) => [h("dt", {}, ...k.split(" ").map((x) => (/^[–/·]$/.test(x) ? ` ${x} ` : h("kbd", { text: x })))), h("dd", { text: d })])),
    });
  },
  toggleEngineer() {
    engineer?.toggle();
  },
};

// ------------------------------------------------------------------ BOX BOX overlay
let bbTimer = null;
let bbUnregister = null;
function showBoxBox(d) {
  const el = $("#boxbox");
  setText($("#bb-sub"), `PIT NOW · lap ${d.lap}${d.recommended_tire_compound ? ` · switch to ${d.recommended_tire_compound}` : ""}`);
  setText($("#bb-reason"), String(d.condition_summary || "").replace(/\*\*/g, ""));
  setText($("#bb-who"), `TEAM RADIO · #${store.state.ourCar} ${store.state.cars.get(store.state.ourCar)?.driver_code ?? ""}`);
  el.hidden = false;
  el.classList.remove("is-on");
  void el.offsetWidth;
  el.classList.add("is-on");
  bbUnregister?.();
  bbUnregister = pushOverlay({ el, close: hideBoxBox, trap: false });
  clearTimeout(bbTimer);
  bbTimer = setTimeout(hideBoxBox, 3200);
}
function hideBoxBox() {
  const el = $("#boxbox");
  clearTimeout(bbTimer);
  bbUnregister?.();
  bbUnregister = null;
  el.classList.remove("is-on");
  setTimeout(() => {
    if (!el.classList.contains("is-on")) el.hidden = true;
  }, reducedMotion() ? 0 : 260);
}

// ------------------------------------------------------------------ notices -> toasts
function onNotice(n, state) {
  switch (n.type) {
    case "race_start":
      toast({ kind: "accent", title: "Lights out", message: n.message || "A new race has started.", timeout: 3500 });
      break;
    case "abandoned":
      toast({ kind: "info", title: "Race abandoned", message: "Restarting with a fresh grid." });
      break;
    case "scenario":
      if (n.scenario.kind !== "safety_car") toast({ kind: "warn", title: `Incident: ${n.scenario.label}`, message: `${n.scenario.source === "scripted" ? "Scripted" : "Injected"} on lap ${n.scenario.lap}. Watch the anomaly detector.`, iconOverride: "alert" });
      break;
    case "anomaly": {
      const r = n.row;
      const parts = n.signals.map((k) => {
        const b = r.bounds?.[k];
        const sig = SIGNALS[k];
        return `${sig.label} ${fmtNum(r[k], sig.decimals)}${sig.unit}${b ? ` (band ${fmtNum(b.lower, sig.decimals)}–${fmtNum(b.upper, sig.decimals)})` : ""}`;
      });
      toast({ kind: "danger", title: `Anomaly detected · lap ${n.lap}`, message: parts.join("; "), timeout: 7000 });
      break;
    }
    case "pit_now":
      showBoxBox(n.decision);
      toast({ kind: "danger", title: `PIT NOW · lap ${n.decision.lap}`, message: String(n.decision.condition_summary || "").replace(/\*\*/g, ""), iconOverride: "wrench", timeout: 6500 });
      break;
    case "pit_now_repeat":
      if (state.settings?.autopilot === false) {
        toast({ kind: "danger", title: `Still PIT NOW · lap ${n.decision.lap}`, message: "Autopilot is off, so the car is staying out. Press B to box it yourself.", iconOverride: "wrench", timeout: 4500 });
      }
      break;
    case "box_call": {
      const b = n.box;
      const who = b.by === "agent" ? "strategist (autopilot)" : b.by === "engineer" ? "pit wall override" : b.by === "tyre_life" ? "tyre life limit" : b.by;
      toast({ kind: "pit", title: `Box call: ${b.compound}`, message: `#${b.car_number} pits next lap · ${who}` });
      break;
    }
    case "pit_stop": {
      const p = n.stop;
      toast({ kind: "success", title: "Pit stop complete", message: `${p.from_compound} → ${p.to_compound}${isNum(p.stop_time_sec) ? ` · ${p.stop_time_sec.toFixed(1)} s` : ""}`, iconOverride: "wrench" });
      break;
    }
    case "sc":
      toast({ kind: "warn", title: "Safety car deployed", message: n.message || "The field is neutralised.", iconOverride: "flag" });
      break;
    case "green":
      toast({ kind: "success", title: "Green flag", message: "Safety car in. Racing resumes.", iconOverride: "flag", timeout: 3500 });
      break;
    case "chequered":
      toast({ kind: "flag", title: "Chequered flag", message: n.message || "The race is over.", iconOverride: "flag" });
      break;
    case "finish":
      setTimeout(() => {
        if (!topOverlay() || topOverlay().isDrawer) actions.openReport();
      }, 1400);
      break;
    default:
      break;
  }
  dirty = true;
  void state;
}

// ------------------------------------------------------------------ keyboard
function installShortcuts(dock) {
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTypingTarget(e.target)) return;
    const top = topOverlay();
    const k = e.key;
    if (top && !top.isDrawer) return; // modal dialogs handle their own keys (Esc via the overlay stack)
    if (top?.isDrawer && !["e", "E"].includes(k)) return;
    const interactive = e.target.closest?.("button, a, [role=switch], [role=tab], [tabindex], input, select, summary");
    switch (k) {
      case " ":
      case "Spacebar":
        if (interactive && e.target !== document.body) return;
        e.preventDefault();
        if (source.kind === "replay") source.toggle();
        else {
          const st = store.state.raceState;
          if (st === "running") actions.control("pause");
          else if (st === "paused") actions.control("resume");
        }
        break;
      case "r":
      case "R":
        e.preventDefault();
        if (source.kind === "live" && store.state.raceState === "idle") return;
        actions.restart();
        break;
      case "b":
      case "B": {
        e.preventDefault();
        const box = $("#btn-box");
        if (isDisabled(box)) toast({ kind: "info", title: "Box unavailable", message: box.dataset.tipDisabled || "Not available right now", timeout: 3000 });
        else dock.openPicker();
        break;
      }
      case "1":
      case "2":
      case "3":
      case "4":
      case "5": {
        const i = Number(k) - 1;
        if (source.kind === "replay") source.setSpeed(REPLAY_SPEEDS[i]);
        else {
          const btn = dock.paceButtons()[i];
          if (btn && !isDisabled(btn)) btn.click();
          else if (btn) toast({ kind: "info", title: "Pace unavailable", message: btn.dataset.tipDisabled || "", timeout: 2500 });
        }
        break;
      }
      case "e":
      case "E":
        e.preventDefault();
        actions.toggleEngineer();
        break;
      case "h":
      case "H":
        e.preventDefault();
        actions.openHow();
        break;
      case "?":
        e.preventDefault();
        actions.openShortcuts();
        break;
      case "ArrowLeft":
      case "ArrowRight":
        if (source.kind !== "replay" || interactive) return;
        e.preventDefault();
        source.seekLap(Math.max(1, (store.state.lap || 1) + (k === "ArrowRight" ? 1 : -1)));
        break;
      default:
        break;
    }
  });
}

// ------------------------------------------------------------------ boot
let engineer = null;

async function boot() {
  initTooltips();
  document.body.classList.add("is-booting");
  source = await chooseSource();
  document.body.dataset.mode = source.kind === "live" ? "live" : source.synthetic ? "synthetic" : "replay";

  const onFocusCar = (n) => {
    ui.focusCar = ui.focusCar === n ? null : n;
    dirty = true;
  };
  const topbar = createTopbar({ source });
  const tower = createTower({ ui, onFocusCar });
  map = createTrackMap({ root: $("#map"), store, source, ui, onFocusCar });
  const dock = createDock({ source, actions });
  const strategist = createStrategist({ ui, onOpenDecision: (lap) => actions.openDecision(lap) });
  const anomaly = createAnomalyPanel();
  const car = createCarPanel();
  const timeline = createTimeline({ onOpenDecision: (lap) => actions.openDecision(lap) });
  const positions = createPositionChart($("#chart-positions"), { height: 190, rivals: true, ui, label: "Our position over laps" });
  const pipeline = createPipeline($("#pipeline-strip"));
  pipelines.add(pipeline);
  engineer = createEngineer({ source, store });
  const replayBar = source.kind === "replay" ? createReplayBar({ source }) : null;
  const views = [topbar, tower, map, dock, strategist, anomaly, car, timeline, positions, engineer];

  $("#gap-toggle").addEventListener("click", () => localStorage.setItem("boxbox.gapMode", ui.gapMode));
  $("#btn-how").addEventListener("click", () => actions.openHow());
  $("#btn-how-2")?.addEventListener("click", () => actions.openHow());
  $("#btn-engineer").addEventListener("click", () => actions.toggleEngineer());
  $("#btn-keys").addEventListener("click", () => actions.openShortcuts());
  $("#btn-download").addEventListener("click", (e) => actions.downloadSession(e.currentTarget));
  $("#map-clear-focus")?.addEventListener("click", () => onFocusCar(ui.focusCar));
  $("#boxbox").addEventListener("click", hideBoxBox);

  store.onNotice(onNotice);
  store.subscribe((state, events, info) => {
    dirty = true;
    if (events.length && !info.silent) for (const p of pipelines) p.flow(events);
  });
  source.connection?.on(() => (dirty = true));
  source.changed?.on(() => (dirty = true));

  let followedCircuit = null;
  function renderAll() {
    const st = store.state;
    for (const v of views) v.update(st);
    for (const p of pipelines) p.update(st);
    // follow the race's circuit unless the viewer picked one
    const raceCircuit = st.status?.race?.circuit || st.circuit;
    if (!circuitFromUser && raceCircuit && raceCircuit !== followedCircuit && circuits.some((c) => c.key === raceCircuit)) {
      followedCircuit = raceCircuit;
      applyCircuit(raceCircuit, false);
    }
    const focus = ui.focusCar != null ? st.cars.get(ui.focusCar) : null;
    const fb = $("#map-focus");
    fb.hidden = !focus;
    if (focus) setText($("#map-focus-name"), `${focus.driver_code} · ${focus.driver}`);
    const hero = st.cars.get(st.ourCar);
    document.title = st.lap ? `L${st.lap}/${st.totalLaps}${hero?.row ? ` · P${hero.row.position}` : ""} · BoxBox` : "BoxBox · AI pit wall";
  }

  let lastFrameAt = 0;
  function loop(now) {
    lastFrameAt = performance.now();
    map.frame(now);
    for (const p of pipelines) p.frame(now);
    replayBar?.frame(now);
    if (dirty || ui.dirty) {
      dirty = false;
      ui.dirty = false;
      renderAll();
    }
    requestAnimationFrame(loop);
  }

  installShortcuts(dock);
  await loadCircuits();

  if (source.kind === "live") {
    source.start();
  } else {
    // deep links: ?lap=N (paused at the end of lap N), ?autoplay=0|1
    const lap = parseInt(params.get("lap"), 10);
    const hasLap = Number.isFinite(lap) && lap > 0;
    const autoplay = params.has("autoplay") ? flag("autoplay") : !hasLap;
    source.start({ autoplay: false });
    if (hasLap) source.seek(timeAfterDecision(source.timeline, Math.min(lap, source.timeline.totalLaps || 60)), { keepPlaying: false });
    if (autoplay) source.play();
    if (source.fallbackReason) toast({ kind: "info", title: "Synthetic demo", message: source.fallbackReason, timeout: 6000 });
  }
  renderAll();
  document.body.classList.remove("is-booting");
  document.body.classList.add("is-ready");
  document.documentElement.dataset.ready = "true"; // screenshot tools can wait for [data-ready]
  requestAnimationFrame(loop);
  // watchdog: if rAF is stalled (hidden embed, throttled frame), still keep panels current
  setInterval(() => {
    if (performance.now() - lastFrameAt > 600) {
      replayBar?.render();
      if (dirty || ui.dirty) {
        dirty = false;
        ui.dirty = false;
        renderAll();
      }
    }
  }, 500);

  // ?panel=engineer|how|report
  const panel = params.get("panel");
  if (panel === "engineer") engineer.show();
  else if (panel === "how") actions.openHow();
  else if (panel === "report" && store.state.finish) actions.openReport();
}

boot().catch((e) => {
  console.error(e);
  const el = $("#boot-error");
  if (el) {
    el.hidden = false;
    setText($("#boot-error-msg"), e.message || String(e));
  }
});

export { store, ui, DEFAULT_SPEEDS, icon };
