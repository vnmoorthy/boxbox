// Pure formatting helpers. No DOM access: importable from Node (selftest).

export const DECISIONS = ["STAY OUT", "PIT SOON", "PIT NOW"];
export const COMPOUNDS = ["SOFT", "MEDIUM", "HARD"];

export const COMPOUND_COLORS = {
  SOFT: "#ff3347",
  MEDIUM: "#ffd23f",
  HARD: "#eef1f4",
};

export const DECISION_COLORS = {
  "STAY OUT": "#3fdc6e",
  "PIT SOON": "#ffb020",
  "PIT NOW": "#ff3b4e",
};

export const SIGNALS = {
  tire_temp_fl_c: { label: "FL tyre temp", short: "FL TEMP", unit: "°C", decimals: 1, anomaly: "anomaly_tire_temp_fl" },
  tire_pressure_fl_psi: { label: "FL tyre pressure", short: "FL PRESSURE", unit: "psi", decimals: 2, anomaly: "anomaly_tire_pressure_fl" },
  engine_temp_c: { label: "Engine temp", short: "ENGINE", unit: "°C", decimals: 1, anomaly: "anomaly_engine_temp" },
};

export const ANOMALY_KEYS = {
  anomaly_tire_temp_fl: "tire_temp_fl_c",
  anomaly_tire_pressure_fl: "tire_pressure_fl_psi",
  anomaly_engine_temp: "engine_temp_c",
};

export function decisionClass(s) {
  if (s === "PIT NOW") return "now";
  if (s === "PIT SOON") return "soon";
  if (s === "STAY OUT") return "stay";
  return "none";
}

export function compoundLetter(c) {
  return c ? String(c).charAt(0).toUpperCase() : "?";
}

export function compoundColor(c) {
  return COMPOUND_COLORS[c] || "#7b8794";
}

export function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

export function fmtNum(v, d = 1, fallback = "—") {
  return isNum(v) ? v.toFixed(d) : fallback;
}

export function fmtInt(v, fallback = "—") {
  return isNum(v) ? String(Math.round(v)) : fallback;
}

export function fmtGap(v, { leaderLabel = "LEADER", decimals = 1 } = {}) {
  if (!isNum(v)) return "—";
  if (v <= 0.0001) return leaderLabel;
  return "+" + v.toFixed(decimals);
}

export function fmtLapTime(sec) {
  if (!isNum(sec) || sec <= 0) return "—";
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return m > 0 ? `${m}:${s.toFixed(2).padStart(5, "0")}` : s.toFixed(2);
}

