import { sendText } from "../services/whinself.js";
import { fuzzyPickFromObjects } from "../utils/fuzzyMatch.js";

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
const bullets = (arr) =>
  (arr || [])
    .filter(Boolean)
    .map((t) => `• ${t}`)
    .join("\n");
function mapItemNames(game, ids) {
  const dict = Object.fromEntries(
    (game.items || []).map((i) => [i.id, i.displayName || i.name || i.id])
  );
  return (ids || []).map((id) => dict[id] || id);
}

export async function run({ jid, user, game, state, args }) {
  if (!state.inStructure || !state.structureId) {
    await sendText(jid, "Open what? Step inside first with */enter*.");
    return;
  }
  const token = args && args.length ? args.join(" ") : "";
  if (!token) {
    await sendText(jid, "Open what? Try */open desk* or */open cabinet*.");
    return;
  }

  const loc = getLoc(game, state);
  const struct = getStruct(loc, state);
  if (!struct) {
    await sendText(jid, "Structure not found.");
    return;
  }

  const here = getRoom(struct, state);
  const objectsHere = here?.objects || [];

  const hit = fuzzyPickFromObjects(token, objectsHere, ["id", "displayName"], {
    threshold: 0.55,
    maxResults: 1,
  });
  const obj = hit?.obj;
  if (!obj) {
    const names = objectsHere
      .map((o) => `*${o.displayName || o.id}*`)
      .join(", ");
    await sendText(
      jid,
      names ? `Open what? Here you have: ${names}` : "Nothing here to open."
    );
    return;
  }

  const name = obj.displayName || obj.id;
  const lock = obj.lock || {};
  const oState = getObjState(state, obj.id);
  const isLocked =
    typeof oState.locked === "boolean" ? oState.locked : !!lock.locked;
  const isOpenable = (obj.tags || []).includes("openable");
  const isOpenedBase = obj.states?.opened === true;
  const isOpened =
    typeof oState.opened === "boolean" ? oState.opened : isOpenedBase;

  if (!isOpenable) {
    await sendText(jid, `*${name}* can’t be opened.`);
    return;
  }
  if (isLocked) {
    await sendText(
      jid,
      lock.lockedHint ? lock.lockedHint : `*${name}* is locked.`
    );
    return;
  }
  if (isOpened) {
    // Already open → show contents
    const inv = Array.isArray(state.inventory) ? state.inventory : [];
    const contents = Array.isArray(obj.contents) ? obj.contents : [];
    const remaining = contents.filter((id) => !inv.includes(id));
    if (!remaining.length) {
      await sendText(jid, `*${name}* is already open. Nothing else inside.`);
      return;
    }
    const itemNames = mapItemNames(game, remaining);
    const list = bullets(itemNames);
    await sendText(jid, `*${name}* is already open. Inside you find:\n${list}`);
    return;
  }

  // Open now
  setObjState(state, obj.id, { opened: true });
  const inv = Array.isArray(state.inventory) ? state.inventory : [];
  const contents = Array.isArray(obj.contents) ? obj.contents : [];
  const remaining = contents.filter((id) => !inv.includes(id));
  if (!remaining.length) {
    await sendText(jid, `You open the *${name}*. It’s empty.`);
    return;
  }
  const itemNames = mapItemNames(game, remaining);
  const list = bullets(itemNames);
  await sendText(jid, `You open the *${name}*. Inside you find:\n${list}`);
}
