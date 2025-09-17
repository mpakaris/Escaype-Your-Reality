import { sendImage, sendText } from "../services/whinself.js";

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .trim();
}

function getCurrentLocation(game, state) {
  return (game.locations || []).find((l) => l.id === state.location) || null;
}
function getCurrentStructure(loc, state) {
  if (!loc) return null;
  return (loc.structures || []).find((s) => s.id === state.structureId) || null;
}
function getCurrentRoom(structure, state) {
  if (!structure) return null;
  return (structure.rooms || []).find((r) => r.id === state.roomId) || null;
}

// Evaluate generic conditions (flags, !flags, hasItem)
function condOk(conds, state) {
  if (!Array.isArray(conds) || !conds.length) return true;
  const flags = state.flags || {};
  const hasItem = (id) =>
    Array.isArray(state.inventory) && state.inventory.includes(id);
  for (const c of conds) {
    if (typeof c !== "string") return false;
    if (c.startsWith("flag:")) {
      const k = c.slice(5);
      if (!flags[k]) return false;
      continue;
    }
    if (c.startsWith("!flag:")) {
      const k = c.slice(6);
      if (flags[k]) return false;
      continue;
    }
    if (c.startsWith("hasItem:")) {
      const k = c.slice(8);
      if (!hasItem(k)) return false;
      continue;
    }
  }
  return true;
}

export async function run({ jid, user, game, state, args, candidates }) {
  if (!state.inStructure || !state.structureId) {
    await sendText(jid, "You are not inside a building. Use /enter first.");
    return;
  }

  const loc = getCurrentLocation(game, state);
  const structure = getCurrentStructure(loc, state);
  const room = getCurrentRoom(structure, state);
  if (!structure || !room) {
    await sendText(jid, "No one here to talk to.");
    return;
  }

  // Resolve visible NPCs in THIS room only (room.npcs can be ["id", { id, visibleWhen }])
  const entries = Array.isArray(room.npcs) ? room.npcs : [];
  const visibleIds = entries
    .map((e) => (typeof e === "string" ? { id: e } : e))
    .filter((e) => e && e.id && condOk(e.visibleWhen, state))
    .map((e) => e.id);

  const npcIndex = (candidates && candidates.npcIndex) || {};
  const visibleNpcs = visibleIds.map((id) => npcIndex[id]).filter(Boolean);

  if (!visibleNpcs.length) {
    await sendText(jid, "No one here to talk to.");
    return;
  }

  // Resolve target from args; if no args and single NPC visible, pick that one
  const token = norm(Array.isArray(args) ? args.join(" ") : args);

  function pickNpc(tok) {
    if (!tok) return null;
    // try exact id, displayName, name
    let hit = visibleNpcs.find(
      (n) =>
        norm(n.id) === tok ||
        norm(n.displayName) === tok ||
        norm(n.name) === tok
    );
    if (hit) return hit;
    // startsWith
    hit = visibleNpcs.find(
      (n) =>
        norm(n.displayName).startsWith(tok) ||
        norm(n.name).startsWith(tok) ||
        norm(n.id).startsWith(tok)
    );
    if (hit) return hit;
    // contains
    hit = visibleNpcs.find(
      (n) => norm(n.displayName).includes(tok) || norm(n.name).includes(tok)
    );
    return hit || null;
  }

  let target = pickNpc(token);
  if (!target) {
    if (!token && visibleNpcs.length === 1) {
      target = visibleNpcs[0];
    } else if (!token && visibleNpcs.length > 1) {
      const names = visibleNpcs
        .map((n) => `*${n.displayName || n.name || n.id}*`)
        .join(", ");
      await sendText(jid, `Talk to who? Try: ${names}`);
      return;
    } else {
      const names = visibleNpcs
        .map((n) => `*${n.displayName || n.name || n.id}*`)
        .join(", ");
      await sendText(
        jid,
        names ? `Couldn't find them. Try: ${names}` : "No one here to talk to."
      );
      return;
    }
  }

  if (state.activeNpc === target.id) {
    // ensure per-NPC talk state exists
    state.npcTalk = state.npcTalk || {};
    if (!state.npcTalk[target.id]) {
      state.npcTalk[target.id] = {
        asked: 0,
        revealed: false,
        closed: false,
        history: [],
        lastTalkChapter: null,
        recapAvailable: false,
        recapAwaitingAsk: false,
        usedClues: [],
      };
    }

    // If a recap is available, schedule it for the first /ask in this visit
    const talk = state.npcTalk[target.id];
    if (talk.revealed && talk.recapAvailable) {
      talk.recapAwaitingAsk = true; // deliver on first /ask
      // do not consume recap here; it will be consumed in ask.js
    }

    await sendText(
      jid,
      `${
        target.displayName || target.name || target.id
      } is set as active conversation partner.`
    );
    await sendText(
      jid,
      "Use */ask* + your question to converse. For example: */ask What did you see?*\n\n*_Be patient! The Characters need to think well before answering your questions. They are not used to talk to law enforcement._*"
    );
    return;
  }

  state.activeNpc = target.id;

  state.npcTalk = state.npcTalk || {};
  if (!state.npcTalk[target.id]) {
    state.npcTalk[target.id] = {
      asked: 0,
      revealed: false,
      closed: false,
      history: [],
      lastTalkChapter: null,
      recapAvailable: false,
      recapAwaitingAsk: false,
      usedClues: [],
    };
  }

  {
    const talk = state.npcTalk[target.id];
    if (talk.revealed && talk.recapAvailable) {
      talk.recapAwaitingAsk = true; // will recap on first /ask
    }
  }

  const profileImg =
    (target?.profile?.images &&
      (target.profile.images.headshot || target.profile.images.fullBody)) ||
    target?.profile?.image ||
    null;
  const profileDesc = target?.profile?.description || null;
  if (profileImg) {
    try {
      await sendImage(
        jid,
        profileImg,
        target.displayName || target.name || target.id
      );
    } catch {}
  }
  if (profileDesc) {
    await sendText(jid, profileDesc);
  }

  await sendText(
    jid,
    `${
      target.displayName || target.name || target.id
    } is set as active conversation partner.`
  );
  await sendText(
    jid,
    "Use */ask* + your question to converse. For example: */ask What did you see?*\n\n*_Be patient! The Characters need to think well before answering your questions. They are not used to talk to law enforcement._*"
  );
}
