// DOM helpers: element builders, icons, tooltips, toasts, modals (focus-trapped), confirm.
// Everything inserts text via textContent, never innerHTML with untrusted data.

import { parseRichText, compoundColor, compoundLetter } from "./format.js";

export const SVG_NS = "http://www.w3.org/2000/svg";
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

function applyProps(el, props) {
  if (!props) return;
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") el.setAttribute("class", v);
    else if (k === "text") el.textContent = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  applyProps(el, props);
  append(el, children);
  return el;
}

export function s(tag, props, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  applyProps(el, props);
  append(el, children);
  return el;
}

export function setText(el, text) {
  const t = text == null ? "" : String(text);
  if (el && el.textContent !== t) el.textContent = t;
}

export function setAttr(el, name, value) {
  const v = value == null ? null : String(value);
  if (v === null) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  } else if (el.getAttribute(name) !== v) el.setAttribute(name, v);
}

export function toggleClass(el, cls, on) {
  if (el && el.classList.contains(cls) !== !!on) el.classList.toggle(cls, !!on);
}

// Render untrusted text as paragraphs with line breaks and **bold**.
export function renderRich(el, text) {
  el.replaceChildren();
  for (const para of parseRichText(text)) {
    const p = document.createElement("p");
    para.forEach((line, i) => {
      if (i) p.append(document.createElement("br"));
      for (const seg of line) {
        if (seg.bold) {
          const b = document.createElement("strong");
          b.textContent = seg.text;
          p.append(b);
        } else p.append(document.createTextNode(seg.text));
      }
    });
    el.append(p);
  }
  return el;
}

// Accessible "soft disable": stays focusable so its tooltip can explain why.
export function setDisabled(btn, disabled, reason) {
  if (!btn) return;
  toggleClass(btn, "is-disabled", disabled);
  setAttr(btn, "aria-disabled", disabled ? "true" : null);
  if (reason !== undefined) {
    if (disabled && reason) btn.dataset.tipDisabled = reason;
    else delete btn.dataset.tipDisabled;
  }
}

export function isDisabled(btn) {
  return btn?.getAttribute("aria-disabled") === "true" || btn?.disabled;
}

export async function withBusy(btn, fn) {
  if (!btn) return fn();
  btn.classList.add("is-busy");
  setAttr(btn, "aria-busy", "true");
  try {
    return await fn();
  } finally {
    btn.classList.remove("is-busy");
    setAttr(btn, "aria-busy", null);
  }
}

// ---------------------------------------------------------------- icons
const ICONS = {
  flame: "M12 2c1 3.5 4.5 5.5 4.5 10a4.5 4.5 0 0 1-9 0c0-2 .8-3.3 1.8-4.5.2 1.6 1 2.6 2 3-.6-3 .2-6 .7-8.5z",
  puncture: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 5a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM19 2l3 3M20.5 3.5 17 7",
  engine: "M10 3v9.3a4 4 0 1 0 4 0V3a2 2 0 0 0-4 0zM14 6h3M14 9h2",
  safety_car: "M4 15l1.5-5h13L20 15M3 15h18v3H3zM7 18v2M17 18v2M8 7h8l1 3H7z",
  play: "M7 4.5v15l12-7.5z",
  pause: "M7 4h3.5v16H7zM13.5 4H17v16h-3.5z",
  restart: "M4 12a8 8 0 1 0 2.4-5.7M4 4v5h5",
  chat: "M4 5h16v11H9l-5 4z",
  help: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9.2a2.6 2.6 0 0 1 5 .9c0 1.7-2.5 2.3-2.5 3.9M12 17.2v.1",
  keyboard: "M3 7h18v10H3zM7 10h.01M10 10h.01M13 10h.01M16 10h.01M7 14h10",
  download: "M12 4v11M7 10l5 5 5-5M5 20h14",
  close: "M6 6l12 12M18 6 6 18",
  flag: "M5 21V4M5 4h11l-2 4 2 4H5",
  chevron: "M9 6l6 6-6 6",
  chevronDown: "M6 9l6 6 6-6",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  check: "M5 12.5l4.5 4.5L19 7",
  bolt: "M13 2 4 14h7l-1 8 9-12h-7z",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v6M12 7.5v.1",
  send: "M4 12l16-8-6 16-2.5-6.5z",
  map: "M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z",
  alert: "M12 3l10 18H2zM12 10v5M12 18v.1",
  wrench: "M14.5 5.5a4 4 0 0 0 5 5l-9 9a2.1 2.1 0 0 1-3-3l9-9a4 4 0 0 0-2-2z",
  stop: "M6 6h12v12H6z",
  scenario: "M12 3l10 18H2zM12 10v5M12 18v.1",
  pulse: "M3 12h4l2-6 4 12 2-6h6",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13",
  external: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
};
const ICON_ALIASES = {
  fire: "flame", overheat: "flame", tire: "puncture", tyre: "puncture", puncture: "puncture", pressure: "puncture",
  thermometer: "engine", temperature: "engine", engine: "engine", car: "safety_car", safety: "safety_car",
  safetycar: "safety_car", sc: "safety_car", flag: "flag", warning: "alert",
};
const FILLED = new Set(["flame", "play", "pause", "bolt", "stop"]);

