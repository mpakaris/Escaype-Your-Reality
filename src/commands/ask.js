import { classifyNpcReply } from "../services/api/openai.js";
import { sendText, sendVideo } from "../services/whinself.js";
import { isInputTooLong } from "./_helpers/validateInputLength.js";
import { setFlag } from "./_helpers/flagNormalization.js";

function norm(s) {
  return String(s || "").trim();
}

function pickByType(arr, type) {
  if (!Array.isArray(arr)) return null;
  const idx = arr.findIndex(
    (e) => e && String(e.type).toLowerCase() === String(type).toLowerCase()
  );
  return idx >= 0 ? { index: idx + 1, entry: arr[idx] } : null;
}

export default async function askCommand({ jid, args, state, candidates }) {
  const question = Array.isArray(args) ? args.join(" ") : args;

  if (!question || !question.trim()) {
    await sendText(jid, "Ask what? Example: */ask Tell me a joke!*");
    return;
  }

  const q = norm(question);

  // Length guard (narrator videos later)
  if (isInputTooLong(q)) {
    await sendText(
      jid,
      "Your question to the NPC is too long. Is there any way you could abbreviate your question?"
    );
    return;
  }

  // Require an active NPC in room
  const activeNpcId = state?.activeNpc || null;
  const npcIndex = (candidates && candidates.npcIndex) || {};
  const npc = activeNpcId ? npcIndex[activeNpcId] : null;

  if (!npc) {
    await sendText(
      jid,
      "No active conversation partner selected.\n\n> Use */show people* to see who's here.\n\n> Use */talkto <name>* to choose a person\n\n> Then */ask <question>* to talk."
    );
    return;
  }

  // Ensure talk state
  state.npcTalk = state.npcTalk || {};
  const existing = state.npcTalk[activeNpcId] || {};
  const talk = {
    asked: existing.asked || 0,
    revealed: !!existing.revealed,
    closed: !!existing.closed,
    history: Array.isArray(existing.history)
      ? existing.history.slice(0, 20)
      : [],
    lastTalkChapter: existing.lastTalkChapter || null,
    recapAwaitingAsk: !!existing.recapAwaitingAsk,
    recapAvailable: !!existing.recapAvailable,
    usedClues: Array.isArray(existing.usedClues)
      ? existing.usedClues.slice()
      : [],
  };

  const cap = 5; // questions per visit
  const chapter = state.chapter || 1;

  // Re-open on higher chapter
  if (
    talk.closed &&
    talk.lastTalkChapter != null &&
    chapter > talk.lastTalkChapter
  ) {
    talk.asked = 0;
    talk.revealed = false;
    talk.closed = false;
    talk.history = [];
    talk.usedClues = [];
    talk.recapAwaitingAsk = false;
  }

  // NPC media pools
  const scripted = Array.isArray(npc?.ai?.scriptedAnswers)
    ? npc.ai.scriptedAnswers
    : [];
  const fallback = Array.isArray(npc?.ai?.fallbackAnswers)
    ? npc.ai.fallbackAnswers
    : [];

  // Mandatory recap on first ask after exit, once per visit
  if (talk.recapAwaitingAsk && (talk.asked || 0) === 0) {
    const forced = pickByType(fallback, "forcedClue");
    const clip = forced?.entry;
    if (clip?.videoUrl) {
      await sendVideo(jid, clip.videoUrl);
    } else if (clip?.script) {
      await sendText(jid, clip.script);
    } else {
      await sendText(jid, "I already told you what I heard.");
    }

    // mark progression: truth unlocked for this NPC
    setFlag(state, `truth_unlocked_npc:${activeNpcId}`);

    state.npcTalk[activeNpcId] = {
      asked: 1,
      revealed: true,
      closed: true,
      history: (talk.history || [])
        .concat([
          {
            q,
            aIndex: forced?.index || -1,
            aTag: "forcedClue",
            ts: Date.now(),
          },
        ])
        .slice(-20),
      lastTalkChapter: chapter,
      usedClues: talk.usedClues,
      recapAwaitingAsk: false,
      recapAvailable: true,
    };
    return;
  }

  // Already closed for this chapter/visit
  if (talk.asked >= cap || talk.closed) {
    const stone = pickByType(fallback, "stonewall");
    const sclip = stone?.entry;
    if (sclip?.videoUrl) {
      await sendVideo(jid, sclip.videoUrl);
    } else if (sclip?.script) {
      await sendText(jid, sclip.script);
    } else {
      await sendText(jid, "I have nothing more to say about this.");
    }
    state.npcTalk[activeNpcId] = {
      ...state.npcTalk[activeNpcId],
      asked: talk.asked + 1,
      closed: true,
      lastTalkChapter: chapter,
      history: (talk.history || [])
        .concat([
          { q, aIndex: stone?.index || -1, aTag: "stonewall", ts: Date.now() },
        ])
        .slice(-20),
    };
    return;
  }

  const askedSoFar = talk.asked || 0;

  // Force the real clue on the last allowed turn if not yet revealed
  if (askedSoFar >= cap - 1 && !talk.revealed) {
    // Prefer scripted clue if present, else forced fallback
    const cluePick =
      pickByType(scripted, "clue") || pickByType(fallback, "forcedClue");
    const clip = cluePick?.entry;
    if (clip?.videoUrl) {
      await sendVideo(jid, clip.videoUrl);
    } else if (clip?.script) {
      await sendText(jid, clip.script);
    } else {
      await sendText(
        jid,
        "I heard two men fighting; one ran off in a white coat. That's all I know."
      );
    }

    // mark progression: truth unlocked for this NPC
    setFlag(state, `truth_unlocked_npc:${activeNpcId}`);

    state.npcTalk[activeNpcId] = {
      asked: askedSoFar + 1,
      revealed: true,
      closed: true,
      history: (talk.history || [])
        .concat([
          { q, aIndex: cluePick?.index || -1, aTag: "clue", ts: Date.now() },
        ])
        .slice(-20),
      lastTalkChapter: chapter,
      usedClues: talk.usedClues,
      recapAwaitingAsk: false,
      recapAvailable: true,
    };
    return;
  }

  // Classifier path for pre-cap turns
  const map = scripted.reduce((acc, entry, i) => {
    const idx = i + 1;
    const tag = String(entry?.type || "vague").toLowerCase();
    acc[idx] = tag;
    return acc;
  }, {});

  const lastTypes = (talk.history || [])
    .map((h) => h.aTag)
    .filter(Boolean)
    .slice(-1);

  const allowClue = askedSoFar >= cap - 1 || !!talk.revealed; // never before last turn if not revealed

  let cls;
  try {
    cls = await classifyNpcReply({
      question: q,
      npc: { id: activeNpcId, tone: npc?.ai?.persona || "" },
      map,
      context: { asked: askedSoFar, lastTypes },
      policy: { allowClue, avoidRepeatTypes: true, insultDetection: true },
    });
  } catch {
    cls = null;
  }

  // Safety: remap clue if classifier proposed it too early
  if (!allowClue && cls && String(cls.tag).toLowerCase() === "clue") {
    // pick first non-clue
    const altPair = Object.entries(map).find(
      ([i, t]) => String(t).toLowerCase() !== "clue"
    );
    if (altPair) cls = { index: Number(altPair[0]), tag: altPair[1] };
  }

  // Resolve selected scripted clip
  const chosenIndex = cls?.index && scripted[cls.index - 1] ? cls.index : 1;
  const chosen = scripted[chosenIndex - 1] || null;

  if (chosen?.videoUrl) {
    await sendVideo(jid, chosen.videoUrl);
  } else if (chosen?.script) {
    await sendText(jid, chosen.script);
  } else {
    await sendText(jid, "…");
  }

  // Update state
  const newHist = (talk.history || [])
    .concat([
      {
        q,
        aIndex: chosenIndex,
        aTag: String(chosen?.type || "vague").toLowerCase(),
        ts: Date.now(),
      },
    ])
    .slice(-20);

  state.npcTalk[activeNpcId] = {
    asked: askedSoFar + 1,
    revealed: talk.revealed,
    closed: askedSoFar + 1 >= cap ? true : false,
    history: newHist,
    lastTalkChapter: chapter,
    usedClues: talk.usedClues,
    recapAwaitingAsk: false,
    recapAvailable: talk.revealed ? true : talk.recapAvailable,
  };
}
