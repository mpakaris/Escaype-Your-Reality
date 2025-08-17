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

function unique(arr = []) {
  return Array.from(new Set(arr.filter(Boolean)));
}

function listToText(arr = [], empty = "none") {
  const a = arr.filter(Boolean);
  if (!a.length) return empty;
  if (a.length === 1) return a[0];
  if (a.length === 2) return `${a[0]} and ${a[1]}`;
  return `${a.slice(0, -1).join(", ")}, and ${a[a.length - 1]}`;
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

  // Aggregate across all rooms in this structure
  const rooms = Array.isArray(structure.rooms) ? structure.rooms : [];

  const objectNames = unique(
    rooms.flatMap((r) => (r.objects || []).map((o) => o.displayName || o.id))
  );

  const npcNames = unique(
    rooms.flatMap((r) =>
      (r.npcs || []).map((nid) => {
        const def = (game.npcs || []).find((n) => n.id === nid);
        return def?.displayName || nid;
      })
    )
  );

  const looseItems = unique(rooms.flatMap((r) => r.items || []));

  const itemsInsideObjects = unique(
    rooms.flatMap((r) => (r.objects || []).flatMap((o) => o.contents || []))
  );

  const visibleItems = unique(
    looseItems.filter((it) => !itemsInsideObjects.includes(it))
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

  // Default: brief overview
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
