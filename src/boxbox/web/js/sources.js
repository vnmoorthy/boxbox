// Data sources. All three feed the same Store:
//   LiveSource   - FastAPI backend: GET ./api/status, WebSocket ./ws, POST ./api/control|engineer
//   ReplaySource - ./demo/session.json (or the in-browser synthetic generator), scheduled by ts
// Every URL is relative to the page, so the app works at "/" and under a GitHub Pages sub-path.

import { generateSession } from "./synthetic.js";
import { analystAnswer, ANALYST_PROVIDER } from "./analyst.js";
import { buildTimeline, indexAt, lapAtTime, timeForLap, synthesizeStatus, validateSession } from "./replaycore.js";

export const LIVE_ONLY_HINT = "Live controls need the local app — run `uv run boxbox`";

export function apiUrl(path) {
  return new URL(path, location.href).toString();
}

export function wsUrl() {
  const u = new URL("ws", location.href);
  u.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  u.search = "";
  u.hash = "";
  return u.toString();
}

async function fetchJson(url, opts = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { cache: "no-store", ...opts, signal: ctrl.signal });
    let body = null;
    const text = await r.text();
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!r.ok) {
      const msg = body?.error || (typeof body?.detail === "string" ? body.detail : body?.detail?.[0]?.msg) || `HTTP ${r.status} ${r.statusText || ""}`.trim();
      const err = new Error(msg);
      err.status = r.status;
      err.body = body;
      throw err;
    }
    return body;
  } catch (e) {
    if (e.name === "AbortError") throw new Error("Request timed out");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function probeLive(timeoutMs = 2500) {
  // Static hosts (GitHub Pages) never have the backend; don't log a 404 there.
  if (typeof location !== "undefined" && /\.github\.io$/i.test(location.hostname)) return null;
  try {
    const st = await fetchJson(apiUrl("api/status"), {}, timeoutMs);
    if (st && typeof st === "object" && st.race) return st;
  } catch {
    /* no backend */
  }
  return null;
}

class Emitter {
  constructor() {
    this._l = new Set();
  }
  on(fn) {
    this._l.add(fn);
    return () => this._l.delete(fn);
  }
  emit(...a) {
    for (const f of this._l) f(...a);
  }
}

// ---------------------------------------------------------------------------
export class LiveSource {
  constructor(store, initialStatus) {
    this.kind = "live";
    this.synthetic = false;
    this.store = store;
    this.initialStatus = initialStatus;
    this.ws = null;
    this.attempt = 0;
    this.conn = { state: "connecting", attempt: 0, retryAt: 0 };
    this.connection = new Emitter();
    this._retryTimer = null;
    this._closedByUs = false;
  }

  start() {
    this.store.setStatus(this.initialStatus);
    this.connect();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && this.conn.state === "reconnecting") this.connectNow();
    });
    window.addEventListener("online", () => this.conn.state !== "open" && this.connectNow());
  }

  _setConn(state, extra = {}) {
    this.conn = { ...this.conn, state, ...extra };
    this.connection.emit(this.conn);
  }

  connectNow() {
    clearTimeout(this._retryTimer);
    this.connect();
  }

  connect() {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this._setConn(this.attempt ? "reconnecting" : "connecting", { attempt: this.attempt, retryAt: 0 });
    let ws;
    try {
      ws = new WebSocket(wsUrl());
    } catch {
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this._setConn("open", { attempt: 0, since: Date.now() });
    };
    ws.onmessage = (m) => {
      let msg;
      try {
        msg = JSON.parse(m.data);
      } catch {
        return;
      }
      this._handle(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this._scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  _scheduleReconnect() {
    this.attempt++;
    const delay = Math.min(10000, 500 * 2 ** Math.min(this.attempt - 1, 5)) + Math.random() * 250;
    this._setConn("reconnecting", { attempt: this.attempt, retryAt: Date.now() + delay });
    clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => this.connect(), delay);
  }

  _handle(msg) {
    switch (msg.type) {
      case "hello":
        this.store.reset();
        if (msg.status) this.store.setStatus(msg.status);
        this.store.ingest(msg.backlog || [], { silent: true });
        if (msg.status) this.store.setStatus(msg.status);
        break;
      case "events":
        this.store.ingest(msg.events || []);
        break;
      case "status":
        if (msg.status) this.store.setStatus(msg.status);
        break;
      default:
        break;
    }
  }

  get capabilities() {
    return this.store.state.status?.capabilities || { control: false, chat: false, speeds: [], scenarios: [] };
  }

  async control(command, extra = {}) {
    const res = await fetchJson(apiUrl("api/control"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command, ...extra }),
    });
    if (res && res.ok === false) throw new Error(res.error || "Command failed");
    if (res?.status) this.store.setStatus(res.status);
    return res;
  }

  async ask(question, history) {
    const res = await fetchJson(
      apiUrl("api/engineer"),
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question, history }) },
      60000,
    );
    if (!res || typeof res.answer !== "string") throw new Error(res?.error || "The engineer returned no answer");
    return res;
  }

  async sessionBlob() {
    const r = await fetch(apiUrl("api/session"), { cache: "no-store" });
    if (!r.ok) throw new Error(`Download failed: HTTP ${r.status}`);
    return r.blob();
  }

  lapWallMs() {
    const st = this.store.state;
    return (st.status?.race?.seconds_per_lap ?? st.secondsPerLap ?? 20) * 1000;
  }

  isPaused() {
    return this.store.state.raceState !== "running" || this.conn.state !== "open";
  }
}

