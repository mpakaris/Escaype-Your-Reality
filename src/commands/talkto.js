import { sendImage, sendText, sendVideo } from "../services/whinself.js";

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

  // Ensure per-NPC talk state exists with extended defaults
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
      firstMet: false,
      visits: 0,
      lastVisitAt: null,
    };
  }
  const talk = state.npcTalk[target.id];

  state.flags = state.flags || {};
  const metFlagKey = `met_npc:${target.id}`;
  const alreadyMet = talk.firstMet || !!state.flags[metFlagKey];

  if (state.activeNpc === target.id) {
    // Already active NPC - short confirmation flow
    if (talk.revealed && talk.recapAvailable) {
      talk.recapAwaitingAsk = true; // deliver on first /ask
    }
    await sendText(
      jid,
      `${
        target.displayName || target.name || target.id
      } is set as active conversation partner.`
    );
    return;
  }

  // New active NPC
  state.activeNpc = target.id;

  if (!alreadyMet) {
    // First contact
    const narr = target?.profile?.narrator || {};
    if (narr.intro?.videoUrl) {
      try {
        await sendVideo(jid, narr.intro.videoUrl);
      } catch {}
    }
    let imgUrl = null;
    if (narr.intro?.image === "fullBody" && target.profile?.images?.fullBody) {
      imgUrl = target.profile.images.fullBody;
    } else if (
      narr.intro?.image === "headshot" &&
      target.profile?.images?.headshot
    ) {
      imgUrl = target.profile.images.headshot;
    } else {
      imgUrl =
        target.profile?.images?.headshot ||
        target.profile?.images?.fullBody ||
        target.profile?.image ||
        null;
    }
    if (imgUrl) {
      try {
        await sendImage(
          jid,
          imgUrl,
          target.displayName || target.name || target.id
        );
      } catch {}
    }
    talk.firstMet = true;
    state.flags[metFlagKey] = true;
    talk.visits++;
    talk.lastVisitAt = Date.now();
  } else {
    // Re-contact, not firstMet
    if (talk.revealed && talk.recapAvailable) {
      talk.recapAwaitingAsk = true;
    }
    const narr = target.profile.narrator || {};
    if (narr.revisit?.text) {
      await sendText(jid, narr.revisit.text);
    }
    let imgUrl =
      target.profile?.images?.headshot ||
      target.profile?.images?.fullBody ||
      target.profile?.image ||
      null;
    if (imgUrl) {
      try {
        await sendImage(
          jid,
          imgUrl,
          target.displayName || target.name || target.id
        );
      } catch {}
    }
    talk.visits++;
    talk.lastVisitAt = Date.now();
    await sendText(
      jid,
      `${
        target.displayName || target.name || target.id
      } is set as active conversation partner.`
    );
  }
}
