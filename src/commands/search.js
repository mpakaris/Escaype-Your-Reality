import { sendText } from "../services/whinself.js";
import { fuzzyPickFromObjects } from "../utils/fuzzyMatch.js";
import { markRevealed } from "./_helpers/revealed.js";

// Index helpers (copied from check.js for catalogue resolution)
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

const hasFlag = (flags, key) => Boolean((flags || {})[key]);
const condOk = (conds, state) =>
  !conds ||
  conds.every((c) => {
    const s = String(c || "");
    if (s.startsWith("flag:")) return hasFlag(state.flags, s.slice(5));
    return true; // future: time/quest conditions
  });

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
const bullets = (arr) =>
  (arr || [])
    .filter(Boolean)
    .map((t) => `• ${t}`)
    .join("\n");

const prettyId = (s) =>
  String(s || "")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (m) => m.toUpperCase());

function nameOfItem(id, itemMap) {
  const it = itemMap[id];
  return (it && (it.displayName || it.name)) || prettyId(id);
}

export async function run({
  jid,
  user,
  game,
  state,
  args,
  candidates: candArg,
}) {
  if (!state.inStructure || !state.structureId) {
    await sendText(jid, "You are not inside a building. Use /enter first.");
    return;
  }

  const token = args && args.length ? args.join(" ") : "";
  if (!token) {
    await sendText(jid, "Search what? Try */search desk* or */search coat*.");
    return;
  }

  const loc = getLoc(game, state);
  const struct = getStruct(loc, state);
  if (!struct) {
    await sendText(jid, "Structure not found.");
    return;
  }

  const candidates = candArg || game?.candidates || {};
  let objectMap = getMap(candidates, "objects");
  let itemMap = getMap(candidates, "items");
  // Fallback if engine didn’t preload candidates
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

  const room = getRoom(struct, state);
  const wantIds = new Set(room?.objects || []);
  const fromIndex = (room?.objects || [])
    .map((id) => objectMap[id])
    .filter(Boolean);
  let objectsHere = fromIndex.filter((o) => condOk(o.visibleWhen, state));
  // Supplement from candidates array if the index missed some
  if (Array.isArray(candidates.objects) && candidates.objects.length) {
    const have = new Set(objectsHere.map((o) => o.id));
    for (const o of candidates.objects) {
      if (
        o &&
        wantIds.has(o.id) &&
        !have.has(o.id) &&
        condOk(o.visibleWhen, state)
      ) {
        objectsHere.push(o);
      }
    }
  }

  const norm = (s) =>
    String(s || "")
      .toLowerCase()
      .trim();
  const tok = norm(token);
  let obj = objectsHere.find(
    (o) => norm(o.id) === tok || norm(o.displayName) === tok
  );
  if (!obj) {
    const hit = fuzzyPickFromObjects(
      token,
      objectsHere,
      ["id", "displayName"],
      {
        threshold: 0.55,
        maxResults: 1,
      }
    );
    obj = hit?.obj;
  }
  if (!obj) {
    let names = objectsHere.map((o) => `*${o.displayName || o.id}*`).join(", ");
    if (!names) {
      const fromArray = (
        Array.isArray(candidates.objects) ? candidates.objects : []
      ).filter((o) => o && wantIds.has(o.id));
      if (fromArray.length)
        names = fromArray.map((o) => `*${o.displayName || o.id}*`).join(", ");
      if (!names && Array.isArray(room?.objects) && room.objects.length)
        names = room.objects.map((id) => `*${prettyId(id)}*`).join(", ");
    }
    await sendText(
      jid,
      names ? `Search what? Here you have: ${names}` : "Nothing here to search."
    );
    return;
  }

  const name = obj.displayName || obj.id;
  const tags = Array.isArray(obj.tags) ? obj.tags : [];
  const searchable = tags.includes("searchable");
  const openable = tags.includes("openable");

  // Locks / states
  const lock = obj.lock || {};
  const oState = (state.objects && state.objects[obj.id]) || {};
  const isLocked =
    typeof oState.locked === "boolean" ? oState.locked : !!lock.locked;
  const isOpenedBase = obj.states?.opened === true;
  const isOpened =
    typeof oState.opened === "boolean" ? oState.opened : isOpenedBase;

  if (openable && isLocked) {
    await sendText(
      jid,
      `Hmmm, *${name}* seems locked. It will need a key or code.`
    );
    return;
  }

  // If it's an openable container and not locked, require opening before searching contents
  if (openable && !isOpened) {
    await sendText(jid, `*${name}* is closed. Use */open* first.`);
    return;
  }

  if (!searchable && !(openable && isOpened)) {
    await sendText(jid, `Nothing to search in *${name}*.`);
    return;
  }

  // Searchable surface or open container: list contents not yet in inventory
  const inv = Array.isArray(state.inventory) ? state.inventory : [];
  const contents = Array.isArray(obj.contents) ? obj.contents : [];
  const remaining = contents.filter((id) => !inv.includes(id));
  if (!remaining.length) {
    await sendText(jid, `You search the *${name}*, but find nothing new.`);
    return;
  }
  // Mark these items as revealed so they become takeable
  try {
    markRevealed(state, remaining);
  } catch {}

  const items = remaining.map((id) => `*${nameOfItem(id, itemMap)}*`);
  await sendText(
    jid,
    `Happy the who shall search! The following items were found inside *${name}*:\n${bullets(
      items
    )}`
  );
}
