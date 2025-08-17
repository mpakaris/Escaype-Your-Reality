import { sendText } from "../services/whinself.js";
import { beginSequence } from "../game/flow.js";
import { run as nextRun } from "./next.js";

export async function run({ jid, user, game, state }) {
  Object.assign(state, {
    chapter: 0,
    step: 0,
    location: null,
    inStructure: false,
    structureId: null,
    roomId: null,
    inventory: [],
    visitedLocations: [],
    objectivesCompleted: [],
    activeObjective: null,
    hintCount: 0,
    lastCommand: "/reset",
    flags: {
      introSequenceSeen: false,
      tutorialComplete: false,
      didFirstMove: false,
      unlockedObjects: {},
    },
  });
  beginSequence(state, { type: "intro", seq: 0, step: 0 });
  await sendText(jid, "Intro restarted.");
  await nextRun({ jid, user, game, state });
}