export function iconName(name, kind) {
  const n = String(name || "").toLowerCase().replace(/[-\s]/g, "_");
  if (ICONS[n]) return n;
  if (ICON_ALIASES[n.replace(/_/g, "")]) return ICON_ALIASES[n.replace(/_/g, "")];
  const k = String(kind || "").toLowerCase();
  if (k.includes("overheat") && k.includes("engine")) return "engine";
  if (k.includes("overheat") || k.includes("fire")) return "flame";
  if (k.includes("puncture") || k.includes("pressure")) return "puncture";
  if (k.includes("engine")) return "engine";
  if (k.includes("safety") || k === "sc") return "safety_car";
  return "scenario";
}

export function icon(name, { size = 16, cls = "", label } = {}) {
  const n = ICONS[name] ? name : "info";
  const el = s("svg", {
    class: `icon icon-${n} ${cls}`.trim(),
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: FILLED.has(n) ? "currentColor" : "none",
    stroke: FILLED.has(n) ? "none" : "currentColor",
    "stroke-width": 2,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": label ? null : "true",
    role: label ? "img" : null,
    "aria-label": label || null,
    focusable: "false",
  });
  el.append(s("path", { d: ICONS[n] }));
  return el;
}

// Tyre icon: coloured ring with the compound letter.
export function tyreIcon(compound, size = 18) {
  const c = compoundColor(compound);
  const el = s("svg", { class: "tyre-icon", width: size, height: size, viewBox: "0 0 24 24", role: "img", "aria-label": `${compound || "Unknown"} tyre` });
  el.append(
    s("circle", { cx: 12, cy: 12, r: 10.2, fill: "#0b0d10", stroke: "#2a3038", "stroke-width": 1.6 }),
    s("circle", { cx: 12, cy: 12, r: 7.6, fill: "none", stroke: c, "stroke-width": 2.6 }),
    s("text", { x: 12, y: 12.5, "text-anchor": "middle", "dominant-baseline": "central", fill: "#fff", "font-size": 8.6, "font-weight": 800 }, compoundLetter(compound)),
  );
  return el;
}

export function updateTyreIcon(el, compound) {
  if (el.dataset.compound === compound) return;
  el.dataset.compound = compound || "";
  const [, ring, text] = el.children;
  ring.setAttribute("stroke", compoundColor(compound));
  text.textContent = compoundLetter(compound);
  el.setAttribute("aria-label", `${compound || "Unknown"} tyre`);
}

// ---------------------------------------------------------------- tooltip
let tipEl = null;
let tipTarget = null;
let tipManual = false;

export function initTooltips() {
  tipEl = document.getElementById("tooltip");
  const show = (e) => {
    const t = e.target.closest?.("[data-tip],[data-tip-disabled]");
    if (!t || tipManual) return;
    const text = t.dataset.tipDisabled || t.dataset.tip;
    if (!text) return;
    tipTarget = t;
    showTip(text, t.getBoundingClientRect());
  };
  const hide = (e) => {
    if (tipManual) return;
    const t = e.target.closest?.("[data-tip],[data-tip-disabled]");
    if (t && t === tipTarget && !(e.relatedTarget && t.contains(e.relatedTarget))) hideTip();
  };
  document.addEventListener("mouseover", show);
  document.addEventListener("mouseout", hide);
  document.addEventListener("focusin", show);
  document.addEventListener("focusout", hide);
  document.addEventListener("scroll", () => !tipManual && hideTip(), true);
}

export function showTip(content, rect, { manual = false, html = false } = {}) {
  if (!tipEl) return;
  tipManual = manual;
  if (content instanceof Node) tipEl.replaceChildren(content);
  else if (html) tipEl.replaceChildren(content);
  else tipEl.textContent = String(content);
  tipEl.hidden = false;
  tipEl.classList.add("is-on");
  const tw = tipEl.offsetWidth;
  const th = tipEl.offsetHeight;
  const vw = document.documentElement.clientWidth;
  let x = rect.left + rect.width / 2 - tw / 2;
  let y = rect.top - th - 8;
  if (y < 6) y = rect.bottom + 8;
  x = Math.max(6, Math.min(vw - tw - 6, x));
  tipEl.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}

export function hideTip() {
  if (!tipEl) return;
  tipManual = false;
  tipTarget = null;
  tipEl.classList.remove("is-on");
  tipEl.hidden = true;
}

// ---------------------------------------------------------------- toasts
const TOAST_ICONS = { info: "info", success: "check", warn: "alert", danger: "alert", pit: "wrench", flag: "flag", accent: "bolt" };

