"use strict";

// Declarative effects executor.
// Supported effects:
//  - { setFlag: string }
//  - { incCounter: string, by?: number }
//  - { revealItems: string[] }
//  - { sendMedia: MediaRef[] }
//  - { sendTextTpl: string, vars?: Record<string,any> }
// Where MediaRef = { type: 'video'|'audio'|'image'|'doc', url: string, caption?: string, thumb?: string }

import {
  sendAudio,
  sendDocument,
  sendImage,
  sendText,
  sendVideo,
} from "./whinself.js";

function ensureArray(val) {
  return Array.isArray(val) ? val : val == null ? [] : [val];
}

function setFlag(state, flag) {
  if (!flag) return;
  if (!state.flags) state.flags = Array.isArray(state.flags) ? state.flags : [];
  if (Array.isArray(state.flags)) {
    if (!state.flags.includes(flag)) state.flags.push(flag);
  } else if (state.flags && typeof state.flags === "object") {
    state.flags[flag] = true;
  }
}

function incCounter(state, key, by = 1) {
  if (!state.counters) state.counters = {};
  const cur = Number.isFinite(state.counters[key])
    ? Number(state.counters[key])
    : 0;
  state.counters[key] = cur + (Number.isFinite(by) ? by : 1);
}

function revealItems(state, items) {
  if (!items || !items.length) return;
  if (!state.visibleItems) state.visibleItems = [];
  for (const id of items)
    if (!state.visibleItems.includes(id)) state.visibleItems.push(id);
}

function tpl(ui, key, vars = {}) {
  const dict = ui?.templates || ui || {};
  const s = dict[key];
  if (!s) return "";
  return String(s).replace(/\{\{(\w+)\}\}/g, (_, k) =>
    k in vars ? String(vars[k]) : ""
  );
}

async function routeMedia(jid, m) {
  if (!m || !m.url) return;
  const type = (m.type || "").toLowerCase();
  const caption = m.caption || "";
  try {
    if (type === "video" && typeof sendVideo === "function")
      return await sendVideo(jid, m.url, caption);
    if (type === "audio" && typeof sendAudio === "function")
      return await sendAudio(jid, m.url, caption);
    if (type === "image" && typeof sendImage === "function")
      return await sendImage(jid, m.url, caption);
    if (type === "doc" && typeof sendDocument === "function")
      return await sendDocument(jid, m.url, caption);
  } catch (e) {
    // fall through to text if media fails
  }
  if (typeof sendText === "function") return await sendText(jid, m.url);
}

export async function applyEffects(ctx, effects) {
  const { state, game, jid } = ctx;
  const ui = (game && game.ui && game.ui.templates) || game.ui || {};
  const list = ensureArray(effects);
  if (list.length === 0) return;

  if (!state.log) state.log = [];

  for (const eff of list) {
    if (!eff || typeof eff !== "object") continue;

    if (typeof eff.setFlag === "string") {
      setFlag(state, eff.setFlag);
      state.log.push({ t: Date.now(), type: "setFlag", flag: eff.setFlag });
      continue;
    }

    if (typeof eff.incCounter === "string") {
      incCounter(state, eff.incCounter, eff.by);
      state.log.push({
        t: Date.now(),
        type: "incCounter",
        key: eff.incCounter,
        by: eff.by ?? 1,
      });
      continue;
    }

    if (Array.isArray(eff.revealItems)) {
      revealItems(state, eff.revealItems);
      state.log.push({
        t: Date.now(),
        type: "revealItems",
        items: eff.revealItems,
      });
      continue;
    }

    if (Array.isArray(eff.sendMedia)) {
      for (const m of eff.sendMedia) await routeMedia(jid, m);
      state.log.push({
        t: Date.now(),
        type: "sendMedia",
        count: eff.sendMedia.length,
      });
      continue;
    }

    if (typeof eff.sendTextTpl === "string") {
      const text = tpl(ui, eff.sendTextTpl, eff.vars || {});
      if (text && typeof sendText === "function") await sendText(jid, text);
      state.log.push({
        t: Date.now(),
        type: "sendTextTpl",
        key: eff.sendTextTpl,
      });
      continue;
    }
  }
}
