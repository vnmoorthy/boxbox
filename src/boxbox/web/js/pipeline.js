// Live pipeline diagram: Simulator → car_telemetry / race_standings → car_state (window · join
// · detect) → pit_strategy_agent → pit_decisions → Dashboard, with the Autopilot loop back to
// the Simulator. Per-topic counts and rates, agent latency, animated dots when records flow.

import { s, h, setText, toggleClass, reducedMotion } from "./dom.js";
import { fmtCount, fmtRate, fmtMs, isNum, strategistLabel } from "./format.js";
import { latestDecision } from "./store.js";

const VB_W = 1200;
const VB_H = 186;

const NODES = {
  sim: { x: 16, y: 38, w: 156, h: 70, title: "Simulator", sub: "22 cars · 60 laps", stage: "simulator" },
  tel: { x: 214, y: 14, w: 154, h: 46, topic: "car_telemetry", title: "car_telemetry" },
  std: { x: 214, y: 86, w: 154, h: 46, topic: "race_standings", title: "race_standings" },
  cs: { x: 410, y: 38, w: 186, h: 70, title: "car_state", sub: "window · join · detect", stage: "car_state", topic: "car_state" },
  agent: { x: 640, y: 38, w: 196, h: 70, title: "pit_strategy_agent", sub: "brain", stage: "pit_strategy_agent" },
  dec: { x: 876, y: 50, w: 150, h: 46, topic: "pit_decisions", title: "pit_decisions" },
  dash: { x: 1066, y: 38, w: 118, h: 70, title: "Dashboard", sub: "WebSocket · you" },
};

const EDGES = {
  e1: [[172, 60], [193, 60], [193, 37], [214, 37]],
  e2: [[172, 86], [193, 86], [193, 109], [214, 109]],
  e3: [[368, 37], [389, 37], [389, 62], [410, 62]],
  e4: [[368, 109], [389, 109], [389, 84], [410, 84]],
  e5: [[596, 73], [640, 73]],
  e6: [[836, 73], [876, 73]],
  e7: [[1026, 73], [1066, 73]],
  loop: [[951, 96], [951, 166], [94, 166], [94, 108]],
};

const FLOWS = {
  car_telemetry: ["e1", "e3"],
  race_standings: ["e2", "e4"],
  car_state: ["e5"],
  pit_decisions: ["e6", "e7"],
};

function edgeGeom(points) {
  const segs = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    const len = Math.hypot(x1 - x0, y1 - y0);
    segs.push({ x0, y0, x1, y1, len, start: total });
    total += len;
  }
  return { segs, total };
}

function pointOn(geom, p) {
  const d = p * geom.total;
  for (const sg of geom.segs) {
    if (d <= sg.start + sg.len) {
      const t = sg.len ? (d - sg.start) / sg.len : 0;
      return [sg.x0 + (sg.x1 - sg.x0) * t, sg.y0 + (sg.y1 - sg.y0) * t];
    }
  }
  const last = geom.segs[geom.segs.length - 1];
  return [last.x1, last.y1];
}

