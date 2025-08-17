import { sendText } from "../services/whinself.js";
import { fuzzyPickFromObjects } from "../utils/fuzzyMatch.js";

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
function itemDisplay(game, id) {
  const def = (game.items || []).find((i) => i.id === id);
  return def?.displayName || def?.name || id;
}

export async function run({ jid, user, game, state, args }) {
  // Must be inside a structure per design
  if (!state.inStructure || !state.structureId) {
    await sendText(jid, "You’re not inside. Step in first with */enter*.");
    return;
  }

  const token = args && args.length ? args.join(" ") : "";
  if (!token) {
    await sendText(jid, "Take what? Example: */take key*.");
    return;
  }

  const loc = getLoc(game, state);
  const struct = getStruct(loc, state);
  const room = getRoom(struct, state);
  if (!struct || !room) {
    await sendText(jid, "You’re nowhere useful to take anything.");
    return;
  }

  // Build candidate item ids visible/takeable **in this room**
  const roomLoose = Array.isArray(room.items) ? room.items : [];
  const objects = Array.isArray(room.objects) ? room.objects : [];

  const fromObjects = [];
  for (const o of objects) {
    const locked = !!(o.lock && o.lock.locked);
    const openable = (o.tags || []).includes("openable");
    const opened = o.states?.opened === true;
    if (locked) continue;
    if (openable && !opened) continue; // closed container, don’t expose contents
    if (Array.isArray(o.contents)) fromObjects.push(...o.contents);
  }

  const candidates = [...new Set([...(roomLoose || []), ...fromObjects])];
  if (!candidates.length) {
    await sendText(jid, "There’s nothing here you can take.");
    return;
  }

  // Create label list for fuzzy matching
  const itemsForMatch = candidates.map((id) => ({
    id,
    label: itemDisplay(game, id),
  }));
  const hit = fuzzyPickFromObjects(token, itemsForMatch, ["id", "label"], {
    threshold: 0.55,
    maxResults: 1,
  });
  const target = hit?.obj?.id || null;

  if (!target) {
    const list = bullets(mapItemNames(game, candidates));
    await sendText(
      jid,
      `Couldn’t find that to take. You can pick up:\n${list}`
    );
    return;
  }

  // Validate that target is a real item in the cartridge
  const isValidItem = (game.items || []).some((i) => i.id === target);
  if (!isValidItem) {
    await sendText(jid, "You can’t stuff that in your pocket.");
    return;
  }

  // Initialize inventory
  state.inventory = Array.isArray(state.inventory) ? state.inventory : [];

  // Already have it?
  if (state.inventory.includes(target)) {
    await sendText(
      jid,
      game.ui?.templates?.alreadyHaveItem || "Already in your inventory."
    );
    return;
  }

  // Remove from room or any eligible object in this room
  if (Array.isArray(room.items)) {
    room.items = room.items.filter((x) => x !== target);
  }
  for (const o of objects) {
    if (Array.isArray(o.contents)) {
      o.contents = o.contents.filter((x) => x !== target);
    }
  }

  // Add to inventory
  state.inventory.push(target);

  const pickedName = itemDisplay(game, target);
  const def = (game.items || []).find((i) => i.id === target);
  const custom = def?.messages?.take;
  if (custom) {
    await sendText(jid, custom.replace("{item}", pickedName));
  } else {
    const confirmTpl = game.ui?.templates?.takeConfirmed || "Taken: {item}.";
    await sendText(jid, confirmTpl.replace("{item}", pickedName));
  }
}
