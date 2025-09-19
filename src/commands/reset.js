import { sendText } from "../services/whinself.js";
import { ensureCounters, ensureFlags } from "./_helpers/flagNormalization.js";

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
    counters: {},

    objects: {},

    npcTalk: {},
    activeNpc: "",
    activeNpcId: null,
    npcAskCount: {},
    log: [],
    // Fresh intro state, do not auto-advance
    introActive: true,
    introSeqIndex: 0,
    introStepIndex: 0,
    flow: { active: true, type: "intro", seq: 0, step: 0, _headerShown: false },
  });

  // normalize flags and counters
  ensureFlags(state);
  ensureCounters(state);

  let message = "Game reset. Type */next* to begin.";
  if (process.env.CODING_ENV === "DEV") {
    state.flags.introDone = true;
    state.flags.tutorialDone = true;
    state.introActive = false;
    state.flow = { active: false };
    state.chapter = 1;
    message = "Game reset. DEV mode active. Type */move <id>* to start.";
  }

  await sendText(jid, message);
}
