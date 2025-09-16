import { sendText } from "../services/whinself.js";
import { fuzzyPickFromObjects } from "../utils/fuzzyMatch.js";

function normalize(s = "") {
  return s
    .normalize("NFKD")
    .replace(/[’‘ʼˈ`´]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase()
    .trim();
}

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
function itemDef(game, candidates, id) {
  const fromCats = candidates?.itemIndex?.[id];
  if (fromCats) return fromCats;
  return (game.items || []).find((i) => i.id === id) || null;
}
function objectLabel(o) {
  return o?.displayName || o?.id || "object";
}

function prettyLabel(o) {
  const raw = o?.displayName || o?.name || o?.id || "object";
  if (o?.displayName || o?.name) return raw;
  // humanize snake_case / id
  return String(raw)
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function splitArgs(args) {
  const raw = (args || []).join(" ").trim();
  if (!raw) return { itemToken: "", objectToken: "" };
  const text = normalize(raw);
  const m = text.match(/^(.*?)\s+(?:on|with|to|onto)\s+(.*)$/);
  if (m) {
    return { itemToken: m[1].trim(), objectToken: m[2].trim() };
  }
  const parts = text.split(/\s+/);
  const itemToken = parts.shift() || "";
  const objectToken = parts.join(" ");
  return { itemToken, objectToken };
}

function getObjState(state, objId) {
  state.objects =
    state.objects && typeof state.objects === "object" ? state.objects : {};
  state.objects[objId] = state.objects[objId] || {};
  return state.objects[objId];
}
function setObjState(state, objId, patch) {
  state.objects =
    state.objects && typeof state.objects === "object" ? state.objects : {};
  state.objects[objId] = { ...(state.objects[objId] || {}), ...(patch || {}) };
}

function ensureFlags(state) {
  state.flags =
    state.flags && typeof state.flags === "object" ? state.flags : {};
  return state.flags;
}

export async function run({ jid, user, game, state, args, candidates }) {
  if (!state.inStructure || !state.structureId) {
    await sendText(jid, "Use that where? Step inside first with */enter*.");
    return;
  }

  const { itemToken, objectToken } = splitArgs(args);
  if (!itemToken) {
    await sendText(jid, "Use what? Try */inventory* or */look objects*.");
    return;
  }

  const loc = getLoc(game, state);
  const struct = getStruct(loc, state);
  const room = getRoom(struct, state);
  if (!room) {
    await sendText(jid, "Wrong place for that.");
    return;
  }

  // Build inventory candidates
  const inv = Array.isArray(state.inventory) ? state.inventory : [];
  const invEntries = inv.map((id) => {
    const def = itemDef(game, candidates, id);
    const label = def?.displayName || def?.name || id;
    return {
      id,
      label,
      norm: normalize(label),
      obj: def || { id, displayName: label },
    };
  });

  const itemHit = fuzzyPickFromObjects(
    itemToken,
    invEntries,
    ["id", "label", "norm"],
    { threshold: 0.45, maxResults: 1 }
  );
  const item = itemHit?.obj || null;
  const itemId = item?.id;
  if (!item || !itemId) {
    await sendText(jid, "You aren't holding that.");
    return;
  }

  // Build object candidates (current room only) from catalogue
  const objectMap = candidates?.objectIndex || {};
  const objectsHereIds = Array.isArray(room.objects) ? room.objects : [];
  const hereDefs = objectsHereIds.map((oid) => objectMap[oid]).filter(Boolean);
  const hereEntries = hereDefs.map((o) => ({
    id: o.id,
    label: o.displayName || o.name || o.id,
    norm: normalize(o.displayName || o.name || o.id),
    obj: o,
  }));

  let objHit = fuzzyPickFromObjects(
    objectToken,
    hereEntries,
    ["id", "label", "norm"],
    { threshold: 0.45, maxResults: 1 }
  );
  // If no object token provided, try to infer from item token (e.g., "/use key box")
  if (!objHit && !objectToken) {
    objHit = fuzzyPickFromObjects(
      itemToken,
      hereEntries,
      ["id", "label", "norm"],
      { threshold: 0.45, maxResults: 1 }
    );
  }

  const obj = objHit?.obj || null;
  if (!obj) {
    const names = hereEntries.map((e) => `*${e.label}*`).join(", ");
    await sendText(
      jid,
      names
        ? `Use it on what? Here you have: ${names}`
        : "Use it on what? Nothing here."
    );
    return;
  }

  // If the matched object is missing a lock definition in this instance,
  // try to recover the lock metadata from any identical object definition
  // within the same structure (same id). This is safe for single-room but
  // also guards against partial data merges.
  let effectiveObj = obj;
  if (!effectiveObj.lock && objectMap && objectMap[obj.id]?.lock) {
    effectiveObj = objectMap[obj.id];
  }

  // Debug: inspect matched object and per-user state
  try {
    const ovr = (state.objects && state.objects[effectiveObj.id]) || {};
    console.debug("[use] matched", {
      itemId,
      itemLabel: item?.displayName || item?.name || itemId,
      objId: obj.id,
      objName: obj.displayName || obj.id,
      hasLock: !!obj.lock,
      usedFallback: effectiveObj !== obj,
      effHasLock: !!effectiveObj.lock,
      effLock: effectiveObj.lock || null,
      override: ovr,
    });
  } catch (_) {}

  // Effective lock/open state merges user state with base object
  const oState = getObjState(state, effectiveObj.id);
  const baseLocked = effectiveObj.lock ? !!effectiveObj.lock.locked : false;
  const baseOpened = effectiveObj.states ? !!effectiveObj.states.opened : false;
  const isLocked = oState.locked ?? baseLocked;

  const lock = effectiveObj.lock || null;
  if (!lock) {
    const lockable = Array.isArray(obj.tags) && obj.tags.includes("lockable");
    const note = lockable
      ? "looks lockable, but no lock is defined in the cartridge."
      : "doesn’t have a lock.";
    await sendText(jid, `*${prettyLabel(obj)}* ${note}`);
    return;
  }

  if (isLocked) {
    // Prefer explicit requiredItem, regardless of type
    if (lock.requiredItem) {
      if (lock.requiredItem !== itemId) {
        const fail =
          lock.lockedHint ||
          item?.messages?.useFail ||
          "That mechanism isn’t compatible with this item.";
        await sendText(jid, fail);
        return;
      }
      const patch = { locked: false };
      if (lock.autoOpenOnUnlock) patch.opened = true;
      setObjState(state, effectiveObj.id, patch);
      if (lock.onUnlockFlag) {
        ensureFlags(state)[lock.onUnlockFlag] = true;
      }
      const ok = lock.onUnlockMsg || `Unlocked ${prettyLabel(obj)}.`;
      await sendText(jid, ok);
      return;
    }

    // Fallback: type-based key
    if (lock.type === "key") {
      const isKey =
        (item?.tags || []).includes("key") ||
        /key/i.test(item?.name || item?.displayName || "");
      if (!isKey) {
        const fail =
          lock.lockedHint || item?.messages?.useFail || "That doesn’t fit.";
        await sendText(jid, fail);
        return;
      }
      const patch = { locked: false };
      if (lock.autoOpenOnUnlock) patch.opened = true;
      setObjState(state, effectiveObj.id, patch);
      if (lock.onUnlockFlag) {
        ensureFlags(state)[lock.onUnlockFlag] = true;
      }
      const ok = lock.onUnlockMsg || `Unlocked ${prettyLabel(obj)}.`;
      await sendText(jid, ok);
      return;
    }

    // Unknown lock types → deny
    await sendText(jid, lock.lockedHint || "It won’t budge.");
    return;
  }

  // Not locked
  const isOpened = oState.opened ?? baseOpened;
  if (!isOpened && lock) {
    await sendText(jid, `*${prettyLabel(obj)}* is unlocked but closed.`);
    return;
  }

  await sendText(jid, "Nothing happens.");
}
