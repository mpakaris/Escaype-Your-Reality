import { sendText, sendMedia } from "../services/whinself.js";
import { tpl } from "../services/renderer.js";
import { onChapterComplete } from "./hooks.js";

function ensure(obj, key, fallback) {
  if (!obj[key] || typeof obj[key] !== typeof fallback) obj[key] = fallback;
  return obj[key];
}

function hasAll(haystack = [], needles = []) {
  const set = new Set(haystack || []);
  return (needles || []).every((n) => set.has(n));
}

function hasFlag(state, id) {
  return !!(state?.flags && state.flags[id]);
}
function hasItem(state, id) {
  return Array.isArray(state?.inventory) && state.inventory.includes(id);
}

function getCounter(state, key) {
  if (!state || !state.counters) return 0;
  const v = state.counters[key];
  return Number.isFinite(v) ? v : 0;
}

function evalDSL(state, req) {
  if (!req || typeof req !== "object") return true;

  if (req.allOf) return (req.allOf || []).every((r) => evalDSL(state, r));
  if (req.anyOf) return (req.anyOf || []).some((r) => evalDSL(state, r));
  if (req.not) return !evalDSL(state, req.not);

  if (typeof req.flag === "string") return hasFlag(state, req.flag);
  if (typeof req.item === "string") return hasItem(state, req.item);
  if (req.counterAtLeast && typeof req.counterAtLeast === "object") {
    const { key, value } = req.counterAtLeast;
    return getCounter(state, key) >= (value ?? 0);
  }
  if (typeof req.locationIs === "string")
    return state?.location === req.locationIs;
  if (typeof req.structureIs === "string")
    return (
      state?.structure === req.structureIs ||
      state?.inStructure === req.structureIs
    );

  // Unknown predicate -> ignore by treating as true to avoid hard failures
  return true;
}

function explainLeaf(state, req) {
  if (typeof req.flag === "string") {
    return hasFlag(state, req.flag) ? [] : [`Missing flag: ${req.flag}`];
  }
  if (typeof req.item === "string") {
    return hasItem(state, req.item) ? [] : [`Missing item: ${req.item}`];
  }
  if (req.counterAtLeast && typeof req.counterAtLeast === "object") {
    const { key, value } = req.counterAtLeast;
    return getCounter(state, key) >= (value ?? 0)
      ? []
      : [`Counter '${key}' must be ≥ ${value}`];
  }
  if (typeof req.locationIs === "string") {
    return state?.location === req.locationIs
      ? []
      : [`Location must be '${req.locationIs}'`];
  }
  if (typeof req.structureIs === "string") {
    const ok =
      state?.structure === req.structureIs ||
      state?.inStructure === req.structureIs;
    return ok ? [] : [`Structure must be '${req.structureIs}'`];
  }
  return [];
}

function unmetReasonsDSL(state, req) {
  if (!req || typeof req !== "object") return [];
  if (req.allOf) {
    const reasons = [];
    for (const r of req.allOf) reasons.push(...unmetReasonsDSL(state, r));
    return reasons;
  }
  if (req.anyOf) {
    const childReasons = req.anyOf.map((r) => unmetReasonsDSL(state, r));
    const anyOk = childReasons.some((arr) => arr.length === 0);
    return anyOk ? [] : childReasons.flat();
  }
  if (req.not) {
    const inner = unmetReasonsDSL(state, req.not);
    const innerOk = inner.length === 0;
    return innerOk ? ["NOT condition failed"] : [];
  }
  return explainLeaf(state, req);
}

export function unmetReasons(state, requires) {
  if (!requires || typeof requires !== "object") return [];
  const dslKeys = [
    "allOf",
    "anyOf",
    "not",
    "flag",
    "item",
    "counterAtLeast",
    "locationIs",
    "structureIs",
  ];
  const hasDSL = Object.keys(requires).some((k) => dslKeys.includes(k));
  const dsl = hasDSL ? requires : legacyToDSL(requires);
  return dsl ? unmetReasonsDSL(state, dsl) : [];
}

function legacyToDSL(requires) {
  if (!requires || typeof requires !== "object") return null;
  const clauses = [];
  if (requires.location) clauses.push({ locationIs: requires.location });
  if (typeof requires.inStructure === "boolean")
    clauses.push({ structureIs: requires.inStructure });
  if (Array.isArray(requires.items) && requires.items.length) {
    clauses.push({ allOf: requires.items.map((id) => ({ item: id })) });
  }
  if (Array.isArray(requires.flags) && requires.flags.length) {
    clauses.push({ allOf: requires.flags.map((id) => ({ flag: id })) });
  }
  if (Array.isArray(requires.talkedTo) && requires.talkedTo.length) {
    clauses.push({
      allOf: requires.talkedTo.map((npc) => ({
        anyOf: [
          { flag: `met_npc:${npc}` },
          { flag: `truth_unlocked_npc:${npc}` },
          { flag: `talked_to:${npc}` },
        ],
      })),
    });
  }
  if (clauses.length === 0) return null;
  return clauses.length === 1 ? clauses[0] : { allOf: clauses };
}

export function evaluateRequirements(state, requires) {
  if (!requires || typeof requires !== "object") return false;

  // If it looks like DSL, evaluate directly
  const dslKeys = [
    "allOf",
    "anyOf",
    "not",
    "flag",
    "item",
    "counterAtLeast",
    "locationIs",
    "structureIs",
  ];
  const hasDSL = Object.keys(requires).some((k) => dslKeys.includes(k));
  if (hasDSL) return evalDSL(state, requires);

  // Fallback to legacy semantics converted to DSL
  const dsl = legacyToDSL(requires);
  return dsl ? evalDSL(state, dsl) : true;
}

/**
 * Checks current chapter requirements and advances to next one if met.
 * Returns true if a progression event fired, else false.
 */
export async function checkAndAdvanceChapter({ jid, game, state }) {
  // Normalize chapter
  if (!Number.isInteger(state.chapter) || state.chapter <= 0) state.chapter = 1;

  const chapter = state.chapter;
  const cfg = game?.progression?.chapters?.[String(chapter)];
  if (!cfg) return false; // no rules for this chapter

  // Prevent repeat notifications
  const doneFlag = `chapter_${chapter}_done`;
  ensure(state, "flags", {});
  if (state.flags[doneFlag]) return false;

  const requires = game?.progression?.chapters?.[String(chapter)]?.requires;
  const ok = evaluateRequirements(state, requires);
  if (!ok) return false;

  const summaryObj = cfg.summary;
  if (
    summaryObj &&
    Array.isArray(summaryObj.media) &&
    summaryObj.media.length
  ) {
    await sendMedia(jid, summaryObj.media);
    if (summaryObj.textTpl) {
      const text = tpl(game?.ui, summaryObj.textTpl, summaryObj.vars || {});
      if (text) await sendText(jid, text);
    }
  } else if (cfg.summaryVideo) {
    await sendMedia(jid, { type: "video", url: cfg.summaryVideo });
  } else {
    const summaryText =
      tpl(game?.ui, "chapter.complete", { chapter }) ||
      cfg.summaryTpl ||
      `Chapter ${chapter} complete.`;
    await sendText(jid, summaryText);
  }

  try {
    await onChapterComplete({ jid, game, state }, cfg);
  } catch {}

  // mark and advance
  state.flags[doneFlag] = true;
  if (!Array.isArray(state.chaptersCompleted)) state.chaptersCompleted = [];
  if (!state.chaptersCompleted.includes(chapter))
    state.chaptersCompleted.push(chapter);
  state.chapter = chapter + 1;
  return true;
}
