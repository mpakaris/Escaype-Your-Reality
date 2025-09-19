// src/services/renderer.js
import { sendMedia, sendText } from "./whinself.js";

export function tpl(ui, key, vars = {}) {
  const dict = ui?.templates || ui || {};
  let v = dict[key];
  if (v == null) return "";

  // If template value is an array of strings, pick one (simple random for now)
  if (Array.isArray(v)) {
    if (v.length === 0) return "";
    v = v[Math.floor(Math.random() * v.length)];
  }

  const s = String(v);
  // First replace double-brace {{var}}, then single-brace {var}
  return s
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) =>
      Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : ""
    )
    .replace(/\{\s*(\w+)\s*\}/g, (_, k) =>
      Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : ""
    );
}

export function resolveMedia(game, type, idOrUrl) {
  if (!idOrUrl) return null;
  const val = String(idOrUrl);
  if (val.startsWith("http")) return val;

  // Cartridge media buckets take precedence
  const bucketName = type === "image" ? "images" : type;
  const bucket = game.media?.[bucketName] || {};
  if (bucket && bucket[val]) return bucket[val];

  // Fallback to baseUrl + relative path
  const base = game.media?.baseUrl;
  if (base) return `${base.replace(/\/$/, "")}/${val.replace(/^\//, "")}`;
  return null;
}

function toMediaRef(game, ref) {
  if (!ref) return null;
  if (typeof ref === "string") {
    // default to document type when only URL/id is given
    const url = resolveMedia(game, "doc", ref) || ref;
    return { type: "doc", url };
  }
  const type = ref.type || "doc";
  const url = resolveMedia(game, type, ref.url || ref.id) || ref.url || ref.id;
  if (!url) return null;
  const out = { type, url };
  if (ref.caption) out.caption = ref.caption;
  if (ref.thumb) out.thumb = ref.thumb;
  if (ref.filename) out.filename = ref.filename;
  return out;
}

export async function renderStep(jid, game, step) {
  if (!step) return;

  // Support cartridge-style response blocks: { textTpl, media: [...] }
  if (Array.isArray(step.media) || step.textTpl) {
    if (Array.isArray(step.media) && step.media.length) {
      const list = step.media.map((m) => toMediaRef(game, m)).filter(Boolean);
      if (list.length) await sendMedia(jid, list);
    }
    if (step.textTpl) {
      const text = tpl(game.ui, step.textTpl, step.vars || {});
      if (text) await sendText(jid, text);
    }
    return;
  }

  // Legacy step.type handling
  switch (step.type) {
    case "narrator":
    case "text": {
      const text = step.textTpl
        ? tpl(game.ui, step.textTpl, step.vars || {})
        : step.text || "";
      if (text) await sendText(jid, text);
      break;
    }
    case "image": {
      const url = resolveMedia(game, "image", step.url || step.id);
      if (url)
        await sendMedia(jid, { type: "image", url, caption: step.caption });
      break;
    }
    case "audio": {
      const url = resolveMedia(game, "audio", step.url || step.id);
      if (url)
        await sendMedia(jid, { type: "audio", url, caption: step.caption });
      break;
    }
    case "video": {
      const url = resolveMedia(game, "video", step.url || step.id);
      if (url)
        await sendMedia(jid, { type: "video", url, caption: step.caption });
      break;
    }
    case "document": {
      const url = resolveMedia(game, "document", step.url || step.id);
      if (url)
        await sendMedia(jid, {
          type: "doc",
          url,
          filename: step.filename || "doc",
        });
      break;
    }
    default: {
      const text = step.textTpl
        ? tpl(game.ui, step.textTpl, step.vars || {})
        : step.text || "";
      if (text) await sendText(jid, text);
    }
  }
}

export { sendMedia, sendText };
