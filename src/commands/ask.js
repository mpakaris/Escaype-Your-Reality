import { askOpenAI } from "../services/api/openai.js";
import { sendText } from "../services/whinself.js";
import { getGenericAIPrompt } from "./_helpers/aiGenericComponent.js";
import { isInputTooLong } from "./_helpers/validateInputLength.js";

function norm(s) {
  return String(s || "").trim();
}

export default async function askCommand({ jid, args, state, candidates }) {
  const question = Array.isArray(args) ? args.join(" ") : args;

  if (!question || !question.trim()) {
    await sendText(jid, "Ask what? Example: */ask Tell me a joke!*");
    return;
  }

  const q = norm(question);

  if (isInputTooLong(q)) {
    await sendText(
      jid,
      "Your question to the NPC is too long. Is there any way you could abbreviate your question?"
    );
    return;
  }

  // Require an active NPC
  const activeNpcId = state?.activeNpc || null;
  const npcIndex = (candidates && candidates.npcIndex) || {};
  const npc = activeNpcId ? npcIndex[activeNpcId] : null;

  if (!npc) {
    await sendText(
      jid,
      "No active conversation partner selected.\n\n> Use */show people* to see who else is in the room with you.\n\n> Use */talkto <name>* to choose a person\n\n> Use */ask* <question> to talk."
    );
    return;
  }

  // Per-NPC talk state with history and closing
  state.npcTalk = state.npcTalk || {};
  const existing = state.npcTalk[activeNpcId] || {};
  const talk = {
    asked: existing.asked || 0,
    revealed: !!existing.revealed,
    closed: !!existing.closed,
    history: Array.isArray(existing.history)
      ? existing.history.slice(0, 10)
      : [],
    lastTalkChapter: existing.lastTalkChapter || null,
    recapAwaitingAsk: !!existing.recapAwaitingAsk,
  };
  talk.usedClues = Array.isArray(existing.usedClues)
    ? existing.usedClues.slice()
    : [];

  const cap = 5; // unified cap

  // Chapter handling and reopen in later chapters
  const chapter = state.chapter || 1;
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
  }

  // If a recap is pending for this visit, deliver it on the first ask
  if (talk.recapAwaitingAsk && (talk.asked || 0) === 0) {
    const realClue = (npc?.ai?.clues || []).find(
      (c) => c && String(c.type).toLowerCase() === "real"
    );
    const line = realClue?.text || "I already told you what I heard.";
    const formattedRecap = `"_${line}_"`;
    await sendText(jid, formattedRecap);

    const newHist = (talk.history || []).concat([
      { q, a: line, ts: Date.now() },
    ]);
    while (newHist.length > 10) newHist.shift();

    const newUsed = Array.isArray(talk.usedClues) ? talk.usedClues.slice() : [];
    if (line && !newUsed.includes(line)) newUsed.push(line);

    state.npcTalk[activeNpcId] = {
      asked: 1,
      revealed: true,
      closed: true, // recap once per visit, then stonewall
      history: newHist,
      lastTalkChapter: chapter,
      usedClues: newUsed,
      recapAwaitingAsk: false,
    };
    return;
  }

  // If already closed for this chapter
  if (talk.asked >= cap || talk.closed) {
    await sendText(jid, "I have nothing more to say about this.");
    return;
  }

  const ai = npc.ai || {};
  const style = ai.style || "";
  const persona = ai.persona || "";
  const openingBehavior = ai.openingBehavior || "";
  const voiceHints = Array.isArray(ai.voiceHints) ? ai.voiceHints : [];
  const clues = Array.isArray(ai.clues) ? ai.clues : [];
  const banterPool = Array.isArray(ai.banterPool) ? ai.banterPool : [];
  const voiceHintsParaphrase = !!ai.voiceHintsParaphrase;

  const display = npc.displayName || npc.name || activeNpcId;
  const desc = npc?.profile?.description || "";
  const firstTurn = talk.asked === 0;

  const askedSoFar = talk.asked || 0;

  // Decide clue for this turn
  let clueForThisTurn = null;

  // If real clue already revealed this visit, no more clues
  const realClueRevealed = talk.revealed;

  if (!realClueRevealed) {
    if (askedSoFar >= cap - 1) {
      // Last allowed question → prepare to force real if not yet revealed
      const pickReal = clues.find(
        (c) => c && String(c.type).toLowerCase() === "real"
      );
      clueForThisTurn = pickReal || null;
    } else if (askedSoFar === 1 || askedSoFar === 3) {
      // Q2 and Q4: herrings only
      const nextHerr = clues.find(
        (c) =>
          c &&
          String(c.type).toLowerCase() !== "real" &&
          !talk.usedClues.includes(c.text)
      );
      clueForThisTurn = nextHerr || null;
    } else {
      // Q1 and Q3: no clue injection, let LLM do vague/banter
      clueForThisTurn = null;
    }
  } else {
    // after reveal, no further clues this visit
    clueForThisTurn = null;
  }

  // Hard guarantee: on the last allowed question, if the real clue hasn't been revealed yet,
  // deliver it directly without going through the model.
  if (
    clueForThisTurn &&
    String(clueForThisTurn.type).toLowerCase() === "real" &&
    askedSoFar >= cap - 1 &&
    !talk.revealed
  ) {
    const line = clueForThisTurn.text;
    await sendText(jid, line);

    // Update history and state, then return
    const out = line;
    const newHist = (talk.history || []).concat([
      { q, a: out, ts: Date.now() },
    ]);
    while (newHist.length > 10) newHist.shift();

    const newUsed = talk.usedClues ? talk.usedClues.slice() : [];
    if (line && !newUsed.includes(line)) newUsed.push(line);

    state.npcTalk[activeNpcId] = {
      asked: askedSoFar + 1,
      revealed: true,
      closed: true,
      history: newHist,
      lastTalkChapter: chapter,
      usedClues: newUsed,
    };
    return;
  }

  // Build compact prompt with recent history and optional clue
  const recent = (talk.history || []).slice(-4);
  const historyStr = recent.length
    ? "Recent exchanges:\n" +
      recent.map((h) => `- Q: ${h.q}\n  A: ${h.a}`).join("\n")
    : "";

  const lastAnswers = recent
    .slice(-2)
    .map((h) => h.a)
    .filter(Boolean);
  const avoidLine = lastAnswers.length
    ? `Avoid repeating earlier phrasing; do not restate these lines verbatim: ${lastAnswers
        .map((s) => '"' + s.slice(0, 140) + '"')
        .join(" ")}`
    : "";

  const banter =
    !clueForThisTurn && banterPool.length
      ? banterPool[Math.floor(Math.random() * banterPool.length)]
      : "";
  const banterLine = banter
    ? `Optional color detail (do not add facts): "${banter}"`
    : "";

  const personaLine = persona ? `Persona: ${persona}` : "";
  const voiceLine = voiceHints.length
    ? `Voice hints: ${voiceHints.map((v) => `- ${v}`).join(" ")}`
    : "";

  const generic = getGenericAIPrompt(chapter).trim();
  const opening = firstTurn && openingBehavior ? openingBehavior : "";
  const clueLine = clueForThisTurn?.text
    ? `Clue to phrase (use this content, do not add facts): "${clueForThisTurn.text}"`
    : "";

  // Add line if real clue was already revealed
  const revealedWarningLine = realClueRevealed
    ? "You have already revealed your main clue; do not repeat it. You may only banter or deflect."
    : "";

  // If clue is repeated (already used), instruct to paraphrase or deflect
  let clueRepeatWarning = "";
  if (
    clueForThisTurn &&
    clueForThisTurn.text &&
    talk.usedClues.includes(clueForThisTurn.text) &&
    !realClueRevealed
  ) {
    clueRepeatWarning =
      "If repeating a clue, paraphrase it differently or deflect instead of repeating verbatim.";
  }

  const instruction = [
    `You are ${display}.`,
    desc,
    personaLine,
    `Style: ${style || "brief, realistic"}.`,
    `Chapter: ${chapter}.`,
    opening,
    generic,
    voiceHintsParaphrase
      ? "Paraphrase any repeated facts with different wording; avoid exact repetition."
      : "",
    revealedWarningLine,
    clueRepeatWarning,
  ]
    .filter(Boolean)
    .join("\n");

  const prompt = [
    instruction,
    voiceLine,
    historyStr,
    clueLine,
    banterLine,
    avoidLine,
    `User question: ${q}`,
  ]
    .filter(Boolean)
    .join("\n");

  // If real clue already revealed and askedSoFar < cap, bias responses toward banter or vague deflections
  let reply;
  if (realClueRevealed && askedSoFar < cap) {
    // Bias temperature higher for more varied banter or vague deflections, and limit tokens
    reply = await askOpenAI(prompt, { max_tokens: 100, temperature: 0.8 });
  } else {
    reply = await askOpenAI(prompt, { max_tokens: 120, temperature: 0.6 });
  }
  const out = reply || "…";
  const formatted = `"_${out}_"`;

  await sendText(jid, formatted);

  // Update state: asked, revealed, closed, history, chapter
  const revealedNow = talk.revealed; // only set to true in the short-circuit branch above or via recap

  const newHist = (talk.history || []).concat([{ q, a: out, ts: Date.now() }]);
  while (newHist.length > 10) newHist.shift();

  const newUsed = talk.usedClues ? talk.usedClues.slice() : [];
  if (
    clueForThisTurn &&
    clueForThisTurn.text &&
    !newUsed.includes(clueForThisTurn.text)
  ) {
    newUsed.push(clueForThisTurn.text);
  }

  state.npcTalk[activeNpcId] = {
    asked: askedSoFar + 1,
    revealed: revealedNow,
    closed: askedSoFar + 1 >= cap,
    history: newHist,
    lastTalkChapter: chapter,
    usedClues: newUsed,
  };

  if (askedSoFar + 1 >= cap && !revealedNow) {
    // If somehow not revealed by cap, ensure next call closes immediately
    state.npcTalk[activeNpcId].closed = true;
  }
}
