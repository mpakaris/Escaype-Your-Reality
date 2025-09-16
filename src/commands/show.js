import { sendText } from "../services/whinself.js";
import { fuzzyMatch } from "../utils/fuzzyMatch.js";
import { isRevealed } from "./_helpers/revealed.js";

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

function prettyNameFromId(id) {
  if (!id || typeof id !== "string") return id;
  // normalize common separators
  const s = id.replace(/[_\-]+/g, " ").trim();
  // keep common tokens lowercase (of, the, and, to, a)
  const lowerKeep = new Set(["of", "the", "and", "to", "a", "on", "in"]);
  return s
    .split(/\s+/)
    .map((w, i) => {
      if (i > 0 && lowerKeep.has(w)) return w;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
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

function listToBullets(arr = [], emptyMsg = "none") {
  const a = (arr || []).filter(Boolean);
  if (!a.length) return emptyMsg;
  return a.map((v) => `- ${v}`).join("\n");
}

// Try several shapes where catalogues might live on `game`
function resolveFromCatalogueArray(arr, id) {
  if (!Array.isArray(arr)) return null;
  const hit = arr.find((x) => x && (x.id === id || x.name === id));
  return hit || null;
}
function resolveFromIndex(idx, id) {
  if (idx && typeof idx === "object") {
    return idx[id] || null;
  }
  return null;
}
function resolveDisplayName(id, type, game) {
  if (!id) return null;
  const t = String(type || "");
  const indexKey =
    t === "object" ? "objectIndex" : t === "item" ? "itemIndex" : "npcIndex";
  const catKey =
    t === "object"
      ? "objectsCatalogue"
      : t === "item"
      ? "itemsCatalogue"
      : "npcsCatalogue";
  const arrKey = t === "object" ? "objects" : t === "item" ? "items" : "npcs";

  let row = null;
  row = resolveFromIndex(game?.[indexKey], id) || row;
  row = resolveFromCatalogueArray(game?.[catKey], id) || row;
  row = resolveFromCatalogueArray(game?.catalogues?.[catKey], id) || row;
  row = resolveFromCatalogueArray(game?.[arrKey], id) || row;

  const name = row?.displayName || row?.name || null;
  return name || prettyNameFromId(id);
}

// Given an object id, try to fetch its catalogue row to access contents etc.
function resolveObjectRow(id, game) {
  const rowFromIdx = resolveFromIndex(game?.objectIndex, id);
  if (rowFromIdx) return rowFromIdx;
  const fromCat =
    resolveFromCatalogueArray(game?.objectsCatalogue, id) ||
    resolveFromCatalogueArray(game?.catalogues?.objectsCatalogue, id) ||
    resolveFromCatalogueArray(game?.objects, id);
  return fromCat || null;
}

const MODE_ALIASES = {
  objects: new Set(["objects", "object", "objs", "things"]),
  people: new Set(["people", "person", "npc", "npcs", "folk", "persons"]),
  items: new Set(["item", "items", "loot", "gear"]),
};
function resolveLookMode(input) {
  const q = String(input || "")
    .trim()
    .toLowerCase();
  if (!q) return null;
  for (const [mode, set] of Object.entries(MODE_ALIASES)) {
    if (set.has(q)) return mode;
  }
  // last-resort fuzzy, but prefer exact above
  for (const [mode, set] of Object.entries(MODE_ALIASES)) {
    const hit = fuzzyMatch(q, Array.from(set), {
      threshold: 0.6,
      maxResults: 1,
    });
    if (hit) return mode;
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

  // Objects: room.objects can be ["objId", ...] or [{id, visibleWhen}]
  const objEntries = Array.isArray(room.objects) ? room.objects : [];
  const visibleObjIds = objEntries
    .map((e) => (typeof e === "string" ? { id: e } : e))
    .filter((e) => e && e.id && condOk(e.visibleWhen, state))
    .map((e) => e.id);
  const objectNames = unique(
    visibleObjIds.map((oid) => resolveDisplayName(oid, "object", game))
  );

  // People: ids -> display names via catalogue
  const npcEntries = Array.isArray(room.npcs) ? room.npcs : [];
  const visibleNpcIds = npcEntries
    .map((e) => (typeof e === "string" ? { id: e } : e))
    .filter((e) => e && e.id && condOk(e.visibleWhen, state))
    .map((e) => e.id);
  const npcNames = unique(
    visibleNpcIds.map((nid) => resolveDisplayName(nid, "npc", game))
  );

  // Items: from room.items plus contents of object catalogue rows
  const looseItems = Array.isArray(room.items) ? room.items : [];
  const fromObjects = visibleObjIds
    .map((oid) => resolveObjectRow(oid, game))
    .filter(Boolean)
    .flatMap((row) => (Array.isArray(row.contents) ? row.contents : []));

  const inv = Array.isArray(state.inventory)
    ? new Set(state.inventory)
    : new Set();

  // Show only items the player has actually revealed via /search or /open
  const allItemIds = unique([...(looseItems || []), ...(fromObjects || [])])
    .filter((iid) => !inv.has(iid))
    .filter((iid) => isRevealed(state, iid));

  const itemNames = unique(
    allItemIds.map((iid) => resolveDisplayName(iid, "item", game))
  );

  const rawMode = (args && args[0] ? String(args[0]) : "").toLowerCase();
  const mode = resolveLookMode(rawMode);

  if (mode === "objects") {
    await sendText(
      jid,
      `*Objects here:*\n\n${listToBullets(objectNames, "no obvious objects.")}`
    );
    return;
  }
  if (mode === "people") {
    await sendText(
      jid,
      `*People here:*\n\n${listToBullets(npcNames, "no one in sight.")}`
    );
    return;
  }
  if (mode === "items") {
    await sendText(
      jid,
      `*Items here:*\n\n${listToBullets(
        itemNames,
        "no items visible at first glance."
      )}`
    );
    return;
  }

  if (rawMode) {
    await sendText(
      jid,
      "Your eyes wander, but focus falters. Try */show objects*, */show people*, or */show items*."
    );
    return;
  }

  // Default summary
  const lines = [];
  lines.push(
    `*Objects here:*\n\n${listToBullets(objectNames, "no obvious objects.")}`
  );
  lines.push("");
  lines.push(
    `*People here:*\n\n${listToBullets(npcNames, "no one in sight.")}`
  );
  lines.push("");
  lines.push(
    `*Items here:*\n\n${listToBullets(
      itemNames,
      "no items visible at first glance."
    )}`
  );
  await sendText(jid, lines.join("\n"));
}
