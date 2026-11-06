// Top bar: lap counter, flag chip, mode badge, strategist badge, connection indicator.

import { $, setText, setAttr, toggleClass } from "./dom.js";
import { strategistLabel, fmtMs, isNum } from "./format.js";
import { latestDecision } from "./store.js";

const FLAG_TEXT = { PRE: "PRE-RACE", GREEN: "GREEN", SC: "SAFETY CAR", CHEQUERED: "CHEQUERED" };

export function createTopbar({ source }) {
  const lapNow = $("#lap-now");
  const lapTotal = $("#lap-total");
  const lapBox = $("#lapbox");
  const flag = $("#flag-chip");
  const flagText = $("#flag-text");
  const mode = $("#mode-badge");
  const brain = $("#brain-badge");
  const brainText = $("#brain-text");
  const conn = $("#conn");
  const connLabel = $("#conn-label");
  let lastLap = null;
  let connState = source.conn || { state: "connecting" };
  let retryTimer = null;

  function renderConn() {
    const st = connState.state;
    conn.dataset.state = st;
    let label = "Connecting…";
    let tip = "Opening the live WebSocket";
    if (st === "open") {
      label = "Live";
      tip = "Streaming events over WebSocket";
    } else if (st === "reconnecting") {
      const secs = connState.retryAt ? Math.max(0, Math.ceil((connState.retryAt - Date.now()) / 1000)) : 0;
      label = secs ? `Reconnecting in ${secs}s` : "Reconnecting…";
      tip = `Connection lost. Attempt ${connState.attempt}. Data on screen is frozen until the stream resumes.`;
    } else if (st === "replay") {
      label = "Offline";
      tip = source.synthetic ? "Playing a synthetic race generated in your browser" : "Playing a recorded session from demo/session.json";
    }
    setText(connLabel, label);
    conn.dataset.tip = tip;
    setAttr(conn, "aria-label", `Connection: ${label}`);
  }

  source.connection?.on((c) => {
    connState = c;
    renderConn();
    clearInterval(retryTimer);
    if (c.state === "reconnecting") retryTimer = setInterval(renderConn, 1000);
  });
  renderConn();

  function update(state) {
    const total = state.totalLaps || 60;
    const lap = state.lap || 0;
    setText(lapNow, lap ? String(lap) : "–");
    setText(lapTotal, String(total));
    setAttr(lapBox, "aria-label", lap ? `Lap ${lap} of ${total}` : `Lap – of ${total}`);
    if (lastLap !== null && lap !== lastLap) {
      lapBox.classList.remove("is-tick");
      void lapBox.offsetWidth;
      lapBox.classList.add("is-tick");
    }
    lastLap = lap;

    const f = state.flag || "PRE";
    flag.dataset.flag = f;
    setText(flagText, FLAG_TEXT[f] || f);
    setAttr(flag, "aria-label", `Flag: ${FLAG_TEXT[f] || f}`);

    const st = state.status;
    let modeText = "LIVE";
    let modeKind = "live";
    let modeTip = "";
    if (source.kind === "replay") {
      modeText = source.synthetic ? "SYNTHETIC DEMO" : "DEMO REPLAY";
      modeKind = "replay";
      modeTip = source.synthetic ? "A synthetic race generated in your browser, following the BoxBox protocol" : "A recorded race replayed from demo/session.json";
    } else {
      const broker = st?.pipeline?.broker || "";
      const inMem = !broker || /in-?memory|embedded|local/i.test(broker);
      modeText = inMem ? "LIVE · IN-MEMORY" : "LIVE · KAFKA";
      modeTip = inMem ? "Live race on the in-process bus" : `Live race over a Kafka-compatible broker (${broker})`;
    }
    setText(mode, modeText);
    mode.dataset.kind = modeKind;
    mode.dataset.tip = modeTip;

    const d = latestDecision(state);
    const label = strategistLabel(st?.agent, d);
    const isRules = label === "Rules engine";
    setText(brainText, label);
    toggleClass(brain, "is-rules", isRules);
    const parts = [];
    if (st?.agent?.strategist) parts.push(`Strategist mode: ${st.agent.strategist}`);
    if (st?.agent?.model) parts.push(`model ${st.agent.model}`);
    if (isNum(st?.agent?.avg_latency_ms)) parts.push(`avg ${fmtMs(st.agent.avg_latency_ms)}`);
    if (d) parts.push(`last call by ${d.agent === "rules" ? "rules engine" : "Claude"}`);
    if (st?.agent?.strategist === "hybrid") parts.push("Claude first, rules engine as fallback");
    brain.dataset.tip = parts.join(" · ") || "Which brain makes the pit calls";
  }

  return { update };
}
