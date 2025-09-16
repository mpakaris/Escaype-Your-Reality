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

// maps from engine candidates, with fallbacks
const asIndex = (v) => {
  if (!v) return {};
  if (Array.isArray(v)) {
    const idx = Object.create(null);
    for (const r of v) if (r && r.id) idx[r.id] = r;
    return idx;
  }
  return v;
};
const getMap = (cands, key) => {
  const c = cands || {};
  if (key === "objects")
    return asIndex(c.objectIndex || c.objectsIndex || c.objects);
  if (key === "items") return asIndex(c.itemIndex || c.itemsIndex || c.items);
  if (key === "npcs") return asIndex(c.npcIndex || c.npcsIndex || c.npcs);
  return asIndex(c[`${key}Index`] || c[key]);
};

const prettyId = (s) =>
  String(s || "")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (m) => m.toUpperCase());

function itemDisplayFromMap(itemMap, id) {
  const it = itemMap[id];
  return (it && (it.displayName || it.name)) || prettyId(id);
}

function ensureObjectState(state) {
  if (!state.objects || typeof state.objects !== "object") state.objects = {};
  return state.objects;
}
function getObjState(state, objId) {
  ensureObjectState(state);
  return state.objects[objId] || {};
}

export async function run({ jid, game, state, args, candidates: candArg }) {
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

  // candidate maps
  const candidates = candArg || game?.candidates || {};
  let objectMap = getMap(candidates, "objects");
  let itemMap = getMap(candidates, "items");
  if (!objectMap || !Object.keys(objectMap).length) {
    objectMap = asIndex(
      game?.objects || game?.object_catalogue || game?.catalogue?.objects || []
    );
  }
  if (!itemMap || !Object.keys(itemMap).length) {
    itemMap = asIndex(
      game?.items || game?.item_catalogue || game?.catalogue?.items || []
    );
  }

  const inv = Array.isArray(state.inventory) ? state.inventory : [];

  // Build candidates **in current room** only, respecting lock/open states
  const sources = new Map(); // id -> { type: 'room'|'object', room, object? }
  const candidateIds = new Set();

  // room-floor items
  const roomItems = Array.isArray(room.items) ? room.items : [];
  for (const it of roomItems) {
    if (inv.includes(it)) continue;
    candidateIds.add(it);
    if (!sources.has(it)) sources.set(it, { type: "room", room });
  }

  // container contents if unlocked + opened
  const objectIds = Array.isArray(room.objects) ? room.objects : [];
  for (const oid of objectIds) {
    const o = objectMap[oid];
    if (!o) continue;
    const tags = Array.isArray(o.tags) ? o.tags : [];
    const openable = tags.includes("openable");
    const lock = o.lock || {};
    const oState = getObjState(state, o.id);
    const locked =
      typeof oState.locked === "boolean" ? oState.locked : !!lock.locked;
    const openedBase = o.states?.opened === true;
    const opened =
      typeof oState.opened === "boolean" ? oState.opened : openedBase;
    if (locked) continue;
    if (openable && !opened) continue; // not visible until opened
    const contents = Array.isArray(o.contents) ? o.contents : [];
    for (const it of contents) {
      if (inv.includes(it)) continue;
      candidateIds.add(it);
      if (!sources.has(it))
        sources.set(it, { type: "object", room, object: o });
    }
  }

  const candList = Array.from(candidateIds);
  if (!candList.length) {
    await sendText(jid, "There’s nothing here you can take.");
    return;
  }

  // fuzzy resolve
  const itemsForMatch = candList.map((id) => ({
    id,
    label: itemDisplayFromMap(itemMap, id),
  }));
  const hit = fuzzyPickFromObjects(token, itemsForMatch, ["id", "label"], {
    threshold: 0.55,
    maxResults: 1,
  });
  const target = hit?.obj?.id || null;

  if (!target) {
    const list = bullets(
      candList.map((id) => `*${itemDisplayFromMap(itemMap, id)}*`)
    );
    await sendText(
      jid,
      `Couldn’t find that to take. You can pick up:\n${list}`
    );
    return;
  }

  // validate target is takeable in this context (candidate list)
  if (!candList.includes(target)) {
    await sendText(jid, "You can’t stuff that in your pocket.");
    return;
  }

  // init inventory
  state.inventory = Array.isArray(state.inventory) ? state.inventory : [];

  if (state.inventory.includes(target)) {
    await sendText(
      jid,
      game.ui?.templates?.alreadyHaveItem || "Already in your inventory."
    );
    return;
  }

  // remove from correct source
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

  // add to inventory
  state.inventory.push(target);

  const pickedName = itemDisplayFromMap(itemMap, target);
  const def =
    itemMap[target] || (game.items || []).find((i) => i.id === target);
  const custom = def?.messages?.take;
  if (custom) {
    await sendText(jid, custom.replace("{item}", pickedName));
  } else {
    const confirmTpl = game.ui?.templates?.takeConfirmed || "Taken: {item}.";
    await sendText(jid, confirmTpl.replace("{item}", pickedName));
  }
}
