// Race Engineer chat drawer. Live: POST ./api/engineer. Replay: built-in analyst.
// History is kept per race (cleared when a new race starts).

import { $, h, icon, renderRich, pushOverlay, setText, reducedMotion } from "./dom.js";
import { fmtMs, isNum } from "./format.js";

const SUGGESTIONS = [
  "Why did we pit?",
  "How are the tyres?",
  "What's the gap to the leader?",
  "Summarize the race so far",
  "What happens if we stay out?",
];

const PROVIDER_LABEL = { anthropic: "Claude API", "claude-cli": "Claude CLI", analyst: "Built-in analyst" };

export function createEngineer({ source, store }) {
  const drawer = $("#engineer");
  const backdrop = $("#engineer-backdrop");
  const log = $("#eng-log");
  const form = $("#eng-form");
  const input = $("#eng-input");
  const send = $("#eng-send");
  const chips = $("#eng-chips");
  const closeBtn = $("#eng-close");
  const clearBtn = $("#eng-clear");
  const providerEl = $("#eng-provider");
  const history = [];
  let raceKey = null;
  let busy = false;
  let unregister = null;
  let prevFocus = null;
  let open = false;

  for (const q of SUGGESTIONS) {
    const b = h("button", { class: "chip-q", type: "button", text: q });
    b.addEventListener("click", () => ask(q));
    chips.append(b);
  }

  function providerText() {
    if (source.kind === "replay") return "Built-in analyst · answers from the race data";
    const p = store.state.status?.agent?.engineer_provider;
    return p ? `Answers from ${PROVIDER_LABEL[p] || p}` : "Answers from the race server";
  }

  function welcome() {
    log.replaceChildren(
      h("div", { class: "eng-welcome" },
        h("div", { class: "eng-avatar", "aria-hidden": "true" }, icon("chat", { size: 18 })),
        h("div", {},
          h("strong", { text: "Your race engineer" }),
          h("p", { text: "Ask about the tyres, the gaps, a strategy call, or any lap (\"what happened on lap 24?\"). Answers use the live race data." }))),
    );
  }
  welcome();

  function scrollDown() {
    log.scrollTo({ top: log.scrollHeight, behavior: reducedMotion() ? "auto" : "smooth" });
  }

  function bubble(role, text, meta) {
    const body = h("div", { class: "bubble-body" });
    if (role === "assistant") renderRich(body, text);
    else body.textContent = text;
    const el = h("div", { class: `bubble bubble-${role}` }, body);
    if (meta) el.append(meta);
    log.append(el);
    scrollDown();
    return el;
  }

  function badge(res) {
    const prov = PROVIDER_LABEL[res.provider] || res.provider || "engineer";
    const parts = [prov];
    if (res.model && res.provider !== "analyst") parts.push(res.model);
    const lat = isNum(res.latency_ms) ? fmtMs(res.latency_ms) : null;
    return h("div", { class: `bubble-meta prov-${res.provider || "x"}` },
      h("span", { class: "prov-badge", text: parts.join(" · ") }),
      lat ? h("span", { class: "prov-lat", text: lat }) : null);
  }

  async function ask(question) {
    question = String(question || "").trim();
    if (!question || busy) return;
    if (!open) show();
    busy = true;
    send.disabled = true;
    input.value = "";
    autoGrow();
    log.querySelector(".eng-welcome")?.remove();
    bubble("user", question);
    const prior = history.slice(-12);
    history.push({ role: "user", content: question });
    const typing = h("div", { class: "bubble bubble-assistant is-typing", "aria-label": "Engineer is typing" }, h("span", { class: "dot" }), h("span", { class: "dot" }), h("span", { class: "dot" }));
    log.append(typing);
    scrollDown();
    try {
      const res = await source.ask(question, prior);
      typing.remove();
      history.push({ role: "assistant", content: res.answer });
      bubble("assistant", res.answer, badge(res));
    } catch (e) {
      typing.remove();
      history.pop();
      const retry = h("button", { class: "btn btn-sm btn-ghost", type: "button" }, icon("restart", { size: 13 }), "Retry");
      const err = h("div", { class: "bubble bubble-error", role: "alert" },
        h("div", { class: "bubble-body" }, h("strong", { text: "The engineer didn't answer." }), " ", e.message || "Request failed"), retry);
      retry.addEventListener("click", () => {
        err.remove();
        ask(question);
      });
      log.append(err);
      scrollDown();
    } finally {
      busy = false;
      send.disabled = false;
      if (open) input.focus({ preventScroll: true });
    }
  }

  function autoGrow() {
    input.style.height = "auto";
    input.style.height = Math.min(140, input.scrollHeight) + "px";
  }

  input.addEventListener("input", autoGrow);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      ask(input.value);
    }
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    ask(input.value);
  });
  closeBtn.addEventListener("click", () => hide());
  backdrop.addEventListener("click", () => hide());
  clearBtn.addEventListener("click", () => {
    history.length = 0;
    welcome();
    input.focus();
  });

  function show() {
    if (open) return;
    open = true;
    prevFocus = document.activeElement;
    setText(providerEl, providerText());
    drawer.hidden = false;
    backdrop.hidden = false;
    void drawer.offsetWidth; // commit the off-screen position so the slide-in transitions
    drawer.classList.add("is-open");
    backdrop.classList.add("is-open");
    document.body.classList.add("engineer-open");
    unregister = pushOverlay({ el: drawer, close: hide, isDrawer: true });
    $("#btn-engineer").setAttribute("aria-expanded", "true");
    setTimeout(() => input.focus({ preventScroll: true }), 30);
  }

  function hide() {
    if (!open) return;
    open = false;
    unregister?.();
    drawer.classList.remove("is-open");
    backdrop.classList.remove("is-open");
    document.body.classList.remove("engineer-open");
    $("#btn-engineer").setAttribute("aria-expanded", "false");
    setTimeout(() => {
      if (!open) {
        drawer.hidden = true;
        backdrop.hidden = true;
      }
    }, reducedMotion() ? 0 : 240);
    if (drawer.contains(document.activeElement)) document.activeElement.blur();
    if (prevFocus?.isConnected && prevFocus !== document.body) prevFocus.focus({ preventScroll: true });
  }

  function update(state) {
    const key = `${state.raceId ?? ""}:${state.epoch > 0 && state.raceStart ? state.raceStart.race_id : ""}`;
    if (raceKey !== null && key !== raceKey && state.raceStart) {
      if (history.length) {
        history.length = 0;
        welcome();
        log.append(h("div", { class: "eng-divider", text: "New race: conversation cleared" }));
      }
    }
    if (state.raceStart) raceKey = key;
  }

  return {
    update,
    show,
    hide,
    toggle: () => (open ? hide() : show()),
    ask,
    get open() {
      return open;
    },
  };
}
