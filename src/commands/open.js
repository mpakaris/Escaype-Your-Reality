import { onOpen } from "../services/hooks.js";
import { tpl } from "../services/renderer.js";
import { sendText } from "../services/whinself.js";
import { fuzzyPickFromObjects } from "../utils/fuzzyMatch.js";
import { setFlag } from "./_helpers/flagNormalization.js";
import { markRevealed } from "./_helpers/revealed.js";

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

function nameOfItem(id, itemMap) {
  const it = itemMap[id];
  return (it && (it.displayName || it.name)) || prettyId(id);
}

function listNames(arr) {
  return (arr || []).map((o) => `*${o.displayName || o.id}*`).join(", ");
}

function ensureObjectState(state) {
  if (!state.objects || typeof state.objects !== "object") state.objects = {};
  return state.objects;
}
function getObjState(state, objId) {
  ensureObjectState(state);
  return state.objects[objId] || {};
}
function setObjState(state, objId, patch) {
  ensureObjectState(state);
  state.objects[objId] = { ...(state.objects[objId] || {}), ...(patch || {}) };
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
    const msg =
      tpl(game?.ui, "open.notInside") ||
      "Open what? Step inside first with */enter*.";
    await sendText(jid, msg);
    return;
  }
  const token = args && args.length ? args.join(" ") : "";
  if (!token) {
    const msg =
      tpl(game?.ui, "open.what", {
        example1: "/open desk",
        example2: "/open cabinet",
      }) || "Open what? Try */open desk* or */open cabinet*.";
    await sendText(jid, msg);
    return;
  }

  const loc = getLoc(game, state);
  const struct = getStruct(loc, state);
  if (!struct) {
    await sendText(
      jid,
      tpl(game?.ui, "open.noStructure") || "Structure not found."
    );
    return;
  }

  // Build candidate maps with safe fallbacks
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

  const here = getRoom(struct, state);
  const wantIds = new Set(here?.objects || []);
  const fromIndex = (here?.objects || [])
    .map((id) => objectMap[id])
    .filter(Boolean);
  let objectsHere = fromIndex;
  // Supplement from array payload if index missed some
  if (Array.isArray(candidates.objects) && candidates.objects.length) {
    const have = new Set(objectsHere.map((o) => o.id));
    for (const o of candidates.objects) {
      if (o && wantIds.has(o.id) && !have.has(o.id)) objectsHere.push(o);
    }
  }

  const norm = (s) =>
    String(s || "")
      .toLowerCase()
      .trim();
  const tok = norm(token);

  // Resolve object: exact → startsWith → contains → fuzzy
  let obj =
    objectsHere.find(
      (o) => norm(o.id) === tok || norm(o.displayName) === tok
    ) ||
    objectsHere.find((o) => norm(o.displayName || o.id).startsWith(tok)) ||
    objectsHere.find((o) => norm(o.displayName || o.id).includes(tok)) ||
    null;
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
    obj = hit?.obj || null;
  }

  if (!obj) {
    const names = listNames(objectsHere);
    const msg = names
      ? tpl(game?.ui, "open.whichOne", { names }) ||
        `Open what? Here you have: ${names}`
      : tpl(game?.ui, "open.noneHere") || "Nothing here to open.";
    await sendText(jid, msg);
    return;
  }

  const name = obj.displayName || obj.id;
  const tags = Array.isArray(obj.tags) ? obj.tags : [];
  const isOpenable = tags.includes("openable");
  const lock = obj.lock || {};
  const oState = getObjState(state, obj.id);
  const isLocked =
    typeof oState.locked === "boolean" ? oState.locked : !!lock.locked;
  const isOpenedBase = obj.states?.opened === true;
  const isOpened =
    typeof oState.opened === "boolean" ? oState.opened : isOpenedBase;
  const msg = obj.messages || {};

  if (!isOpenable) {
    const msgText =
      msg.openFail ||
      tpl(game?.ui, "open.notOpenable", { name }) ||
      `*${name}* can’t be opened.`;
    await sendText(jid, msgText);
    return;
  }

  if (isLocked) {
    const txt = msg.openFail || lock.lockedHint;
    const fallback =
      tpl(game?.ui, "open.locked", { name }) ||
      `Hmmm, *${name}* seems locked. It will need a key or code.`;
    await sendText(jid, txt || fallback);
    return;
  }

  // If already open, just list remaining contents
  const inv = Array.isArray(state.inventory) ? state.inventory : [];
  const contents = Array.isArray(obj.contents) ? obj.contents : [];
  const remaining = contents.filter((id) => !inv.includes(id));

  if (!isOpened) {
    setObjState(state, obj.id, { opened: true });
    // progression: record opened_object flag on first open
    setFlag(state, `opened_object:${obj.id}`);
    try {
      await onOpen({ jid, user, game, state }, obj);
    } catch {}
  }

  const base = msg.openSuccess || `You open the *${name}*.`;
  if (!remaining.length) {
    const emptyMsg =
      tpl(game?.ui, "open.empty", { name }) || `${base} It’s empty.`;
    await sendText(jid, emptyMsg);
    return;
  }

  // Mark these items as revealed so they become takeable
  try {
    markRevealed(state, remaining);
  } catch {}

  const items = remaining.map((id) => `*${nameOfItem(id, itemMap)}*`);
  const list = bullets(items);
  const foundMsg =
    tpl(game?.ui, "open.contents", { name, list }) ||
    `${base}\nInside you find:\n${list}`;
  await sendText(jid, foundMsg);
}
