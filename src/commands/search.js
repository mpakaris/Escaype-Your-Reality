import { tpl } from "../services/renderer.js";
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

const canon = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

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
    await sendText(
      jid,
      tpl(game?.ui, "errors.notInside") ||
        "You are not inside a building. Use /enter first."
    );
    return;
  }

  const token = args && args.length ? args.join(" ") : "";
  if (!token) {
    await sendText(
      jid,
      tpl(game?.ui, "search.prompt") ||
        "Search what? Try */search desk* or */search coat*."
    );
    return;
  }

  const loc = getLoc(game, state);
  const struct = getStruct(loc, state);
  if (!struct) {
    await sendText(
      jid,
      tpl(game?.ui, "errors.structureNotFound") || "Structure not found."
    );
    return;
  }

  const candidates = candArg || game?.candidates || {};
  let objectMap = getMap(candidates, "objects");
  let itemMap = getMap(candidates, "items");
  // Always keep a full catalogue index to avoid losing fields like `lock`
  const fullMap = asIndex(
    game?.objects || game?.object_catalogue || game?.catalogue?.objects || []
  );
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
    .map((id) => fullMap[id] || objectMap[id])
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
        const full = fullMap[o.id] || o;
        objectsHere.push(full);
      }
    }
  }

  const norm = (s) =>
    String(s || "")
      .toLowerCase()
      .trim();
  const tok = norm(token);
  const tokCanon = canon(token);
  // 1) exact match by id or displayName
  let obj = objectsHere.find(
    (o) => norm(o.id) === tok || norm(o.displayName) === tok
  );
  // 2) startsWith match by canonicalized text (e.g., "deposit" → "Deposit Box #42")
  if (!obj) {
    obj = objectsHere.find((o) => {
      const c1 = canon(o.displayName);
      const c2 = canon(o.id);
      return c1.startsWith(tokCanon) || c2.startsWith(tokCanon);
    });
  }
  // 3) fuzzy fallback
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
    const listMsg = names
      ? tpl(game?.ui, "search.promptWithList", { list: names }) ||
        `Search what? Here you have: ${names}`
      : tpl(game?.ui, "search.nothingHere") || "Nothing here to search.";
    await sendText(jid, listMsg);
    return;
  }

  const name = obj.displayName || obj.id;
  // Update active focus container so follow-up commands like /take know context
  state.focus = {
    containerId: obj.id,
    updatedAt: Date.now(),
  };
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

  const isBreakable = lock && lock.type === "breakable";
  const isBroken =
    typeof oState.broken === "boolean" ? oState.broken : !!lock.broken;

  if (openable && isLocked) {
    const msg =
      obj.messages?.searchLocked ||
      lock.lockedHint ||
      tpl(game?.ui, "search.locked", { name }) ||
      `Hmmm, *${name}* seems locked. It will need a key or code.`;
    await sendText(jid, msg);
    return;
  }
  // Breakable but not yet broken -> cannot be searched
  if (isBreakable && !isBroken) {
    const msg =
      obj.messages?.searchFail ||
      obj.messages?.searchFailMessage ||
      obj.messages?.searchClosed ||
      lock.breakFailMsg ||
      tpl(game?.ui, "search.closedContainer", { name }) ||
      `*${name}* cannot be searched yet.`;
    await sendText(jid, msg);
    return;
  }

  // If it's an openable container and not locked, require opening before searching contents
  if (openable && !isOpened) {
    const msg =
      obj.messages?.searchClosed ||
      tpl(game?.ui, "search.closedContainer", { name }) ||
      `*${name}* is closed. Use */open* first.`;
    await sendText(jid, msg);
    return;
  }

  if (!searchable && !(openable && isOpened)) {
    const msg =
      obj.messages?.searchNothing ||
      tpl(game?.ui, "search.resultsEmpty", { name }) ||
      `Nothing to search in *${name}*.`;
    await sendText(jid, msg);
    return;
  }

  // Hard guard: never reveal contents if locked, closed, or unbroken breakable
  if ((openable && (isLocked || !isOpened)) || (isBreakable && !isBroken)) {
    const msg = isLocked
      ? obj.messages?.searchLocked ||
        lock.lockedHint ||
        tpl(game?.ui, "search.locked", { name })
      : obj.messages?.searchClosed ||
        lock.breakFailMsg ||
        tpl(game?.ui, "search.closedContainer", { name }) ||
        `*${name}* cannot be searched right now.`;
    await sendText(jid, msg);
    return;
  }

  const inv = Array.isArray(state.inventory) ? state.inventory : [];
  const contents = Array.isArray(obj.contents) ? obj.contents : [];
  const remaining = contents.filter((id) => !inv.includes(id));
  if (!remaining.length) {
    const noneMsg =
      obj.messages?.searchNothing ||
      tpl(game?.ui, "search.resultsEmpty", { name }) ||
      game?.ui?.templates?.search?.resultsEmpty ||
      `You search the *${name}*, but whatever was here, is here no more.`;
    await sendText(jid, noneMsg);
    return;
  }
  // Mark these items as revealed so they become takeable
  try {
    markRevealed(state, remaining);
  } catch {}

  const items = remaining.map((id) => `*${nameOfItem(id, itemMap)}*`);
  const itemsList = bullets(items);
  const foundTpl = obj.messages?.searchFoundTpl;
  if (foundTpl) {
    const txt = foundTpl
      .replace(/\{\s*name\s*\}/g, name)
      .replace(/\{\s*items\s*\}/g, itemsList);
    await sendText(jid, txt);
  } else {
    const header =
      tpl(game?.ui, "search.resultsHeader", { name }) ||
      `Inside *${name}* you find:`;
    await sendText(jid, `${header}\n${itemsList}`);
  }
}
