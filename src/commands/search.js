import { sendText } from "../services/whinself.js";
import { fuzzyPickFromObjects } from "../utils/fuzzyMatch.js";

// Per-user object state helpers
function ensureObjectState(state) {
  if (!state.objects || typeof state.objects !== "object") state.objects = {};
  return state.objects;
}
function getObjState(state, objId) {
  ensureObjectState(state);
  return state.objects[objId] || {};
}

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

export async function run({ jid, user, game, state, args }) {
  if (!state.inStructure || !state.structureId) {
    await sendText(jid, "You are not inside a building. Use /enter first.");
    return;
  }

  const token = args && args.length ? args.join(" ") : "";
  if (!token) {
    await sendText(jid, "Search what? Try */search desk* or */check cabinet*.");
    return;
  }

  const loc = getLoc(game, state);
  const struct = getStruct(loc, state);
  if (!struct) {
    await sendText(jid, "Structure not found.");
    return;
  }

  const rooms = Array.isArray(struct.rooms) ? struct.rooms : [];
  const here = getRoom(struct, state);

  const objectsHere = here?.objects || [];
  const objectsAll = rooms.flatMap((r) => r.objects || []);

  // Prefer current room
  let hit = fuzzyPickFromObjects(token, objectsHere, ["id", "displayName"], {
    threshold: 0.55,
    maxResults: 1,
  });
  if (!hit)
    hit = fuzzyPickFromObjects(token, objectsAll, ["id", "displayName"], {
      threshold: 0.6,
      maxResults: 1,
    });
  const obj = hit?.obj;

  if (!obj) {
    const names = objectsAll
      .map((o) => `*${o.displayName || o.id}*`)
      .join(", ");
    await sendText(
      jid,
      names
        ? `No such object. Try one of: ${names}`
        : "No objects to search here."
    );
    return;
  }

  // Effective lock/open state with per-user overrides
  const lock = obj.lock || {};
  const oState = getObjState(state, obj.id);
  const isLocked =
    typeof oState.locked === "boolean" ? oState.locked : !!lock.locked;
  if (isLocked) {
    const name = obj.displayName || obj.id;
    let hint = lock.lockedHint || "";
    if (hint) {
      hint = String(hint)
        .replace(/^\s*(it['’]?s locked|locked)\.?\s*/i, "")
        .trim();
      await sendText(jid, `Hmmm. *${name}* is locked. ${hint}`);
    } else {
      const tail =
        lock.type === "key"
          ? "A key would help."
          : lock.type === "code"
          ? "It needs a code."
          : lock.type === "authorization"
          ? "You’ll need authorization."
          : "It won’t open—something’s keeping it shut.";
      await sendText(jid, `Hmmm. *${name}* is locked. ${tail}`);
    }
    return;
  }

  // Openable but not opened yet → don’t reveal contents
  const isOpenable = (obj.tags || []).includes("openable");
  const isOpenedBase = obj.states?.opened === true;
  const isOpened =
    typeof oState.opened === "boolean" ? oState.opened : isOpenedBase;
  if (isOpenable && !isOpened) {
    const lastWord = String(obj.displayName || obj.id)
      .split(/\s+/)
      .pop()
      .toLowerCase();
    await sendText(
      jid,
      `You check the *${
        obj.displayName || obj.id
      }*. It’s closed. Try */open ${lastWord}* or */use <item>*.`
    );
    return;
  }

  // Raw contents
  const contents = Array.isArray(obj.contents) ? obj.contents : [];

  // Filter out items already taken (in inventory)
  const inv = Array.isArray(state.inventory) ? state.inventory : [];
  const remaining = contents.filter((id) => !inv.includes(id));

  if (!remaining.length) {
    const emptyTakenTpl =
      game.ui?.templates?.searchEmptyTaken ||
      game.ui?.templates?.searchEmpty ||
      "You search the *{object}*—nothing else.";
    await sendText(
      jid,
      emptyTakenTpl.replace("{object}", obj.displayName || obj.id)
    );
    return;
  }

  const itemNames = mapItemNames(game, remaining);
  const foundTpl =
    game.ui?.templates?.searchFound || "You search the *{object}* and find:";
  const list = bullets(itemNames);

  // Remove any inline {items} token from the template to avoid duplication
  const headerRaw = foundTpl.replace("{object}", obj.displayName || obj.id);
  const header = headerRaw.replace(/\s*\{items\}\s*[.,:]?/gi, "");

  await sendText(jid, list ? `${header}\n${list}` : header);
}