export function fmtMs(ms) {
  if (!isNum(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
}

export function fmtCount(n) {
  if (!isNum(n)) return "0";
  if (n < 10000) return n.toLocaleString("en-US");
  if (n < 1e6) return (n / 1000).toFixed(n < 1e5 ? 1 : 0) + "k";
  return (n / 1e6).toFixed(1) + "M";
}

export function fmtRate(r) {
  if (!isNum(r) || r <= 0) return "0/s";
  return (r < 10 ? r.toFixed(1) : Math.round(r)) + "/s";
}

export function fmtClock(ms) {
  if (!isNum(ms) || ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function plural(n, word, pluralWord) {
  return `${n} ${n === 1 ? word : pluralWord || word + "s"}`;
}

export function ordinal(n) {
  return `P${n}`;
}

// "claude-haiku-5-5" -> "haiku"; "claude-3-5-sonnet-latest" -> "sonnet".
export function modelFamily(model) {
  if (!model) return "";
  const m = String(model).toLowerCase();
  for (const fam of ["haiku", "sonnet", "opus", "fable"]) if (m.includes(fam)) return fam;
  return String(model).replace(/^claude-/, "");
}

export function brainLabel(agent, model) {
  if (agent === "rules") return "Rules engine";
  if (agent === "claude" || (model && String(model).startsWith("claude"))) {
    const fam = modelFamily(model);
    return fam ? `Claude ${fam}` : "Claude";
  }
  return agent ? String(agent) : "—";
}

// Strategist badge text from status.agent.
export function strategistLabel(agentStatus, lastDecision) {
  const strat = agentStatus?.strategist;
  const model = agentStatus?.model || lastDecision?.model;
  if (strat === "rules") return "Rules engine";
  if (!strat && lastDecision?.agent === "rules" && !model) return "Rules engine";
  const fam = modelFamily(model);
  return fam ? `Claude ${fam}` : "Claude";
}

// Pace label: "20s/lap (1×)", "5s/lap (4×)".
export function speedLabel(secondsPerLap, base = 20) {
  if (!isNum(secondsPerLap) || secondsPerLap <= 0) return "—";
  const mult = base / secondsPerLap;
  const multText = Number.isInteger(mult) ? String(mult) : mult.toFixed(1);
  return `${secondsPerLap}s/lap (${multText}×)`;
}

// Tyre heat scale (°C) -> CSS color.
const TYRE_STOPS = [
  [60, [59, 130, 246]],
  [85, [34, 211, 238]],
  [98, [63, 220, 110]],
  [110, [255, 210, 63]],
  [122, [255, 140, 26]],
  [135, [255, 59, 78]],
  [155, [255, 45, 149]],
];
const BRAKE_STOPS = [
  [150, [59, 130, 246]],
  [300, [34, 211, 238]],
  [420, [63, 220, 110]],
  [600, [255, 210, 63]],
  [800, [255, 140, 26]],
  [950, [255, 59, 78]],
];

function scale(stops, v) {
  if (!isNum(v)) return "rgb(70,78,90)";
  if (v <= stops[0][0]) return `rgb(${stops[0][1].join(",")})`;
  for (let i = 1; i < stops.length; i++) {
    const [t1, c1] = stops[i];
    if (v <= t1) {
      const [t0, c0] = stops[i - 1];
      const k = (v - t0) / (t1 - t0);
      const c = c0.map((x, j) => Math.round(x + (c1[j] - x) * k));
      return `rgb(${c.join(",")})`;
    }
  }
  return `rgb(${stops[stops.length - 1][1].join(",")})`;
}

export function heatColor(tempC) {
  return scale(TYRE_STOPS, tempC);
}

export function brakeColor(tempC) {
  return scale(BRAKE_STOPS, tempC);
}

// Minimal rich text: paragraphs (blank line), line breaks, **bold**. Returns a pure
// structure [[ [ {text, bold} ] per line ] per paragraph] for DOM-free rendering.
export function parseRichText(text) {
  const src = String(text ?? "").replace(/\r\n?/g, "\n").trim();
  if (!src) return [];
  return src.split(/\n\s*\n+/).map((para) =>
    para.split("\n").map((line) => {
      const segs = [];
      const re = /\*\*([^*]+?)\*\*/g;
      let last = 0;
      let m;
      while ((m = re.exec(line))) {
        if (m.index > last) segs.push({ text: line.slice(last, m.index), bold: false });
        segs.push({ text: m[1], bold: true });
        last = m.index + m[0].length;
      }
      if (last < line.length) segs.push({ text: line.slice(last), bold: false });
      return segs;
    }),
  );
}

export function richTextToHtml(text) {
  return parseRichText(text)
    .map(
      (para) =>
        "<p>" +
        para
          .map((line) => line.map((s) => (s.bold ? `<strong>${escapeHtml(s.text)}</strong>` : escapeHtml(s.text))).join(""))
          .join("<br>") +
        "</p>",
    )
    .join("");
}

export function firstSentence(text, max = 140) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const m = t.match(/^(.+?[.!?])(\s|$)/);
  let s = m ? m[1] : t;
  if (s.length > max) s = s.slice(0, max - 1).trimEnd() + "…";
  return s;
}

export function stripBold(text) {
  return String(text ?? "").replace(/\*\*([^*]+?)\*\*/g, "$1");
}
