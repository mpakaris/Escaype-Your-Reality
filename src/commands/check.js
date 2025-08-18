import { sendText } from "../services/whinself.js";
import { fuzzyPickFromObjects } from "../utils/fuzzyMatch.js";

const hasFlag = (flags, key) => Boolean((flags || {})[key]);
const condOk = (conds, state) =>
  !conds ||
  conds.every((c) => {
    const s = String(c || "");
    if (s.startsWith("flag:")) return hasFlag(state.flags, s.slice(5));
    return true; // future: other condition kinds
  });

const BULLETS = (arr) =>
  (arr || [])
    .filter(Boolean)
    .map((t) => `• ${t}`)
    .join("\n");
const isObjectsWord = (s) =>
  /^(objects?|stuff|things?)$/i.test(String(s || ""));

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

export async function run({ jid, user, game, state, args }) {
  if (!state.inStructure || !state.structureId) {
    await sendText(jid, "You are not inside a building. Use /enter first.");
    return;
  }

  const token = args && args.length ? args.join(" ") : "";

  // If user asked '/check objects', list local objects instead of status'ing a random one
  if (isObjectsWord(token)) {
    const loc0 = getLoc(game, state);
    const struct0 = getStruct(loc0, state);
    const here0 = getRoom(struct0, state);
    const objs0 = (here0?.objects || []).filter((o) =>
      condOk(o.visibleWhen, state)
    );
    if (!objs0.length) {
      await sendText(jid, "No objects to check here.");
      return;
    }
    const names0 = objs0.map((o) => o.displayName || o.id);
    await sendText(jid, `Objects here:\n\n${BULLETS(names0)}`);
    return;
  }

  if (!token) {
    await sendText(jid, "Check what? Try */check desk* or */check cabinet*.");
    return;
  }

  const loc = getLoc(game, state);
  const struct = getStruct(loc, state);
  if (!struct) {
    await sendText(jid, "Structure not found.");
    return;
  }

  const here = getRoom(struct, state);
  const objectsHere = (here?.objects || []).filter((o) =>
    condOk(o.visibleWhen, state)
  );

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
      names
        ? `No such object here. Try one of: ${names}`
        : "No objects to check here."
    );
    return;
  }

  const name = obj.displayName || obj.id;
  const lock = obj.lock || {};
  const oState = (state.objects && state.objects[obj.id]) || {};
  const isLocked =
    typeof oState.locked === "boolean" ? oState.locked : !!lock.locked;
  const isOpenable = (obj.tags || []).includes("openable");
  const isOpenedBase = obj.states?.opened === true;
  const isOpened =
    typeof oState.opened === "boolean" ? oState.opened : isOpenedBase;

  if (isLocked) {
    let hint = lock.lockedHint || "";
    if (hint)
      hint = String(hint)
        .replace(/^\s*(it['’]?s locked|locked)\.?\s*/i, "")
        .trim();
    const tail =
      hint ||
      (lock.type === "key"
        ? "A key would help."
        : lock.type === "code"
        ? "It needs a code."
        : lock.type === "authorization"
        ? "You’ll need authorization."
        : "It won't open—something’s keeping it shut.");
    await sendText(jid, `Hmmm. *${name}* is locked. ${tail}`);
    return;
  }

  if (isOpenable && !isOpened) {
    await sendText(
      jid,
      `*${name}* isn’t locked, but it’s closed. Try */open ${name
        .split(/\s+/)
        .pop()
        .toLowerCase()}*.`
    );
    return;
  }

  // Open and unlocked → status only, no contents here
  if (isOpenable && isOpened) {
    await sendText(jid, `*${name}* is open.`);
    return;
  }

  // Non-openable objects: generic status with search hint
  const tags = Array.isArray(obj.tags) ? obj.tags : [];
  const searchable = tags.includes("searchable");
  if (searchable) {
    await sendText(
      jid,
      `You check *${name}*. Looks like you could search it. Try */search ${name
        .split(/\s+/)
        .pop()
        .toLowerCase()}*.`
    );
    return;
  }
  await sendText(jid, `You check *${name}*. Nothing unusual.`);
}
