import { renderStep, resolveMedia } from "../services/renderer.js";
import { sendImage, sendText } from "../services/whinself.js";

function getSequences(game, type) {
  const buckets = game.sequences || {};
  return buckets[type] || [];
}

export async function run({ jid, user, game, state }) {
  if (!state.flow?.active) {
    await sendText(jid, "Nothing to continue.");
    return;
  }
  const { type, seq, step } = state.flow;
  const sequences = getSequences(game, type);
  if (seq >= sequences.length) {
    await sendText(jid, "Nothing more to show.");
    return;
  }
  const cur = sequences[seq];

  if (step === 0 && cur.header && !state.flow._headerShown) {
    await sendText(jid, cur.header);
    state.flow._headerShown = true;
  }

  const total = cur.steps?.length || 0;
  while (state.flow.step < total) {
    const s = cur.steps[state.flow.step];
    if (s?.type === "image") {
      const url = resolveMedia(game, "image", s.url || s.id);
      if (url) await sendImage(jid, url, s.caption);
    } else {
      await renderStep(jid, game, s);
    }
    state.flow.step += 1;
  }

  // finished this sequence, move to next one
  state.flow.seq += 1;
  state.flow.step = 0;

  if (state.flow.seq >= sequences.length) {
    await sendText(jid, "End of introduction. Type /exit to start the game.");
  } else {
    // Prepare for next sequence; header will be sent on the next /next
    state.flow._headerShown = false;
  }
}
