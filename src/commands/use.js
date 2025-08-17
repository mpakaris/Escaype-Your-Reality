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
function itemDef(game, id) {
  return (game.items || []).find((i) => i.id === id) || null;
}
function objectLabel(o) {
  return o?.displayName || o?.id || "object";
}

// Per-user object state helpers
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
  const prev = state.objects[objId] || {};
  state.objects[objId] = { ...prev, ...patch };
}

function splitArgs(args) {
  const raw = (args || []).join(" ").trim();
  if (!raw) return { itemToken: "", objectToken: "" };
  const ON = /\s+on\s+/i;
  if (ON.test(raw)) {
    const [left, right] = raw.split(ON);
    return {
      itemToken: (left || "").trim(),
      objectToken: (right || "").trim(),
    };
  }
  // fallback: first token is item, rest is object
  const parts = raw.split(/\s+/);
  const itemToken = parts.shift() || "";
  const objectToken = parts.join(" ");
  return { itemToken, objectToken };
}

export async function run({ jid, user, game, state, args }) {
  if (!state.inStructure || !state.structureId) {
    await sendText(jid, "Use what on what? Step inside first with */enter*.");
    return;
  }

  const { itemToken, objectToken } = splitArgs(args);
  if (!itemToken || !objectToken) {
    await sendText(
      jid,
      "Format: */use <item> on <object>*\nExample: */use key on box*."
    );
    return;
  }

  const loc = getLoc(game, state);
  const struct = getStruct(loc, state);
  const room = getRoom(struct, state);
  if (!struct || !room) {
    await sendText(jid, "There’s nothing here to use that on.");
    return;
  }

  // 1) Resolve item from inventory
  const inv = Array.isArray(state.inventory) ? state.inventory : [];
  const invForMatch = inv.map((id) => ({
    id,
    label: itemDef(game, id)?.displayName || id,
  }));
  const itemHit = fuzzyPickFromObjects(
    itemToken,
    invForMatch,
    ["id", "label"],
    { threshold: 0.55, maxResults: 1 }
  );
  const itemId = itemHit?.obj?.id || null;
  if (!itemId) {
    await sendText(jid, "You don’t have that item.");
    return;
  }
  const item = itemDef(game, itemId);

  // 2) Resolve object in current room first, then entire structure
  const objectsHere = Array.isArray(room.objects) ? room.objects : [];
  const objectsAll = (struct.rooms || []).flatMap((r) => r.objects || []);
  let objHit = fuzzyPickFromObjects(
    objectToken,
    objectsHere,
    ["id", "displayName"],
    { threshold: 0.55, maxResults: 1 }
  );
  if (!objHit)
    objHit = fuzzyPickFromObjects(
      objectToken,
      objectsAll,
      ["id", "displayName"],
      { threshold: 0.6, maxResults: 1 }
    );
  const obj = objHit?.obj || null;
  if (!obj) {
    const names = objectsAll
      .map((o) => `*${o.displayName || o.id}*`)
      .join(", ");
    await sendText(
      jid,
      names
        ? `No such object here. Try one of: ${names}`
        : "No objects here to use that on."
    );
    return;
  }

  const lock = obj.lock || {};
  const oState = getObjState(state, obj.id);
  const isLocked = typeof oState.locked === "boolean" ? oState.locked : !!lock.locked;
  // Already unlocked?
  if (!lock || isLocked === false) {
    await sendText(jid, `*${objectLabel(obj)}* isn’t locked.`);
    return;
  }

  // Keyed lock path per your object structure
  if (lock.type === "key") {
    const required = lock.requiredItem;
    if (required && required !== itemId) {
      const failMsg =
        (item?.messages && item.messages.useFail) || "That doesn’t fit.";
      await sendText(jid, failMsg);
      return;
    }

    // Persist unlock in per-user overrides
    const patch = { locked: false };
    if (lock.autoOpenOnUnlock) patch.opened = true;
    setObjState(state, obj.id, patch);

    // Success messaging: prefer item.messages.useSuccess, else lock.onUnlockMsg, else generic
    const okMsg =
      (item?.messages && item.messages.useSuccess) ||
      lock.onUnlockMsg ||
      `*${objectLabel(obj)}* unlocks.`;
    await sendText(jid, okMsg);

    // Hint to check contents if any
    if (Array.isArray(obj.contents) && obj.contents.length) {
      await sendText(jid, "You can now */check* it for contents.");
    }
    return;
  }

  // Other lock types can be added later
  await sendText(jid, "That mechanism isn’t compatible with this item.");
}
