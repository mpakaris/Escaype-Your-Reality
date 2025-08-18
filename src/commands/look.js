import { sendText } from "../services/whinself.js";
import { fuzzyMatch } from "../utils/fuzzyMatch.js";

function getCurrentLocation(game, state) {
  const id = state.location;
  return (game.locations || []).find((l) => l.id === id) || null;
}
function getCurrentStructure(loc, state) {
  if (!loc) return null;
  const sid = state.structureId;
  return (loc.structures || []).find((s) => s.id === sid) || null;
}
function getCurrentRoom(structure, state) {
  if (!structure) return null;
  const rid = state.roomId;
  return (structure.rooms || []).find((r) => r.id === rid) || null;
}
function unique(arr = []) {
  return Array.from(new Set((arr || []).filter(Boolean)));
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

function listToBullets(arr = [], empty = "none") {
  const a = (arr || []).filter(Boolean);
  if (!a.length) return empty;
  return a.map((v) => `- ${v}`).join("\n");
}

const LOOK_KEYWORDS = {
  objects: ["objects", "object", "objs", "things", "stuff"],
  people: ["people", "person", "npc", "npcs", "folk", "faces", "persons"],
  items: ["item", "items", "loot", "gear", "stuff"],
};
function resolveLookMode(input) {
  const q = (input || "").trim();
  if (!q) return null;
  for (const [key, variants] of Object.entries(LOOK_KEYWORDS)) {
    const hit = fuzzyMatch(q, variants, { threshold: 0.5, maxResults: 1 });
    if (hit) return key;
  }
  return null;
}

export async function run({ jid, user, game, state, args }) {
  if (!state.inStructure || !state.structureId) {
    await sendText(jid, "You are not inside a building. Use /enter first.");
    return;
  }

  const loc = getCurrentLocation(game, state);
  const structure = getCurrentStructure(loc, state);
  if (!structure) {
    await sendText(jid, "Structure not found here.");
    return;
  }

  const room = getCurrentRoom(structure, state);
  if (!room) {
    await sendText(jid, "You’re inside, but not in a defined room.");
    return;
  }

  // Current room
  const objectNames = unique(
    (room.objects || []).map((o) => o.displayName || o.id)
  );

  // room.npcs accepts string ids or {id, visibleWhen}
  const npcEntries = Array.isArray(room.npcs) ? room.npcs : [];
  const visibleNpcIds = npcEntries
    .map((e) => (typeof e === "string" ? { id: e } : e))
    .filter((e) => e && e.id && condOk(e.visibleWhen, state))
    .map((e) => e.id);
  const npcNames = unique(
    visibleNpcIds.map((nid) => {
      const def = (game.npcs || []).find((n) => n.id === nid);
      return def?.displayName || nid;
    })
  );

  const looseItemsHere = unique(room.items || []);
  const itemsInsideObjectsHere = unique(
    (room.objects || []).flatMap((o) => o.contents || [])
  );
  const visibleItems = unique(
    looseItemsHere.filter((it) => !itemsInsideObjectsHere.includes(it))
  );

  const rawMode = (args && args[0] ? args[0] : "").toLowerCase();
  const mode = resolveLookMode(rawMode);

  if (mode === "objects") {
    await sendText(
      jid,
      `*Objects here:*\n\n${listToBullets(objectNames, "none")}`
    );
    return;
  }
  if (mode === "people") {
    await sendText(jid, `*People here:*\n\n${listToBullets(npcNames, "none")}`);
    return;
  }
  if (mode === "items") {
    await sendText(
      jid,
      `*Items in plain sight:*\n\n${listToBullets(visibleItems, "none")}`
    );
    return;
  }

  if (rawMode) {
    await sendText(
      jid,
      "Your eyes wander, but focus falters. Try */look objects*, */look person*, or */look items*."
    );
    return;
  }

  // Default: summary
  const lines = [];
  lines.push(`*Objects here:*\n\n${listToBullets(objectNames, "none")}`);
  lines.push("");
  lines.push(`*People here:*\n\n${listToBullets(npcNames, "none")}`);
  lines.push("");
  lines.push(
    `*Items in plain sight:*\n\n${listToBullets(visibleItems, "none")}`
  );
  await sendText(jid, lines.join("\n"));
}
