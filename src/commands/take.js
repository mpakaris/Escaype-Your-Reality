import { routeIntent } from "../services/api/openai.js";
import { tpl } from "../services/renderer.js";
import { sendText } from "../services/whinself.js";
import { setFlag } from "./_helpers/flagNormalization.js";

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .trim();
const tokenize = (s) =>
  norm(s)
    .split(/[^a-z0-9]+/g)
    .filter(Boolean);

const asIndex = (arr) => {
  const m = Object.create(null);
  for (const x of Array.isArray(arr) ? arr : []) if (x && x.id) m[x.id] = x;
  return m;
};

const prettyLabel = (def, id) =>
  def?.displayName || def?.name || String(id).replace(/[_-]+/g, " ");

export async function run({ jid, game, state, args, candidates: preloaded }) {
  // minimal guards
  if (!state.inStructure || !state.structureId) {
    await sendText(
      jid,
      tpl(game?.ui, "take.notInside") || "You’re not inside. Use */enter*."
    );
    return;
  }

  const loc = (game.locations || []).find((l) => l.id === state.location);
  const struct = (loc?.structures || []).find(
    (s) => s.id === state.structureId
  );
  const room = (struct?.rooms || []).find((r) => r.id === state.roomId);
  if (!room) {
    await sendText(jid, tpl(game?.ui, "take.nowhere") || "Nowhere to take.");
    return;
  }

  const itemMap =
    (preloaded && preloaded.itemIndex) ||
    asIndex(game?.items || game?.catalogue?.items || []);
  const objectMap =
    (preloaded && preloaded.objectIndex) ||
    asIndex(game?.objects || game?.catalogue?.objects || []);
  const inv = (state.inventory = Array.isArray(state.inventory)
    ? state.inventory
    : []);

  // Collect simple available items:
  // 1) room.items
  const sources = new Map(); // itemId -> { type: 'room'|'object', object? }
  const labels = new Map(); // itemId -> Set<string>

  const add = (id, src) => {
    if (!id) return;
    if (!sources.has(id)) sources.set(id, src);
    if (!labels.has(id)) {
      const def = itemMap[id] || { id };
      const lset = new Set([
        ...tokenize(def.id),
        ...tokenize(def.displayName || def.name || ""),
      ]);
      labels.set(id, lset);
    }
  };

  for (const it of Array.isArray(room.items) ? room.items : []) {
    const iid = typeof it === "string" ? it : it?.id;
    add(iid, { type: "room" });
  }

  // Prefer items from the last searched container if present
  const focusId = state?.focus?.containerId;
  if (focusId && objectMap[focusId]) {
    const o = objectMap[focusId];
    const oState = (state.objects && state.objects[o.id]) || {};
    const opened = !!oState.opened;
    const broken = !!oState.broken;
    const hasOpenedState =
      o?.states && Object.prototype.hasOwnProperty.call(o.states, "opened");
    const lockType = o?.lock?.type;
    const accessible = broken || opened || (!hasOpenedState && !lockType);
    if (accessible) {
      for (const it of Array.isArray(o.contents) ? o.contents : []) {
        const iid = typeof it === "string" ? it : it?.id;
        add(iid, { type: "object", object: o });
      }
    }
  }

  // 2) items inside any objects placed in this room
  const roomObjectIds = Array.isArray(room.objects) ? room.objects : [];
  for (const oid of roomObjectIds) {
    const o = objectMap[oid];
    if (!o) continue;

    // Determine accessibility: include contents if opened or broken. If the object tracks an `opened` state, require it; otherwise allow simple containers with no lock.
    const lockType = o?.lock?.type;
    const oState = (state.objects && state.objects[o.id]) || {};
    const opened = !!oState.opened;
    const broken = !!oState.broken;
    const hasOpenedState =
      o?.states && Object.prototype.hasOwnProperty.call(o.states, "opened");
    const accessible = broken || opened || (!hasOpenedState && !lockType);

    if (!accessible) continue;

    for (const it of Array.isArray(o.contents) ? o.contents : []) {
      const iid = typeof it === "string" ? it : it?.id;
      add(iid, { type: "object", object: o });
    }
  }

  // --- AI context helpers ---
  const clean = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const nameMap = new Map(); // token -> canonical id
  const seenItems = new Set();
  const aiContextItems = [];

  const registerItemName = (id) => {
    if (!id || seenItems.has(id)) return;
    seenItems.add(id);
    const def = itemMap[id] || { id };
    const label = def.displayName || def.name || id;
    const keys = new Set([clean(id), ...tokenize(label)]);
    for (const k of keys) if (k) nameMap.set(k, id);
    aiContextItems.push(id);
  };

  // room items
  for (const it of Array.isArray(room.items) ? room.items : []) {
    const iid = typeof it === "string" ? it : it?.id;
    registerItemName(iid);
  }
  // focused container items first
  if (focusId && objectMap[focusId]) {
    const o = objectMap[focusId];
    for (const it of Array.isArray(o.contents) ? o.contents : []) {
      const iid = typeof it === "string" ? it : it?.id;
      registerItemName(iid);
    }
  }
  // items inside any room objects regardless of locks, for AI intent only
  for (const oid of Array.isArray(room.objects) ? room.objects : []) {
    const o = objectMap[oid];
    if (!o) continue;
    for (const it of Array.isArray(o.contents) ? o.contents : []) {
      const iid = typeof it === "string" ? it : it?.id;
      registerItemName(iid);
    }
  }

  const query = norm((args || []).join(" "));

  let candidates = Array.from(sources.keys());
  if (!candidates.length) {
    // Fallback: ask AI which item the user likely wanted
    try {
      const ai = await routeIntent(`take ${args.join(" ")}`, {
        commands: ["take"],
        objects: Array.isArray(room.objects) ? room.objects.map(String) : [],
        items: aiContextItems,
        npcs: [],
      });
      const wanted = clean(ai?.targetIds?.item || "");
      const mapped = nameMap.get(wanted) || nameMap.get(query) || null;
      if (mapped) {
        // verify presence and accessibility, then add to sources to reuse downstream logic
        // check room
        if (
          Array.isArray(room.items) &&
          room.items.some((x) => (typeof x === "string" ? x : x?.id) === mapped)
        ) {
          sources.set(mapped, { type: "room" });
          candidates = [mapped];
        } else {
          // check objects
          for (const oid of Array.isArray(room.objects) ? room.objects : []) {
            const o = objectMap[oid];
            if (!o) continue;
            const hasIt = (o.contents || []).some(
              (x) => (typeof x === "string" ? x : x?.id) === mapped
            );
            if (!hasIt) continue;
            const lockType = o?.lock?.type;
            const oState = (state.objects && state.objects[o.id]) || {};
            const opened = !!oState.opened;
            const broken = !!oState.broken;
            const hasOpenedState =
              o?.states &&
              Object.prototype.hasOwnProperty.call(o.states, "opened");
            const accessible =
              broken || opened || (!hasOpenedState && !lockType);
            if (!accessible) {
              await sendText(
                jid,
                o?.messages?.takeFailMessage ||
                  tpl(game?.ui, "take.blocked") ||
                  `You can’t take it from ${prettyLabel(o, o.id)} yet.`
              );
              return;
            }
            sources.set(mapped, { type: "object", object: o });
            candidates = [mapped];
            break;
          }
        }
      }
    } catch {}
  }

  if (!candidates.length) {
    await sendText(
      jid,
      tpl(game?.ui, "take.noneHere") || "There’s nothing here you can take."
    );
    return;
  }

  // Pick target
  let target = null;
  if (!query && candidates.length === 1) target = candidates[0];

  if (!target && query) {
    // exact id match
    for (const id of candidates)
      if (norm(id) === query) {
        target = id;
        break;
      }
    // token startsWith or includes on labels
    if (!target) {
      for (const id of candidates) {
        const lab = labels.get(id) || new Set();
        if (
          [...lab].some(
            (t) => t === query || t.startsWith(query) || t.includes(query)
          )
        ) {
          target = id;
          break;
        }
      }
    }
  }

  if (!target) {
    const list = candidates
      .map((id) => `• ${prettyLabel(itemMap[id], id)}`)
      .join("\n");
    await sendText(
      jid,
      tpl(game?.ui, "take.whichOne", { list }) || `Which one?\n${list}`
    );
    return;
  }

  // Already owned?
  if (inv.includes(target)) {
    const label = prettyLabel(itemMap[target], target);
    await sendText(
      jid,
      tpl(game?.ui, "take.alreadyHave", { item: label }) ||
        `You already have ${label}.`
    );
    return;
  }

  // Remove from source and add to inventory
  const src = sources.get(target);
  if (src?.type === "room" && Array.isArray(room.items)) {
    room.items = room.items.filter(
      (x) => (typeof x === "string" ? x : x?.id) !== target
    );
  } else if (src?.type === "object" && Array.isArray(src.object.contents)) {
    src.object.contents = src.object.contents.filter(
      (x) => (typeof x === "string" ? x : x?.id) !== target
    );
  }

  inv.push(target);
  setFlag(state, `has_item:${target}`);

  const picked = prettyLabel(itemMap[target], target);
  const msg =
    tpl(game?.ui, "take.confirmed", { item: picked }) || `Taken: ${picked}.`;
  await sendText(jid, msg);
}
