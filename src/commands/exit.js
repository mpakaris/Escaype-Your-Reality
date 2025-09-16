import { endSequence } from "../game/flow.js";
import { sendImage, sendText } from "../services/whinself.js";

function getSequences(game, type) {
  const buckets = game.sequences || {};
  return buckets[type] || [];
}

function clearActiveNpc(state) {
  if (state && Object.prototype.hasOwnProperty.call(state, "activeNpc")) {
    delete state.activeNpc;
  }
}

async function sendExitToStreetSet(jid, game, state) {
  const loc = state?.location
    ? (game.locations || []).find((l) => l.id === state.location)
    : null;

  let emitted = false;
  if (loc) {
    if (loc.onExitImage) {
      try {
        await sendImage(jid, String(loc.onExitImage), loc.name || "");
        emitted = true;
      } catch {}
    }
    if (Array.isArray(loc.onExit)) {
      for (const line of loc.onExit) {
        if (line && line.text) {
          await sendText(jid, line.text);
          emitted = true;
        }
      }
    }
    if (emitted) return;
  }

  // Fallback if no dedicated exit content
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

    clearActiveNpc(state);

    await sendExitToStreetSet(jid, game, state);
    return;
  }

  // MODE 2: if already inside a structure, /exit returns to the street (same intersection)
  if (state.inStructure) {
    const loc = state?.location
      ? (game.locations || []).find((l) => l.id === state.location)
      : null;
    const struct =
      loc && state?.structureId
        ? (loc.structures || []).find((s) => s.id === state.structureId)
        : null;

    // Clear structure state
    state.inStructure = false;
    state.structureId = null;
    state.roomId = null;

    clearActiveNpc(state);

    // Prefer structure-level onExit content if present
    if (struct && (struct.onExitImage || Array.isArray(struct.onExit))) {
      if (struct.onExitImage) {
        try {
          await sendImage(
            jid,
            String(struct.onExitImage),
            struct.displayName || struct.id || ""
          );
        } catch {}
      }
      if (Array.isArray(struct.onExit)) {
        for (const line of struct.onExit) {
          if (line && line.text) await sendText(jid, line.text);
        }
      }
      return;
    }

    // Else use location-level exit content
    await sendExitToStreetSet(jid, game, state);
    return;
  }

  // Otherwise nothing to exit
  await sendText(jid, game.ui?.templates?.whereToNext || "Where to next?");
}
