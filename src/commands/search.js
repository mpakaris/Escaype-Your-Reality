import { sendText } from "../services/whinself.js";
import { fuzzyPickFromObjects } from "../utils/fuzzyMatch.js";

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
function itemNameDict(game) {
  return Object.fromEntries(
    (game.items || []).map((i) => [i.id, i.displayName || i.name || i.id])
  );
}

export async function run({ jid, user, game, state, args }) {
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

  const room = getRoom(struct, state);
  const objectsHere = (room?.objects || []).filter((o) =>
    condOk(o.visibleWhen, state)
  );

  // Room-only fuzzy match
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

  // If it is an openable container, redirect to /open logic
  if (openable) {
    if (isLocked) {
      const hint = lock.lockedHint || "It’s locked.";
      await sendText(jid, `*${name}* is locked. ${hint}`);
      return;
    }
    await sendText(jid, `*${name}* needs */open*, not */search*.`);
    return;
  }

  if (!searchable) {
    await sendText(jid, `Nothing to search in *${name}*.`);
    return;
  }

  // Searchable surfaces: list contents not yet in inventory
  const inv = Array.isArray(state.inventory) ? state.inventory : [];
  const contents = Array.isArray(obj.contents) ? obj.contents : [];
  const remaining = contents.filter((id) => !inv.includes(id));
  if (!remaining.length) {
    await sendText(jid, `You search the *${name}*, but find nothing new.`);
    return;
  }
  const dict = itemNameDict(game);
  const items = remaining.map((id) => dict[id] || id);
  await sendText(jid, `You search the *${name}* and find:\n${bullets(items)}`);
}