// ---------------------------------------------------------------------------
export const REPLAY_SPEEDS = [1, 2, 4, 8, 16];

export class ReplaySource {
  constructor(store, { synthetic = false, url = "./demo/session.json", circuit } = {}) {
    this.kind = "replay";
    this.synthetic = synthetic;
    this.url = url;
    this.circuit = circuit;
    this.store = store;
    this.session = null;
    this.timeline = null;
    this.cursor = 0;
    this.playing = false;
    this.speed = 1;
    this.t = 0; // playback position (ms on the compressed timeline)
    this._anchorPerf = 0;
    this._anchorT = 0;
    this._timer = null;
    this.changed = new Emitter(); // replay transport state changed
    this.connection = new Emitter();
    this.conn = { state: "replay" };
    this.fallbackReason = null;
    this._lastStatusAt = 0;
  }

  async load() {
    if (!this.synthetic) {
      try {
        const r = await fetch(new URL(this.url, location.href), { cache: "no-cache" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const session = validateSession(await r.json());
        this.session = session;
      } catch (e) {
        this.fallbackReason = `No recorded session (${e.message}); playing a synthetic race generated in your browser.`;
        this.synthetic = true;
      }
    }
    if (this.synthetic) this.session = generateSession({ circuit: this.circuit });
    this.timeline = buildTimeline(this.session);
    return this;
  }

  start({ autoplay = true } = {}) {
    this.seek(0, { keepPlaying: false });
    if (autoplay) this.play();
    this._tick();
  }

  get capabilities() {
    return this.store.state.status?.capabilities;
  }

  get duration() {
    return this.timeline?.duration ?? 0;
  }

  get finished() {
    return this.cursor >= (this.timeline?.events.length ?? 0);
  }

  _now() {
    return performance.now();
  }

  position() {
    if (!this.playing) return this.t;
    return Math.min(this.duration, this._anchorT + (this._now() - this._anchorPerf) * this.speed);
  }

  play() {
    if (this.finished) this.seek(0, { keepPlaying: false });
    this._anchorT = this.t;
    this._anchorPerf = this._now();
    this.playing = true;
    this._pushStatus(true);
    this.changed.emit();
  }

  pause() {
    this.t = this.position();
    this.playing = false;
    this._pushStatus(true);
    this.changed.emit();
  }

  toggle() {
    this.playing ? this.pause() : this.play();
  }

  setSpeed(x) {
    this.t = this.position();
    this._anchorT = this.t;
    this._anchorPerf = this._now();
    this.speed = x;
    this._pushStatus(true);
    this.changed.emit();
  }

  seek(t, { keepPlaying = true } = {}) {
    const wasPlaying = this.playing && keepPlaying;
    t = Math.max(0, Math.min(this.duration, t));
    const k = indexAt(this.timeline, t);
    this.store.reset();
    this.store.ingest(this.timeline.events.slice(0, k), { silent: true });
    this.cursor = k;
    this.t = t;
    this._anchorT = t;
    this._anchorPerf = this._now();
    this.playing = wasPlaying;
    this._pushStatus(true);
    this.changed.emit({ seek: true });
  }

  seekLap(lap) {
    this.seek(timeForLap(this.timeline, lap));
  }

  restart() {
    this.seek(0, { keepPlaying: false });
    this.play();
  }

  currentLap() {
    return lapAtTime(this.timeline, this.position());
  }

  _tick() {
    clearTimeout(this._timer);
    if (this.playing) {
      const t = this.position();
      const k = indexAt(this.timeline, t);
      if (k > this.cursor) {
        const batch = this.timeline.events.slice(this.cursor, k);
        this.cursor = k;
        this.store.ingest(batch);
      }
      this.t = t;
      if (this.cursor >= this.timeline.events.length || t >= this.duration) {
        this.t = this.duration;
        this.playing = false;
        this._pushStatus(true);
        this.changed.emit();
      } else {
        this._pushStatus(false);
      }
    }
    this._timer = setTimeout(() => this._tick(), 33);
  }

  raceState() {
    const st = this.store.state;
    if (st.finish && this.finished) return "finished";
    if (st.finish) return "finished";
    return this.playing ? "running" : this.cursor === 0 ? "idle" : "paused";
  }

  _pushStatus(force) {
    const now = this._now();
    if (!force && now - this._lastStatusAt < 500) return;
    this._lastStatusAt = now;
    this.store.setStatus(synthesizeStatus(this.store.state, { meta: this.timeline?.meta, raceState: this.raceState(), lapMs: this.timeline?.recordedLapMs }));
  }

  async control(command) {
    switch (command) {
      case "start":
      case "resume":
        this.play();
        return { ok: true };
      case "pause":
        this.pause();
        return { ok: true };
      case "restart":
        this.restart();
        return { ok: true };
      default:
        throw new Error(LIVE_ONLY_HINT.replace(/`/g, ""));
    }
  }

  async ask(question) {
    const started = performance.now();
    const answer = analystAnswer(question, this.store.state);
    await new Promise((r) => setTimeout(r, 350 + Math.random() * 350));
    return { answer, ...ANALYST_PROVIDER, latency_ms: Math.round(performance.now() - started) };
  }

  async sessionBlob() {
    return new Blob([JSON.stringify(this.session)], { type: "application/json" });
  }

  lapWallMs() {
    return (this.timeline?.recordedLapMs || 5000) / this.speed;
  }

  isPaused() {
    return !this.playing;
  }
}
