import { sendText } from "../services/whinself.js";

function ensure(obj, key, fallback) {
  if (!obj[key] || typeof obj[key] !== typeof fallback) obj[key] = fallback;
  return obj[key];
}

function hasAll(haystack = [], needles = []) {
  const set = new Set(haystack || []);
  return (needles || []).every((n) => set.has(n));
}

function chapterRequirementsSatisfied({ game, state, chapter }) {
  const cfg = game?.progression?.chapters?.[String(chapter)];
  if (!cfg || !cfg.requires) return false; // nothing to satisfy
  const req = cfg.requires;

  // Normalize state
  ensure(state, "flags", {});
  ensure(state, "inventory", []);
  ensure(state, "talkedTo", []);

  // Check basic keys if present
  if (req.location && state.location !== req.location) return false;
  if (
    typeof req.inStructure === "boolean" &&
    !!state.inStructure !== !!req.inStructure
  )
    return false;
  if (Array.isArray(req.items) && !hasAll(state.inventory, req.items))
    return false;
  if (Array.isArray(req.talkedTo) && !hasAll(state.talkedTo, req.talkedTo))
    return false;

  // Optional flags: all must be true
  if (
    Array.isArray(req.flags) &&
    !hasAll(
      Object.keys(state.flags).filter((k) => state.flags[k]),
      req.flags
    )
  )
    return false;

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

  const ok = chapterRequirementsSatisfied({ game, state, chapter });
  if (!ok) return false;

  const summary =
    cfg.summaryTpl ||
    `Chapter ${chapter} complete. The city shifts. New leads emerge.`;

  await sendText(jid, summary);

  // mark and advance
  state.flags[doneFlag] = true;
  state.chapter = chapter + 1;
  return true;
}