export function createPipeline(container, { large = false } = {}) {
  const svg = s("svg", { class: `pipe-svg ${large ? "is-large" : ""}`, viewBox: `0 0 ${VB_W} ${VB_H}`, role: "img", "aria-label": "Streaming pipeline with live record counts", preserveAspectRatio: "xMidYMid meet" });
  const gEdges = s("g", { class: "pipe-edges" });
  const gNodes = s("g", { class: "pipe-nodes" });
  const gDots = s("g", { class: "pipe-dots" });
  svg.append(gEdges, gNodes, gDots);
  const geoms = {};
  const edgeEls = {};
  for (const [k, pts] of Object.entries(EDGES)) {
    geoms[k] = edgeGeom(pts);
    const d = "M" + pts.map((p) => p.join(",")).join("L");
    const el = s("path", { d, class: `pipe-edge ${k === "loop" ? "is-loop" : ""}` });
    edgeEls[k] = el;
    gEdges.append(el);
    const [ax, ay] = pts[pts.length - 1];
    const [bx, by] = pts[pts.length - 2];
    const ang = Math.atan2(ay - by, ax - bx);
    const arrow = s("path", { d: "M-6,-4 L0,0 L-6,4", class: "pipe-arrow", transform: `translate(${ax} ${ay}) rotate(${(ang * 180) / Math.PI})` });
    gEdges.append(arrow);
  }
  const loopLabel = s("g", { class: "pipe-loop-label", transform: "translate(522 166)" },
    s("rect", { x: -118, y: -12, width: 236, height: 24, rx: 12 }),
    s("text", { x: 0, y: 0.5, "text-anchor": "middle", "dominant-baseline": "central" }, "AUTOPILOT ↺ obeys PIT NOW"));
  gEdges.append(loopLabel);
  const loopText = loopLabel.querySelector("text");

  const nodeEls = {};
  for (const [k, n] of Object.entries(NODES)) {
    const isTopic = !!n.topic && !n.stage;
    const g = s("g", { class: `pipe-node ${isTopic ? "is-topic" : "is-stage"} node-${k}`, transform: `translate(${n.x} ${n.y})` });
    g.append(s("rect", { width: n.w, height: n.h, rx: isTopic ? n.h / 2 : 8, class: "pipe-box" }));
    const title = s("text", { x: isTopic ? 18 : 14, y: isTopic ? 18 : 22, class: "pipe-title" }, n.title);
    g.append(title);
    let sub = null;
    let stat = null;
    let led = null;
    if (isTopic) {
      stat = s("text", { x: 18, y: 34, class: "pipe-stat" }, "0 · 0/s");
      g.append(stat);
    } else {
      sub = s("text", { x: 14, y: 40, class: "pipe-sub" }, n.sub);
      stat = s("text", { x: 14, y: 58, class: "pipe-stat" }, "");
      led = s("circle", { cx: n.w - 13, cy: 14, r: 4, class: "pipe-led" });
      g.append(sub, stat, led);
    }
    gNodes.append(g);
    nodeEls[k] = { g, title, sub, stat, led };
  }

  const dots = [];
  const lastSpawn = {};
  const rateSamples = []; // [{t, counts}]
  let lastCounts = null;

  function spawn(edge, now) {
    if (reducedMotion()) return;
    if (now - (lastSpawn[edge] || 0) < 110) return;
    lastSpawn[edge] = now;
    if (dots.length > 48) return;
    const el = s("circle", { r: edge === "loop" ? 4.5 : 3.2, class: `pipe-dot ${edge === "loop" ? "is-loop" : ""}` });
    gDots.append(el);
    dots.push({ edge, t0: now, dur: edge === "loop" ? 1600 : 650, el });
    edgeEls[edge].classList.add("is-hot");
    clearTimeout(edgeEls[edge]._t);
    edgeEls[edge]._t = setTimeout(() => edgeEls[edge].classList.remove("is-hot"), 500);
  }

  function flow(events) {
    const now = performance.now();
    const seen = new Set();
    for (const e of events) {
      if (FLOWS[e.topic]) seen.add(e.topic);
      if (e.topic === "race_events" && e.value?.kind === "box_call" && e.value?.data?.by === "agent") seen.add("loop");
    }
    for (const t of seen) {
      if (t === "loop") spawn("loop", now);
      else for (const edge of FLOWS[t]) spawn(edge, now);
    }
  }

  function frame(now) {
    for (let i = dots.length - 1; i >= 0; i--) {
      const d = dots[i];
      const p = (now - d.t0) / d.dur;
      if (p >= 1) {
        d.el.remove();
        dots.splice(i, 1);
        continue;
      }
      const [x, y] = pointOn(geoms[d.edge], p);
      d.el.setAttribute("cx", x.toFixed(1));
      d.el.setAttribute("cy", y.toFixed(1));
      d.el.setAttribute("opacity", (p < 0.15 ? p / 0.15 : p > 0.85 ? (1 - p) / 0.15 : 1).toFixed(2));
    }
  }

  function computeRates(counts) {
    const now = performance.now();
    rateSamples.push({ t: now, counts: { ...counts } });
    while (rateSamples.length > 2 && now - rateSamples[0].t > 4000) rateSamples.shift();
    const first = rateSamples[0];
    const dt = (now - first.t) / 1000;
    const out = {};
    for (const k of Object.keys(counts)) out[k] = dt > 0.5 ? Math.max(0, (counts[k] - (first.counts[k] || 0)) / dt) : 0;
    return out;
  }

  let lastRender = -1e9;
  let trailing = null;
  function update(state) {
    const now = performance.now();
    if (now - lastRender < 250) {
      // throttled: make sure the latest state still lands (e.g. right before a pause)
      if (!trailing) trailing = setTimeout(() => {
        trailing = null;
        update(state);
      }, 260);
      return;
    }
    clearTimeout(trailing);
    trailing = null;
    lastRender = now;
    const st = state.status;
    const topics = st?.pipeline?.topics || {};
    const counts = {};
    for (const t of Object.keys(FLOWS)) counts[t] = topics[t]?.count ?? state.counts[t] ?? 0;
    if (lastCounts && Object.keys(counts).some((k) => counts[k] < lastCounts[k])) rateSamples.length = 0;
    lastCounts = counts;
    const localRates = computeRates(counts);
    for (const [k, n] of Object.entries(NODES)) {
      const el = nodeEls[k];
      if (n.topic) {
        const live = topics[n.topic]?.rate;
        const rate = isNum(live) && live > 0 ? live : localRates[n.topic] || 0;
        const text = `${fmtCount(counts[n.topic] ?? 0)} · ${fmtRate(rate)}`;
        if (n.stage) setText(el.stat, `${n.topic}: ${text}`);
        else setText(el.stat, text);
        toggleClass(el.g, "is-flowing", rate > 0.05 && state.raceState === "running");
      }
      if (n.stage) {
        const stage = (st?.pipeline?.stages || []).find((x) => x.name === n.stage);
        const status = stage?.status || (st ? "ok" : "unknown");
        el.led.dataset.status = status;
      }
    }
    // agent node
    const d = latestDecision(state);
    const brain = strategistLabel(st?.agent, d);
    setText(nodeEls.agent.sub, `brain: ${brain}`);
    const inflight = st?.agent?.inflight ?? 0;
    const avg = st?.agent?.avg_latency_ms;
    setText(nodeEls.agent.stat, `${inflight} in flight · avg ${isNum(avg) ? fmtMs(avg) : "—"}`);
    toggleClass(nodeEls.agent.g, "is-thinking", inflight > 0);
    // simulator / dashboard
    setText(nodeEls.sim.stat, state.lap ? `lap ${state.lap}/${state.totalLaps} · ${state.raceState}` : state.raceState);
    setText(nodeEls.dash.stat, `${fmtCount(Object.values(state.counts).reduce((a, b) => a + b, 0))} events`);
    const broker = st?.pipeline?.broker;
    setText(nodeEls.dash.sub, broker === "replay" ? "replay · you" : broker && !/in-?memory/i.test(broker) ? "Kafka · WebSocket" : "WebSocket · you");
    const ap = st?.race?.autopilot;
    setText(loopText, `AUTOPILOT ↺ ${ap ? "ON · car obeys PIT NOW" : ap === false ? "OFF · advice only" : "obeys PIT NOW"}`);
    toggleClass(loopLabel, "is-off", ap === false);
    toggleClass(edgeEls.loop, "is-off", ap === false);
  }

  container.append(svg);
  return { update, frame, flow, el: svg };
}

