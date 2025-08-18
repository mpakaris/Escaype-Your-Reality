import { sendText } from "../services/whinself.js";

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
    talkedTo: [],
    activeObjective: null,
    hintCount: 0,
    lastCommand: "/reset",

    flags: {},
    objects: {},

    // Fresh intro state, do not auto-advance
    introActive: true,
    introSeqIndex: 0,
    introStepIndex: 0,
    flow: { active: true, type: "intro", seq: 0, step: 0, _headerShown: false },
  });

  await sendText(jid, "Game reset. Type */next* to begin.");
}
