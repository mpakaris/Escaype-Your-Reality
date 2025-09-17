import { sendText, sendVideo } from "../services/whinself.js";

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

export function evaluateRequirements(state, requires) {
  if (!requires || typeof requires !== "object") return false;

  if (requires.location && state.location !== requires.location) return false;
  if (
    typeof requires.inStructure === "boolean" &&
    state.inStructure !== requires.inStructure
  )
    return false;

  if (Array.isArray(requires.items)) {
    for (const id of requires.items) if (!hasItem(state, id)) return false;
  }
  if (Array.isArray(requires.flags)) {
    for (const id of requires.flags) if (!hasFlag(state, id)) return false;
  }
  if (Array.isArray(requires.talkedTo)) {
    const legacy = Array.isArray(state.talkedTo) ? state.talkedTo : [];
    for (const npc of requires.talkedTo) {
      const met =
        legacy.includes(npc) ||
        hasFlag(state, `met_npc:${npc}`) ||
        hasFlag(state, `truth_unlocked_npc:${npc}`);
      if (!met) return false;
    }
  }
  return true;
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

  if (cfg.summaryVideo) {
    await sendVideo(jid, cfg.summaryVideo);
  } else {
    const summary =
      cfg.summaryTpl ||
      `Chapter ${chapter} complete. The city shifts. New leads emerge.`;
    await sendText(jid, summary);
  }

  // mark and advance
  state.flags[doneFlag] = true;
  if (!Array.isArray(state.chaptersCompleted)) state.chaptersCompleted = [];
  if (!state.chaptersCompleted.includes(chapter))
    state.chaptersCompleted.push(chapter);
  state.chapter = chapter + 1;
  return true;
}