export function toast({ title, message, kind = "info", timeout = 5200, iconName: iconOverride }) {
  const root = document.getElementById("toasts");
  if (!root) return;
  const close = h("button", { class: "toast-x", type: "button", "aria-label": "Dismiss notification" }, icon("close", { size: 14 }));
  const el = h(
    "div",
    { class: `toast toast-${kind}`, role: kind === "danger" ? "alert" : "status" },
    h("span", { class: "toast-ico" }, icon(iconOverride || TOAST_ICONS[kind] || "info", { size: 16 })),
    h("div", { class: "toast-body" }, title ? h("strong", { class: "toast-title", text: title }) : null, message ? h("span", { class: "toast-msg", text: message }) : null),
    close,
  );
  const remove = () => {
    if (!el.isConnected) return;
    el.classList.add("is-leaving");
    setTimeout(() => el.remove(), reducedMotion() ? 0 : 220);
  };
  close.addEventListener("click", remove);
  root.prepend(el);
  while (root.children.length > 5) root.lastElementChild.remove();
  let timer = setTimeout(remove, timeout);
  el.addEventListener("mouseenter", () => clearTimeout(timer));
  el.addEventListener("mouseleave", () => (timer = setTimeout(remove, 2500)));
  return remove;
}

// ---------------------------------------------------------------- modals
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
const stack = [];

export function topOverlay() {
  return stack[stack.length - 1] || null;
}

export function trapFocus(container, e) {
  const items = $$(FOCUSABLE, container).filter((x) => x.offsetParent !== null || x === document.activeElement);
  if (!items.length) {
    e.preventDefault();
    container.focus();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && (document.activeElement === first || !container.contains(document.activeElement))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (document.activeElement === last || !container.contains(document.activeElement))) {
    e.preventDefault();
    first.focus();
  }
}

// Register a custom overlay (drawer etc.) in the Esc/focus stack.
export function pushOverlay(entry) {
  stack.push(entry);
  return () => {
    const i = stack.indexOf(entry);
    if (i >= 0) stack.splice(i, 1);
  };
}

document.addEventListener(
  "keydown",
  (e) => {
    const top = topOverlay();
    if (!top) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      top.close();
    } else if (e.key === "Tab" && top.trap !== false) {
      trapFocus(top.el, e);
    }
  },
  true,
);

let modalSeq = 0;

export function openModal({ title, subtitle, body, footer, size = "md", className = "", onClose, labelText }) {
  const root = document.getElementById("modal-root");
  const id = `modal-${++modalSeq}`;
  const prevFocus = document.activeElement;
  const closeBtn = h("button", { class: "icon-btn modal-x", type: "button", "aria-label": "Close dialog" }, icon("close", { size: 18 }));
  const dialog = h(
    "div",
    { class: `modal modal-${size} ${className}`.trim(), role: "dialog", "aria-modal": "true", "aria-labelledby": `${id}-title`, tabindex: "-1" },
    h("header", { class: "modal-head" },
      h("div", { class: "modal-titles" },
        h("h2", { class: "modal-title", id: `${id}-title`, text: title || labelText || "Dialog" }),
        subtitle ? h("p", { class: "modal-sub", text: subtitle }) : null),
      closeBtn),
    h("div", { class: "modal-body" }, body),
    footer ? h("footer", { class: "modal-foot" }, footer) : null,
  );
  const backdrop = h("div", { class: "modal-backdrop" }, dialog);
  let closed = false;
  const entry = {
    el: dialog,
    close() {
      if (closed) return;
      closed = true;
      unregister();
      backdrop.classList.add("is-leaving");
      setTimeout(() => backdrop.remove(), reducedMotion() ? 0 : 180);
      onClose?.();
      if (dialog.contains(document.activeElement)) document.activeElement.blur();
      if (prevFocus && prevFocus.isConnected && prevFocus !== document.body) prevFocus.focus({ preventScroll: true });
    },
  };
  const unregister = pushOverlay(entry);
  closeBtn.addEventListener("click", () => entry.close());
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) entry.close();
  });
  root.append(backdrop);
  setTimeout(() => {
    const auto = dialog.querySelector("[autofocus]") || $(FOCUSABLE, dialog.querySelector(".modal-body")) || closeBtn;
    (auto || dialog).focus({ preventScroll: true });
  }, 0);
  return entry;
}

export function confirmDialog({ title, message, confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false }) {
  return new Promise((resolve) => {
    let result = false;
    const ok = h("button", { class: `btn ${danger ? "btn-danger" : "btn-primary"}`, type: "button", autofocus: true, text: confirmLabel });
    const cancel = h("button", { class: "btn btn-ghost", type: "button", text: cancelLabel });
    const m = openModal({
      title,
      size: "sm",
      body: h("p", { class: "confirm-msg", text: message }),
      footer: [cancel, ok],
      onClose: () => resolve(result),
    });
    ok.addEventListener("click", () => {
      result = true;
      m.close();
    });
    cancel.addEventListener("click", () => m.close());
  });
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: filename, style: { display: "none" } });
  document.body.append(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 1000);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h("textarea", { style: { position: "fixed", opacity: 0 } });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

export function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}
