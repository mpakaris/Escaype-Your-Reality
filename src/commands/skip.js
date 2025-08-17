import { sendText } from "../services/whinself.js";
import { run as nextRun } from "./next.js";

export async function run({ jid, user, game, state }) {
  // DEV-only guard
  if (process.env.CODING_ENV !== "DEV") {
    await sendText(jid, "Command not available.");
    return;
  }

  // Must be in intro flow to skip
  if (!state.flow?.active || state.flow.type !== "intro") {
    await sendText(jid, "Nothing to skip.");
    return;
  }

  const sequences = game.sequences?.intro || [];
  if (!sequences.length) {
    await sendText(jid, "No intro defined.");
    return;
  }

  const lastSeqIndex = sequences.length - 1;
  const lastSteps = sequences[lastSeqIndex]?.steps?.length || 0;
  if (lastSteps === 0) {
    // just jump to end; engine will allow /exit
    state.flow.seq = sequences.length; // end
    state.flow.step = 0;
    await sendText(jid, "Skipped intro.");
    return;
  }

  // Position at the LAST step of the LAST sequence, so a single /next drains it and enables /exit
  state.flow.seq = lastSeqIndex;
  state.flow.step = Math.max(0, lastSteps - 1);
  state.flow._headerShown = true; // prevent emitting the last header again

  // Immediately render the final step so player can /exit next
  await nextRun({ jid, user, game, state });
}