export const PIPELINE_STAGES = [
  {
    title: "Simulator",
    body: "Runs a 60-lap race for 22 fictional cars. It streams the hero car #88's sensors ten times a lap to car_telemetry, and every car's timing once a lap to race_standings. It also listens for commands: pause, pace, incidents, and box calls.",
  },
  {
    title: "car_telemetry · race_standings",
    body: "Two topics on the bus (in-memory by default, any Kafka-compatible broker with --broker). Each record is keyed by car number.",
  },
  {
    title: "car_state: window · join · detect",
    body: "A stream operator groups telemetry into 20-second windows (one lap of sim time), averages each sensor, joins the latest standings row, then runs anomaly detection: it learns each signal's expected value and a lower–upper band from the first 6 windows of a stint, and flags any window outside that band.",
  },
  {
    title: "pit_strategy_agent",
    body: "Reads every car_state window and calls STAY OUT, PIT SOON, or PIT NOW, with a recommended compound, stint length, and its reasoning. The brain is Claude, or a deterministic rules engine (also the fallback if Claude is slow or unavailable).",
  },
  {
    title: "pit_decisions → Autopilot ↺",
    body: "Each decision lands on pit_decisions. With Autopilot on, the simulator obeys PIT NOW and boxes the car: a closed loop from model output back into the race. Off, the strategist only advises and you press BOX.",
  },
  {
    title: "Dashboard",
    body: "This page. It receives every event over a WebSocket (backlog first, then live batches), reduces them into one state, and renders the race. Controls go back as POST /api/control, questions to the race engineer as POST /api/engineer.",
  },
];

export function buildHowItWorks(pipeline) {
  return h("div", { class: "how" },
    h("p", { class: "how-lede", text: "BoxBox is a real-time AI pit wall. A simulated race streams through a small event pipeline; an AI strategist watches every lap and decides when to pit, and the car obeys." }),
    h("div", { class: "how-diagram" }, pipeline.el),
    h("ol", { class: "how-steps" }, ...PIPELINE_STAGES.map((st, i) => h("li", {}, h("span", { class: "how-n", text: String(i + 1) }), h("div", {}, h("h3", { text: st.title }), h("p", { text: st.body }))))),
    h("p", { class: "how-foot" }, "Run it yourself: ", h("code", { text: "uv run boxbox" }), " then open http://127.0.0.1:8088. API docs at /api/docs."));
}
