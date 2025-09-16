import { sendImage, sendText } from "../services/whinself.js";
import { fuzzyPickFromObjects } from "../utils/fuzzyMatch.js";
import { isRevealed } from "./_helpers/revealed.js";

function asIndex(v) {
  if (!v) return {};
  if (Array.isArray(v)) {
    const idx = Object.create(null);
    for (const r of v) if (r && r.id) idx[r.id] = r;
    return idx;
  }
  return v;
}
function getMap(cands, key) {
  const c = cands || {};
  if (key === "items") return asIndex(c.itemIndex || c.itemsIndex || c.items);
  return asIndex(c[`${key}Index`] || c[key]);
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

const bullets = (arr) =>
  (arr || [])
    .filter(Boolean)
    .map((t) => `• ${t}`)
    .join("\n");
const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .trim();
const isImgUrl = (u) => /\.(png|jpe?g|gif|webp)$/i.test(String(u || ""));

function displayNameFor(item) {
  return item?.displayName || item?.name || item?.id || "item";
}

export async function run({ jid, game, state, args, candidates: candArg }) {
  // Build item map from engine preload with fallback to full catalogue
  const candidates = candArg || game?.candidates || {};
  let itemMap = getMap(candidates, "items");
  if (!itemMap || !Object.keys(itemMap).length) {
    itemMap = asIndex(
      game?.items || game?.item_catalogue || game?.catalogue?.items || []
    );
  }

  // Build object map to detect misuse (/examine <object>)
  let objectMap = getMap(candidates, "objects");
  if (!objectMap || !Object.keys(objectMap).length) {
    objectMap = asIndex(
      game?.objects || game?.object_catalogue || game?.catalogue?.objects || []
    );
  }

  // 1) Determine target item
  let target = null;
  const token = Array.isArray(args) && args.length ? args.join(" ") : "";

  // a) Only trust engine-provided targetItem when no explicit token is given
  if (
    !token &&
    candidates &&
    candidates.targetItem &&
    candidates.targetItem.id
  ) {
    target = candidates.targetItem;
  }

  // b) Otherwise resolve by args against inventory + revealed-in-room
  if (!target) {
    if (!token) {
      await sendText(jid, "Examine what? Try */examine receipt*.");
      return;
    }

    // If the token matches an OBJECT in the current room, nudge: items only
    const loc0 = getLoc(game, state);
    const struct0 = getStruct(loc0, state);
    const room0 = getRoom(struct0, state);
    const objIds0 = Array.isArray(room0?.objects) ? room0.objects : [];
    const objectsHere0 = objIds0.map((id) => objectMap[id]).filter(Boolean);
    const tok0 = norm(token);
    const matchObj0 =
      objectsHere0.find(
        (o) =>
          norm(o.id) === tok0 ||
          norm(o.displayName || o.id) === tok0 ||
          norm(o.displayName || o.id).startsWith(tok0) ||
          norm(o.displayName || o.id).includes(tok0)
      ) || null;
    if (matchObj0) {
      const hint =
        game.ui?.templates?.examineItemsOnly ||
        "This is not an item. You can only examine items.";
      await sendText(jid, hint);
      return;
    }

    const inv = Array.isArray(state.inventory) ? state.inventory : [];

    // Build the scope: inventory + revealed items in current room
    const loc = getLoc(game, state);
    const struct = getStruct(loc, state);
    const room = getRoom(struct, state);
    const roomItems = Array.isArray(room?.items) ? room.items : [];
    const objIds = Array.isArray(room?.objects) ? room.objects : [];
    const objectsHere = objIds
      .map((id) => objectMap[id])
      .filter(Boolean)
      .filter((o) => {
        const tags = Array.isArray(o.tags) ? o.tags : [];
        const openable = tags.includes("openable");
        const lock = o.lock || {};
        const oState = (state.objects && state.objects[o.id]) || {};
        const locked =
          typeof oState.locked === "boolean" ? oState.locked : !!lock.locked;
        const openedBase = o.states?.opened === true;
        const opened =
          typeof oState.opened === "boolean" ? oState.opened : openedBase;
        if (locked) return false;
        if (openable && !opened) return false;
        return true;
      });
    const objectContents = objectsHere.flatMap((o) =>
      Array.isArray(o?.contents) ? o.contents : []
    );

    // Items visible in this room = loose room items + contents of room objects
    const visiblePool = new Set([
      ...(roomItems || []),
      ...(objectContents || []),
    ]);

    const scopedIds = new Set([
      ...inv,
      ...Array.from(visiblePool).filter((id) => isRevealed(state, id)),
    ]);

    const scoped = Array.from(scopedIds)
      .map((id) => itemMap[id])
      .filter(Boolean);

    // exact → startsWith → contains → fuzzy
    const tok = norm(token);
    target =
      scoped.find(
        (i) => norm(i.id) === tok || norm(i.displayName || i.name) === tok
      ) ||
      scoped.find((i) =>
        norm(i.displayName || i.name || i.id).startsWith(tok)
      ) ||
      scoped.find((i) => norm(i.displayName || i.name || i.id).includes(tok)) ||
      null;

    if (!target) {
      const hit = fuzzyPickFromObjects(
        token,
        scoped,
        ["id", "displayName", "name"],
        { threshold: 0.55, maxResults: 1 }
      );
      target = hit?.obj || null;
    }

    if (!target) {
      const names = scoped.map((i) => `*${displayNameFor(i)}*`);
      await sendText(
        jid,
        names.length
          ? `Currently, No such item to examine.`
          : "No examinable items here."
      );
      return;
    }
  }

  const item = target.id ? itemMap[target.id] || target : target;
  const name = displayNameFor(item);

  // 2) Permission: must be in inventory or revealed in current room
  const inv = Array.isArray(state.inventory) ? state.inventory : [];
  const loc = getLoc(game, state);
  const struct = getStruct(loc, state);
  const room = getRoom(struct, state);
  const inInventory = inv.includes(item.id);
  const roomItems2 = Array.isArray(room?.items) ? room.items : [];
  const objIds2 = Array.isArray(room?.objects) ? room.objects : [];
  const objectsHere2 = objIds2
    .map((id) => objectMap[id])
    .filter(Boolean)
    .filter((o) => {
      const tags = Array.isArray(o.tags) ? o.tags : [];
      const openable = tags.includes("openable");
      const lock = o.lock || {};
      const oState = (state.objects && state.objects[o.id]) || {};
      const locked =
        typeof oState.locked === "boolean" ? oState.locked : !!lock.locked;
      const openedBase = o.states?.opened === true;
      const opened =
        typeof oState.opened === "boolean" ? oState.opened : openedBase;
      if (locked) return false;
      if (openable && !opened) return false;
      return true;
    });
  const objectContents2 = objectsHere2.flatMap((o) =>
    Array.isArray(o?.contents) ? o.contents : []
  );
  const visiblePool2 = new Set([
    ...(roomItems2 || []),
    ...(objectContents2 || []),
  ]);
  const inVisibleRoomPool = visiblePool2.has(item.id);
  const revealedHere = inVisibleRoomPool && isRevealed(state, item.id);
  if (!(inInventory || revealedHere)) {
    await sendText(
      jid,
      `You can only examine items that are in your inventory or have been revealed in this location. *${name}* is not accessible yet.`
    );
    return;
  }

  // 3) Compose message and media
  const ex = item.examine || {};
  const msg =
    ex.message ||
    item?.messages?.examine ||
    item?.description ||
    `You examine *${name}* closely.`;
  await sendText(jid, msg);

  const media = Array.isArray(ex.media) ? ex.media : ex.media ? [ex.media] : [];
  if (media.length) {
    for (const m of media) {
      const url = typeof m === "string" ? m : m?.url || m?.src;
      const cap = typeof m === "string" ? name : m?.caption || name;
      if (!url) continue;
      if (isImgUrl(url)) {
        try {
          await sendImage(jid, url, cap);
        } catch {}
      } else {
        await sendText(jid, url);
      }
    }
  } else if (item.image && isImgUrl(item.image)) {
    try {
      await sendImage(jid, String(item.image), name);
    } catch {}
  } else if (item.file) {
    await sendText(jid, String(item.file));
  }
}
