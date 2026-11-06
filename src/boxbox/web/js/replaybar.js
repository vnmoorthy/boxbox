// Replay bar (replay mode only): play/pause, speed, scrubber with lap ticks and event markers,
// time/lap readout, "copy link to this moment", and the run-it-live banner.

import { $, h, icon, setText, setAttr, toggleClass, copyText, toast } from "./dom.js";
import { fmtClock, compoundColor } from "./format.js";
import { REPLAY_SPEEDS } from "./sources.js";
import { lapAtTime } from "./replaycore.js";

export function createReplayBar({ source }) {
  const bar = $("#replaybar");
  const banner = $("#replay-banner");
  const play = $("#rb-play");
  const speedSeg = $("#rb-speed");
  const range = $("#rb-range");
  const fill = $("#rb-fill");
  const ticks = $("#rb-ticks");
  const markers = $("#rb-markers");
  const time = $("#rb-time");
  const lapEl = $("#rb-lap");
  const linkBtn = $("#rb-link");
  const tl = source.timeline;
  bar.hidden = false;
  banner.hidden = false;
  document.body.classList.add("has-replaybar");
  setText($("#replay-banner-text"), source.synthetic
    ? "Synthetic demo race, generated in your browser."
    : "Demo replay of a recorded race.");

  // copy command
  $("#banner-copy").addEventListener("click", async (e) => {
    const ok = await copyText("uv run boxbox");
    const btn = e.currentTarget;
    btn.classList.toggle("is-done", ok);
    setText(btn.querySelector(".btn-txt"), ok ? "Copied" : "Copy failed");
    setTimeout(() => {
      btn.classList.remove("is-done");
      setText(btn.querySelector(".btn-txt"), "Copy");
    }, 1600);
  });
  $("#banner-close").addEventListener("click", () => {
    banner.hidden = true;
  });

  // speed buttons
  for (const x of REPLAY_SPEEDS) {
    const b = h("button", { class: "seg-btn", type: "button", role: "radio", "aria-checked": "false", dataset: { speed: String(x) }, text: `${x}×` });
    b.addEventListener("click", () => source.setSpeed(x));
    speedSeg.append(b);
  }

  // scrubber
  const dur = Math.max(1, tl.duration);
  range.max = String(Math.round(dur));
  range.step = "50";
  for (const l of tl.laps) {
    if (l.lap === 1 || l.lap % 5 === 0) {
      const major = l.lap % 10 === 0 || l.lap === 1;
      ticks.append(h("span", { class: major ? "rb-tick is-major" : "rb-tick", style: { left: `${(l.t / dur) * 100}%` } }, major ? h("span", { class: "rb-tick-label", text: String(l.lap) }) : null));
    }
  }
  for (const m of tl.markers) {
    const el = h("button", {
      class: `rb-mark mk-${m.kind}`,
      type: "button",
      style: { left: `${(m.t / dur) * 100}%`, ...(m.kind === "pit" ? { "--c": compoundColor(m.compound) } : {}) },
      "aria-label": `Jump to ${m.label}`,
      dataset: { tip: m.label },
    });
    el.addEventListener("click", () => source.seek(Math.max(0, m.t - 1)));
    markers.append(el);
  }
  let dragging = false;
  let pendingSeek = null;
  range.addEventListener("input", () => {
    dragging = true;
    const t = Number(range.value);
    if (pendingSeek == null) {
      setTimeout(() => {
        source.seek(pendingSeek);
        pendingSeek = null;
      }, 30);
    }
    pendingSeek = t;
  });
  range.addEventListener("change", () => {
    dragging = false;
  });
  play.addEventListener("click", () => source.toggle());

  linkBtn.addEventListener("click", async () => {
    const lap = Math.max(1, source.store.state.lap || lapAtTime(tl, source.position()) || 1);
    const u = new URL(location.href);
    u.searchParams.set("lap", String(lap));
    u.searchParams.delete("autoplay");
    u.searchParams.delete("panel");
    const ok = await copyText(u.toString());
    toast({ kind: ok ? "success" : "warn", title: ok ? "Link copied" : "Couldn't copy", message: ok ? `Opens the replay paused at the end of lap ${lap}.` : u.toString() });
  });

  function render() {
    const t = source.position();
    const pct = Math.min(100, (t / dur) * 100);
    fill.style.transform = `scaleX(${pct / 100})`;
    if (!dragging) range.value = String(Math.round(t));
    setAttr(range, "aria-valuetext", `Lap ${source.store.state.lap || 0} of ${tl.totalLaps}, ${fmtClock(t / source.speed)} at ${source.speed}×`);
    setText(time, `${fmtClock(t)} / ${fmtClock(dur)}`);
    setText(lapEl, `L${source.store.state.lap || 0}/${tl.totalLaps}`);
    const playing = source.playing;
    play.replaceChildren(icon(playing ? "pause" : "play", { size: 16 }));
    setAttr(play, "aria-label", playing ? "Pause replay" : source.finished ? "Replay from the start" : "Play replay");
    play.dataset.tip = `${playing ? "Pause" : "Play"} · Space`;
    toggleClass(bar, "is-playing", playing);
    for (const b of speedSeg.children) setAttr(b, "aria-checked", Number(b.dataset.speed) === source.speed ? "true" : "false");
  }

  source.changed.on(render);
  let last = 0;
  function frame(now) {
    if (now - last < 100) return;
    last = now;
    render();
  }
  render();
  return { frame, render };
}
