import { tpl } from "../services/renderer.js";
import { sendImage, sendText } from "../services/whinself.js";
import { fuzzyPickFromObjects } from "../utils/fuzzyMatch.js";
import { isRevealed } from "./_helpers/revealed.js";

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

function pickCheckMessage(obj, state, ui) {
  const name = obj.displayName || obj.id;
  const tags = Array.isArray(obj.tags) ? obj.tags : [];
  const lock = obj.lock || {};
  const oState = (state.objects && state.objects[obj.id]) || {};
  const isLocked =
    typeof oState.locked === "boolean" ? oState.locked : !!lock.locked;
  const isOpenable = tags.includes("openable");
  const isOpenedBase = obj.states?.opened === true;
  const isOpened =
    typeof oState.opened === "boolean" ? oState.opened : isOpenedBase;
  const msg = obj.messages || {};

  // Primary: author-provided description
  let desc = msg.checkSuccess || msg.checkFail || null;
  if (!desc) {
    // Minimal fallback description if author omitted
    if (tags.includes("searchable"))
      desc = `You inspect *${name}*. Could be worth a */search*.`;
    else if (isOpenable)
      desc = `You inspect *${name}*. A functional container.`;
    else desc = `You inspect *${name}*.`;
  }

  // Status hint, object-local first, then lock hints, then global templates
  let hint = "";
  if (isOpenable && isLocked) {
    hint =
      msg.searchLocked ||
      lock.lockedHint ||
      tpl(ui, "search.locked", { name }) ||
      "";
  } else if (isOpenable && !isOpened) {
    hint =
      msg.searchClosed || tpl(ui, "search.closedContainer", { name }) || "";
  }

  return hint ? `${desc}\n\n${hint}` : desc;
}

export async function run({
  jid,
  user,
  game,
  state,
  args,
  candidates: candArg,
}) {
  const candidates = candArg || game?.candidates || {};
  const objectMap = getMap(candidates, "objects");
  const itemMap = getMap(candidates, "items");

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
    const objectIds = here0?.objects || [];
    const objs0 = objectIds
      .map((id) => objectMap[id])
      .filter((o) => o && condOk(o.visibleWhen, state));
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
  const objectIdsHere = here?.objects || [];
  const wantIds = new Set(objectIdsHere);
  const roomItemIds = here?.items || [];

  // Robustly resolve object rows: use objectIndex, else fall back to candidates.objects scan
  const candObjsArr = Array.isArray((candidates || {}).objects)
    ? candidates.objects
    : [];
  const objectsHere = objectIdsHere
    .map(
      (id) => objectMap[id] || candObjsArr.find((o) => o && o.id === id) || null
    )
    .filter((o) => o && condOk(o.visibleWhen, state));

  const norm = (s) =>
    String(s || "")
      .toLowerCase()
      .trim();

  const itemsHere = roomItemIds
    .filter((id) => isRevealed(state, id))
    .map((id) => itemMap[id])
    .filter((it) => it && condOk(it.visibleWhen, state));

  let obj = null;
  let itm = null;

  const tok = norm(token);
  // 1) Exact id or displayName
  obj =
    objectsHere.find(
      (o) => norm(o.id) === tok || norm(o.displayName) === tok
    ) || null;
  // 2) Starts-with on displayName
  if (!obj) {
    obj = objectsHere.find((o) => norm(o.displayName).startsWith(tok)) || null;
  }
  // 3) Word-boundary contains on displayName
  if (!obj) {
    obj = objectsHere.find((o) => norm(o.displayName).includes(tok)) || null;
  }

  const words = tok.split(/\s+/).filter((w) => w.length >= 3);
  const anyWordMatches =
    tok.length >= 3 &&
    (objectsHere.some(
      (o) => norm(o.displayName).includes(tok) || norm(o.id).includes(tok)
    ) ||
      words.some((w) =>
        objectsHere.some(
          (o) => norm(o.displayName).includes(w) || norm(o.id).includes(w)
        )
      ));

  // 4) Fuzzy fallback
  if (!obj && anyWordMatches) {
    const hitObj = fuzzyPickFromObjects(
      token,
      objectsHere,
      ["id", "displayName"],
      {
        threshold: 0.55,
        maxResults: 1,
      }
    );
    obj = hitObj?.obj || null;
  }

  if (!obj && itemsHere.length) {
    const hitItm = fuzzyPickFromObjects(
      token,
      itemsHere,
      ["id", "displayName", "name"],
      {
        threshold: 0.55,
        maxResults: 1,
      }
    );
    itm = hitItm?.obj || null;
  }

  if (!obj && !itm) {
    if (process.env.CODING_ENV === "DEV") {
      console.debug("[check] objectIdsHere", objectIdsHere);
      console.debug("[check] objectIndex keys", Object.keys(objectMap || {}));
      console.debug("[check] candidates.objects count", candObjsArr.length);
    }
    let names = objectsHere.map((o) => `*${o.displayName || o.id}*`).join(", ");
    if (!names && Array.isArray(candidates.objects)) {
      const subset = candidates.objects.filter((o) => o && wantIds.has(o.id));
      if (subset.length)
        names = subset.map((o) => `*${o.displayName || o.id}*`).join(", ");
    }
    if (!names && objectIdsHere.length) {
      names = objectIdsHere.map((id) => `*${id}*`).join(", ");
    }
    await sendText(
      jid,
      names
        ? `No such object here. Try one of: ${names}`
        : "No such object here."
    );
    return;
  }

  if (itm) {
    const nm = itm.displayName || itm.name || itm.id;
    const tpl =
      game.ui?.templates?.itemHint ||
      "Items are crucial for your investigation. Carefully *{verb}* what you’ve found: */{cmd} {name}*.";
    const msg = tpl
      .replace("{verb}", "examine")
      .replace("{cmd}", "examine")
      .replace("{name}", nm);
    await sendText(jid, msg);
    return;
  }

  // Update active focus container so follow-up commands like /take know context
  state.focus = {
    containerId: obj.id,
    updatedAt: Date.now(),
  };
  await sendText(jid, pickCheckMessage(obj, state, game?.ui));
  if (obj.image) {
    try {
      await sendImage(jid, String(obj.image), obj.displayName || obj.id || "");
    } catch {}
  }
}
