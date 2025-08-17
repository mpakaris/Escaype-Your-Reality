import { endSequence } from "../game/flow.js";
import { resolveMedia } from "../services/renderer.js";
import { sendImage, sendText } from "../services/whinself.js";

function getSequences(game, type) {
  const buckets = game.sequences || {};
  return buckets[type] || [];
}

async function sendExitToStreetSet(jid, game) {
  // show exit image if defined
  const onExitBo = game.media?.onExitBo;
  if (onExitBo?.type === "image") {
    const url = resolveMedia(game, "image", onExitBo.id || onExitBo.url);
    if (url) await sendImage(jid, url);
  }

  // render exitToStreet template if available
  const tplArr = game.ui?.templates?.exitToStreet;
  if (Array.isArray(tplArr) && tplArr.length) {
    const moodPool = game.ui?.streetExitMoodPool || [];
    const prompts = game.ui?.streetExitPrompts || [];
    const weatherPool = game.ui?.weatherPool || [];
    const activityPool = game.ui?.activityPool || [];

    const mood = moodPool.length
      ? moodPool[Math.floor(Math.random() * moodPool.length)]
      : "";
    const prompt = prompts.length
      ? prompts[Math.floor(Math.random() * prompts.length)]
      : game.ui?.templates?.whereToNext || "Where to next?";
    const weather = weatherPool.length
      ? weatherPool[Math.floor(Math.random() * weatherPool.length)]
      : "";
    const activity = activityPool.length
      ? activityPool[Math.floor(Math.random() * activityPool.length)]
      : "";

    for (const line of tplArr) {
      const msg = String(line)
        .replace("{weather}", weather)
        .replace("{activity}", activity)
        .replace("{mood}", mood)
        .replace("{prompt}", prompt);
      if (msg.trim()) await sendText(jid, msg);
    }
    return;
  }

  // fallback
  await sendText(jid, game.ui?.templates?.whereToNext || "Where to next?");
}

export async function run({ jid, user, game, state }) {
  // MODE 1: if intro sequence is active, /exit finishes intro at the end only
  if (state.flow?.active && state.flow.type === "intro") {
    const sequences = getSequences(game, "intro");
    const atEnd = (state.flow.seq || 0) >= sequences.length;
    if (!atEnd) {
      await sendText(jid, "Finish the introduction first. Use /next.");
      return;
    }

    endSequence(state);
    state.flags = state.flags || {};
    state.flags.introSequenceSeen = true;

    const start = game.special?.start;
    if (start) {
      state.location = start.place || null;
      state.inStructure = !!start.inStructure;
      state.structureId = start.inStructure ? start.place : null;
      if (typeof start.pendingChapterOnExit === "number")
        state.chapter = start.pendingChapterOnExit - 1;
    }

    await sendExitToStreetSet(jid, game);
    return;
  }

  // MODE 2: if already inside a structure, /exit returns to the street (same intersection)
  if (state.inStructure) {
    state.inStructure = false;
    state.structureId = null;
    state.roomId = null;
    await sendExitToStreetSet(jid, game);
    return;
  }

  // Otherwise nothing to exit
  await sendText(jid, game.ui?.templates?.whereToNext || "Where to next?");
}
