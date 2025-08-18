import { sendText } from "../services/whinself.js";
import { fuzzyPickFromObjects } from "../utils/fuzzyMatch.js";

const bullets = (arr) =>
  (arr || [])
    .filter(Boolean)
    .map((t) => `• ${t}`)
    .join("\n");

function getLoc(game, state) {
  return (game.locations || []).find((l) => l.id === state.location) || null;
}
function getStruct(loc, state) {
  return (
    (loc?.structures || []).find((s) => s.id === state.structureId) || null
  );
}
function getRoom(struct, state) {
  return (struct?.rooms || []).find((r) => r.id === state.roomId) || null;
}
function mapItemNames(game, ids) {
  const dict = Object.fromEntries(
    (game.items || []).map((i) => [i.id, i.displayName || i.name || i.id])
  );
  return (ids || []).map((id) => dict[id] || id);
}
function itemDisplay(game, id) {
  const def = (game.items || []).find((i) => i.id === id);
  return def?.displayName || def?.name || id;
}

function ensureObjectState(state) {
  if (!state.objects || typeof state.objects !== "object") state.objects = {};
  return state.objects;
}
function getObjState(state, objId) {
  ensureObjectState(state);
  return state.objects[objId] || {};
}

export async function run({ jid, user, game, state, args }) {
  // Must be inside a structure per design
  if (!state.inStructure || !state.structureId) {
    await sendText(jid, "You’re not inside. Step in first with */enter*.");
    return;
  }

  const token = args && args.length ? args.join(" ") : "";
  if (!token) {
    await sendText(jid, "Take what? Example: */take key*.");
    return;
  }

  const loc = getLoc(game, state);
  const struct = getStruct(loc, state);
  const room = getRoom(struct, state);
  if (!struct || !room) {
    await sendText(jid, "You’re nowhere useful to take anything.");
    return;
  }

  // Build candidate item ids visible/takeable **anywhere in this structure**
  // Still respects per-user overrides (locked/opened) and excludes items already in inventory
  const inv = Array.isArray(state.inventory) ? state.inventory : [];
  const rooms = Array.isArray(struct.rooms) ? struct.rooms : [];

  // Map to remember where to remove the item from once taken
  const sources = new Map(); // id -> { type: 'room'|'object', room, object? }
  const candidateIds = new Set();

  for (const r of rooms) {
    const roomItems = Array.isArray(r.items) ? r.items : [];
    for (const it of roomItems) {
      if (inv.includes(it)) continue;
      candidateIds.add(it);
      if (!sources.has(it)) sources.set(it, { type: "room", room: r });
    }
    const objs = Array.isArray(r.objects) ? r.objects : [];
    for (const o of objs) {
      const lock = o.lock || {};
      const oState = getObjState(state, o.id);
      const locked =
        typeof oState.locked === "boolean" ? oState.locked : !!lock.locked;
      const openable = (o.tags || []).includes("openable");
      const openedBase = o.states?.opened === true;
      const opened =
        typeof oState.opened === "boolean" ? oState.opened : openedBase;
      if (locked) continue;
      if (openable && !opened) continue; // closed container, don’t expose contents
      const contents = Array.isArray(o.contents) ? o.contents : [];
      for (const it of contents) {
        if (inv.includes(it)) continue;
        candidateIds.add(it);
        if (!sources.has(it))
          sources.set(it, { type: "object", room: r, object: o });
      }
    }
  }

  const candidates = Array.from(candidateIds);
  if (!candidates.length) {
    await sendText(jid, "There’s nothing here you can take.");
    return;
  }

  // Create label list for fuzzy matching
  const itemsForMatch = candidates.map((id) => ({
    id,
    label: itemDisplay(game, id),
  }));
  const hit = fuzzyPickFromObjects(token, itemsForMatch, ["id", "label"], {
    threshold: 0.55,
    maxResults: 1,
  });
  const target = hit?.obj?.id || null;

  if (!target) {
    const list = bullets(mapItemNames(game, candidates));
    await sendText(
      jid,
      `Couldn’t find that to take. You can pick up:\n${list}`
    );
    return;
  }

  // Validate that target is a real item in the cartridge
  const isValidItem = (game.items || []).some((i) => i.id === target);
  if (!isValidItem) {
    await sendText(jid, "You can’t stuff that in your pocket.");
    return;
  }

  // Initialize inventory
  state.inventory = Array.isArray(state.inventory) ? state.inventory : [];

  // Already have it?
  if (state.inventory.includes(target)) {
    await sendText(
      jid,
      game.ui?.templates?.alreadyHaveItem || "Already in your inventory."
    );
    return;
  }

  // Remove from the correct source (room floor or specific container in its room)
  const src = sources.get(target);
  if (src) {
    if (src.type === "room") {
      if (Array.isArray(src.room.items)) {
        src.room.items = src.room.items.filter((x) => x !== target);
      }
    } else if (src.type === "object") {
      if (Array.isArray(src.object.contents)) {
        src.object.contents = src.object.contents.filter((x) => x !== target);
      }
    }
  }

  // Add to inventory
  state.inventory.push(target);

  const pickedName = itemDisplay(game, target);
  const def = (game.items || []).find((i) => i.id === target);
  const custom = def?.messages?.take;
  if (custom) {
    await sendText(jid, custom.replace("{item}", pickedName));
  } else {
    const confirmTpl = game.ui?.templates?.takeConfirmed || "Taken: {item}.";
    await sendText(jid, confirmTpl.replace("{item}", pickedName));
  }
}
