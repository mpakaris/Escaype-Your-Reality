import { onOpen } from "../services/hooks.js";
import { tpl } from "../services/renderer.js";
import { sendText } from "../services/whinself.js";
import { fuzzyPickFromObjects } from "../utils/fuzzyMatch.js";
import { setFlag } from "./_helpers/flagNormalization.js";

function pickUseFail(obj, item, ui, fallback) {
  return (
    obj?.messages?.useFail ||
    item?.messages?.useFail ||
    tpl(ui, "use.nothing") ||
    fallback ||
    "Nothing happens."
  );
}
function pickUseSuccess(obj, item, ui, fallback) {
  return (
    obj?.messages?.useSuccess ||
    item?.messages?.useSuccess ||
    tpl(ui, "use.nothing") ||
    fallback ||
    "Nothing happens."
  );
}

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

function asIndex(list = []) {
  const m = Object.create(null);
  for (const it of list) if (it && it.id) m[it.id] = it;
  return m;
}

function prettyLabel(o) {
  const raw = o?.displayName || o?.name || o?.id || "object";
  if (o?.displayName || o?.name) return raw;
  // humanize snake_case / id
  return String(raw)
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function isCodeToken(tok) {
  const t = String(tok || "").trim();
  // allow digits, letters, and common keypad symbols
  return t.length > 0 && t.length <= 64 && /^[A-Za-z0-9#*\-_.:+]+$/.test(t);
}
function codeEquals(input, lock) {
  const rawIn = String(input || "");
  const need = lock?.requiredCode != null ? String(lock.requiredCode) : null;
  const cs = !!lock?.caseSensitive;
  if (Array.isArray(lock?.acceptedCodes) && lock.acceptedCodes.length) {
    return lock.acceptedCodes.some((c) =>
      cs ? rawIn === String(c) : normalize(rawIn) === normalize(String(c))
    );
  }
  if (need != null) {
    return cs ? rawIn === need : normalize(rawIn) === normalize(need);
  }
  if (lock?.codeRegex) {
    try {
      return new RegExp(lock.codeRegex).test(rawIn);
    } catch {
      return false;
    }
  }
  return false;
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

export async function run({ jid, user, game, state, args, candidates }) {
  if (!state.inStructure || !state.structureId) {
    await sendText(
      jid,
      tpl(game?.ui, "use.notInside") ||
        "Use that where? Step inside first with */enter*."
    );
    return;
  }

  const { itemToken, objectToken } = splitArgs(args);

  const loc = getLoc(game, state);
  const struct = getStruct(loc, state);
  const room = getRoom(struct, state);
  if (!room) {
    await sendText(
      jid,
      tpl(game?.ui, "use.wrongPlace") || "Wrong place for that."
    );
    return;
  }

  // Build a full catalogue index so we don't lose fields like `lock`
  const fullMap = asIndex(
    game?.objects || game?.object_catalogue || game?.catalogue?.objects || []
  );

  // Build object candidates (current room only) from catalogue and candidates
  const objectMap = candidates?.objectIndex || {};
  const candArray = Array.isArray(candidates?.objects)
    ? candidates.objects
    : [];
  // Normalize room.objects entries to raw IDs (they can be strings or {id})
  const objectsHereIds = (Array.isArray(room.objects) ? room.objects : [])
    .map((e) => (typeof e === "string" ? e : e && e.id))
    .filter(Boolean);
  let hereDefs = objectsHereIds
    .map(
      (oid) =>
        fullMap[oid] ||
        objectMap[oid] ||
        candArray.find((r) => r && r.id === oid)
    )
    .filter(Boolean);
  // Fallback: if the room definition lacks object ids, use candidate objects for this room
  if (!hereDefs.length && candArray.length) {
    hereDefs = candArray.slice();
  }
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
  if (!objHit && !objectToken) {
    // If no object token provided, try to infer from item token (e.g., "/use 1234 keypad")
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
    const msg = names
      ? tpl(game?.ui, "use.whichOne", { names }) ||
        `Use it on what? Here you have: ${names}`
      : tpl(game?.ui, "use.noneHere") || "Use it on what? Nothing here.";
    await sendText(jid, msg);
    return;
  }

  // If the matched object is missing a lock definition in this instance, recover it from catalogue
  let effectiveObj = obj;
  if (!effectiveObj.lock) {
    if (objectMap && objectMap[obj.id]?.lock) effectiveObj = objectMap[obj.id];
    else if (fullMap && fullMap[obj.id]?.lock) effectiveObj = fullMap[obj.id];
  }

  if (!itemToken) {
    await sendText(
      jid,
      tpl(game?.ui, "use.what") ||
        "Use what? Try */inventory* or */look objects*."
    );
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

  // If no inventory item matched, but the token looks like a code and the target has a code/pin lock, try it
  if ((!item || !itemId) && isCodeToken(itemToken)) {
    const lock = effectiveObj.lock || null;
    const isCodeLock = lock && (lock.type === "code" || lock.type === "pin");
    if (isCodeLock) {
      const alreadyUnlocked =
        (getObjState(state, effectiveObj.id).locked ?? lock.locked === true) ===
        false;
      if (alreadyUnlocked) {
        await sendText(
          jid,
          tpl(game?.ui, "use.alreadyUnlocked", { name: prettyLabel(obj) }) ||
            `*${prettyLabel(obj)}* is already unlocked.`
        );
        return;
      }
      if (codeEquals(itemToken, lock)) {
        const patch = { locked: false };
        if (lock.autoOpenOnUnlock) patch.opened = true;
        setObjState(state, effectiveObj.id, patch);
        if (lock.onUnlockFlag) setFlag(state, lock.onUnlockFlag, true);
        if (patch.opened === true)
          setFlag(state, `opened_object:${effectiveObj.id}`);
        const ok =
          lock.onUnlockMsg ||
          tpl(game?.ui, "use.unlocked", { name: prettyLabel(obj) }) ||
          `Unlocked ${prettyLabel(obj)}.`;
        await sendText(jid, ok);
        try {
          await onOpen({ jid, user, game, state }, effectiveObj);
        } catch {}
        return;
      } else {
        const fail =
          lock.onCodeFail ||
          lock.lockedHint ||
          obj?.messages?.useFail ||
          item?.messages?.useFail ||
          tpl(game?.ui, "use.codeFail") ||
          "Code rejected.";
        await sendText(jid, fail);
        return;
      }
    }
  }

  if (!item || !itemId) {
    await sendText(
      jid,
      tpl(game?.ui, "use.notHolding") || "You aren't holding that."
    );
    return;
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

  // BREAKABLE: treat as a special lock that flips to broken=true via specific items
  if (lock && lock.type === "breakable") {
    const oState = getObjState(state, effectiveObj.id);
    const baseBroken = !!lock.broken;
    const isBroken = oState.broken ?? baseBroken;

    const required = Array.isArray(lock.requiredItems)
      ? lock.requiredItems
      : lock.requiredItem
      ? [lock.requiredItem]
      : [];
    const matches = required.length ? required.includes(itemId) : false;

    if (!isBroken) {
      if (!matches) {
        const fail =
          lock.breakFailMsg ||
          effectiveObj?.messages?.useFail ||
          item?.messages?.useFail ||
          tpl(game?.ui, "use.breakFail") ||
          "That won’t break it.";
        await sendText(jid, fail);
        return;
      }
      // Break now
      const patch = { broken: true };
      if (lock.autoOpenOnUnlock || lock.autoOpenOnBreak) patch.opened = true;
      setObjState(state, effectiveObj.id, patch);
      if (patch.opened === true)
        setFlag(state, `opened_object:${effectiveObj.id}`);

      const ok =
        lock.onBreakMsg ||
        effectiveObj?.messages?.openSuccess ||
        effectiveObj?.messages?.useSuccess ||
        tpl(game?.ui, "use.broke", { name: prettyLabel(effectiveObj) }) ||
        `You break *${prettyLabel(effectiveObj)}*.`;
      await sendText(jid, ok);
      try {
        if (patch.opened === true)
          await onOpen({ jid, user, game, state }, effectiveObj);
      } catch {}
      return;
    }

    // Already broken
    if (oState.opened ?? !!effectiveObj.states?.opened) {
      const ok = pickUseSuccess(effectiveObj, item, game?.ui);
      await sendText(jid, ok);
    } else {
      // It’s broken but not marked opened
      const msg =
        tpl(game?.ui, "use.unlockedButClosed", {
          name: prettyLabel(effectiveObj),
        }) || `*${prettyLabel(effectiveObj)}* is broken but still closed.`;
      await sendText(jid, msg);
    }
    return;
  }

  if (!lock) {
    const tags = Array.isArray(obj.tags) ? obj.tags : [];
    const usable = tags.includes("usable");
    if (usable) {
      const ok = pickUseSuccess(obj, item, game?.ui);
      await sendText(jid, ok);
      return;
    }
    const lockable = tags.includes("lockable");
    const note = lockable
      ? "looks lockable, but no lock is defined in the cartridge."
      : "doesn’t have a lock.";
    await sendText(
      jid,
      tpl(game?.ui, "use.noLock", { name: prettyLabel(obj), note }) ||
        `*${prettyLabel(obj)}* ${note}`
    );
    return;
  }

  if (isLocked) {
    // Prefer explicit requiredItem, regardless of type
    if (lock.requiredItem) {
      if (lock.requiredItem !== itemId) {
        const fail =
          obj?.messages?.useFail ||
          item?.messages?.useFail ||
          lock.lockedHint ||
          "That mechanism isn’t compatible with this item.";
        await sendText(jid, fail);
        return;
      }
      const patch = { locked: false };
      if (lock.autoOpenOnUnlock) patch.opened = true;
      setObjState(state, effectiveObj.id, patch);
      if (lock.onUnlockFlag) setFlag(state, lock.onUnlockFlag, true);
      if (patch.opened === true)
        setFlag(state, `opened_object:${effectiveObj.id}`);
      const ok =
        lock.onUnlockMsg ||
        tpl(game?.ui, "use.unlocked", { name: prettyLabel(obj) }) ||
        `Unlocked ${prettyLabel(obj)}.`;
      await sendText(jid, ok);
      try {
        await onOpen({ jid, user, game, state }, effectiveObj);
      } catch {}
      return;
    }

    // Fallback: type-based key
    if (lock.type === "key") {
      const isKey =
        (item?.tags || []).includes("key") ||
        /key/i.test(item?.name || item?.displayName || "");
      if (!isKey) {
        const fail =
          obj?.messages?.useFail ||
          item?.messages?.useFail ||
          lock.lockedHint ||
          "That doesn’t fit.";
        await sendText(jid, fail);
        return;
      }
      const patch = { locked: false };
      if (lock.autoOpenOnUnlock) patch.opened = true;
      setObjState(state, effectiveObj.id, patch);
      if (lock.onUnlockFlag) setFlag(state, lock.onUnlockFlag, true);
      if (patch.opened === true)
        setFlag(state, `opened_object:${effectiveObj.id}`);
      const ok =
        lock.onUnlockMsg ||
        tpl(game?.ui, "use.unlocked", { name: prettyLabel(obj) }) ||
        `Unlocked ${prettyLabel(obj)}.`;
      await sendText(jid, ok);
      try {
        await onOpen({ jid, user, game, state }, effectiveObj);
      } catch {}
      return;
    }

    // Unknown lock types → deny
    await sendText(
      jid,
      lock.lockedHint || tpl(game?.ui, "use.locked") || "It won’t budge."
    );
    return;
  }

  // Not locked
  const isOpened = oState.opened ?? baseOpened;
  if (!isOpened && lock) {
    await sendText(
      jid,
      tpl(game?.ui, "use.unlockedButClosed", { name: prettyLabel(obj) }) ||
        `*${prettyLabel(obj)}* is unlocked but closed.`
    );
    return;
  }

  const ok = pickUseSuccess(obj, item, game?.ui);
  await sendText(jid, ok);
}
