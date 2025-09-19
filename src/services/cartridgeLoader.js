function _toDSL(req, src = {}) {
  if (!req || typeof req !== "object") {
    // Legacy convenience: build from top-level flags/items if present on chapter
    const parts = [];
    if (Array.isArray(src.flags))
      parts.push(...src.flags.map((f) => ({ flag: String(f) })));
    if (Array.isArray(src.items))
      parts.push(...src.items.map((i) => ({ item: String(i) })));
    return parts.length ? { allOf: parts } : req;
  }
  // If already DSL-like, pass through
  if (
    req.allOf ||
    req.anyOf ||
    req.not ||
    req.flag ||
    req.item ||
    req.counterAtLeast ||
    req.locationIs ||
    req.structureIs
  )
    return req;
  const parts = [];
  if (Array.isArray(req.flags))
    parts.push(...req.flags.map((f) => ({ flag: String(f) })));
  if (Array.isArray(req.items))
    parts.push(...req.items.map((i) => ({ item: String(i) })));
  return parts.length ? { allOf: parts } : req;
}

function _toSummary(ch) {
  if (ch.summary && typeof ch.summary === "object") return ch.summary;
  const media = [];
  if (typeof ch.summaryVideo === "string" && ch.summaryVideo.trim()) {
    media.push({ type: "video", url: ch.summaryVideo.trim() });
  }
  const textTpl =
    typeof ch.summaryTpl === "string" && ch.summaryTpl.trim()
      ? ch.summaryTpl.trim()
      : undefined;
  if (media.length || textTpl) {
    const out = {};
    if (textTpl) out.textTpl = textTpl;
    if (media.length) out.media = media;
    return out;
  }
  return undefined;
}

function normalizeCartridgeShape(c) {
  const out = { ...c };
  if (out.progression && out.progression.chapters) {
    const ch = out.progression.chapters;
    if (Array.isArray(ch)) {
      // already array
    } else if (ch && typeof ch === "object") {
      // Single chapter object?
      if (
        (ch.id && (ch.requires || ch.flags || ch.items)) ||
        (ch.title && (ch.requires || ch.flags || ch.items))
      ) {
        out.progression = { ...out.progression, chapters: [ch] };
      } else {
        // Numeric-keyed map -> array sorted by key
        const entries = Object.entries(ch)
          .filter(
            ([k, v]) => /^\d+$/.test(String(k)) && v && typeof v === "object"
          )
          .sort((a, b) => Number(a[0]) - Number(b[0]))
          .map(([k, v]) => ({ id: String(k), ...v }));
        if (entries.length) {
          out.progression = { ...out.progression, chapters: entries };
        }
      }
    }

    if (Array.isArray(out.progression.chapters)) {
      out.progression.chapters = out.progression.chapters.map((src, idx) => {
        const id = src.id || String(src.chapter || src.name || idx + 1);
        const requires = _toDSL(src.requires, src);
        const summary = _toSummary(src);
        const cleaned = {
          id,
          ...(src.title ? { title: src.title } : {}),
          ...(requires ? { requires } : {}),
          ...(summary ? { summary } : {}),
        };
        if (src.onChapterComplete)
          cleaned.onChapterComplete = src.onChapterComplete;
        return cleaned;
      });
    }
  }
  return out;
}
("use strict");

import fs from "fs";
import path from "path";
import {
  assertValidCartridge,
  validateByDef,
  validateJsonlArray,
} from "./schemaValidator.js";

export function readJson(file) {
  const raw = fs.readFileSync(file, "utf8");
  return JSON.parse(raw);
}

export function readJsonl(file) {
  const raw = fs.readFileSync(file, "utf8");
  const trimmed = raw.replace(/^\uFEFF/, "").trim();

  // Fallbacks: accept full JSON object or array stored in a .jsonl file
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed);
      return [obj];
    } catch (_) {
      // continue to per-line parsing below
    }
  }
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed);
      return Array.isArray(arr) ? arr : [];
    } catch (_) {
      // continue to per-line parsing below
    }
  }

  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    try {
      out.push(JSON.parse(l));
    } catch (e) {
      const err = new Error(
        `Invalid JSONL at ${path.basename(file)}:${i + 1} -> ${e.message}`
      );
      err.cause = e;
      throw err;
    }
  }
  return out;
}

function fileIfExists(p) {
  try {
    fs.accessSync(p, fs.constants.R_OK);
    return p;
  } catch (_) {
    return null;
  }
}

function loadSequence(dir, base) {
  const jsonl = fileIfExists(path.join(dir, `${base}.jsonl`));
  const json = fileIfExists(path.join(dir, `${base}.json`));
  if (!jsonl && !json) return [];
  const seq = jsonl ? readJsonl(jsonl) : readJson(json);
  try {
    const v = validateByDef("sequence", seq);
    if (!v.ok)
      throw new Error(`${base}.* failed schema: ${JSON.stringify(v.errors)}`);
    return seq;
  } catch (e) {
    console.warn(
      `[cartridgeLoader] Skipping ${base} due to schema mismatch:`,
      e?.message || e
    );
    return [];
  }
}

function loadCatalogue(dir, names) {
  for (const n of names) {
    const jsonl = fileIfExists(path.join(dir, `${n}.jsonl`));
    const json = fileIfExists(path.join(dir, `${n}.json`));
    if (jsonl || json) return jsonl ? readJsonl(jsonl) : readJson(json);
  }
  return [];
}

function validateWorld({ locations, objects, npcs, items }) {
  const sets = [
    ["location", locations],
    ["object", objects],
    ["npc", npcs],
    ["item", items],
  ];
  for (const [def, arr] of sets) {
    if (!Array.isArray(arr) || arr.length === 0) continue;
    const v = validateJsonlArray(def, arr);
    if (!v.ok)
      throw new Error(
        `${def} catalogue failed schema: ${JSON.stringify(v.errors)}`
      );
  }
}

function mergeGeneralObject(dir) {
  const json = fileIfExists(path.join(dir, "general_object.json"));
  const jsonl = fileIfExists(path.join(dir, "general_object.jsonl"));
  if (!json && !jsonl)
    throw new Error(`Missing general_object.json(l) in ${dir}`);
  if (json) return readJson(json);
  const arr = readJsonl(jsonl);
  // Later lines override earlier; shallow merge is sufficient for top-level keys
  return Object.assign({}, ...arr);
}

export function loadCartridgeFromDir(dir) {
  const general = mergeGeneralObject(dir);

  const intro = loadSequence(dir, "intro");
  const tutorial = loadSequence(dir, "tutorial");

  const locations = loadCatalogue(dir, [
    "locations",
    "location",
    "locations_catalogue",
    "location_catalogue",
  ]);
  const objects = loadCatalogue(dir, [
    "objects",
    "object",
    "objects_catalogue",
    "object_catalogue",
  ]);
  const npcs = loadCatalogue(dir, [
    "npcs",
    "npc",
    "npcs_catalogue",
    "npc_catalogue",
  ]);
  const items = loadCatalogue(dir, [
    "items",
    "item",
    "items_catalogue",
    "item_catalogue",
  ]);

  validateWorld({ locations, objects, npcs, items });

  const cartridge = {
    ...general,
    intro,
    tutorial,
    world: { locations, objects, npcs, items },
  };
  const normalized = normalizeCartridgeShape(cartridge);
  // Final validation at root level
  assertValidCartridge(normalized);
  return normalized;
}

export default {
  readJson,
  readJsonl,
  loadCartridgeFromDir,
};
