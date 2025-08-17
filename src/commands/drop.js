import { sendText } from "../services/whinself.js";
import { fuzzyPickFromObjects } from "../utils/fuzzyMatch.js";

function itemDef(game, id) {
  return (game.items || []).find((i) => i.id === id) || null;
}
function itemLabel(def, id) {
  return def?.displayName || def?.name || id;
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

export async function run({ jid, user, game, state, args }) {
  const token = args && args.length ? args.join(" ") : "";
  if (!token) {
    await sendText(jid, "Drop what? Example: */drop receipt*.");
    return;
  }

  // Inventory required
  const inv = Array.isArray(state.inventory) ? state.inventory : [];
  if (!inv.length) {
    await sendText(
      jid,
      game.ui?.templates?.inventoryEmpty || "Your pockets are empty."
    );
    return;
  }

  // Fuzzy match item from inventory
  const forMatch = inv.map((id) => ({
    id,
    label: itemDef(game, id)?.displayName || id,
  }));
  const hit = fuzzyPickFromObjects(token, forMatch, ["id", "label"], {
    threshold: 0.55,
    maxResults: 1,
  });
  const target = hit?.obj?.id || null;
  if (!target) {
    await sendText(jid, "You don’t have that.");
    return;
  }

  // Remove from inventory
  state.inventory = inv.filter((x) => x !== target);

  // Place item into current room if inside a structure
  const loc = getLoc(game, state);
  const struct = getStruct(loc, state);
  const room = getRoom(struct, state);
  if (state.inStructure && struct && room) {
    room.items = Array.isArray(room.items) ? room.items : [];
    if (!room.items.includes(target)) room.items.push(target);
  }

  const def = itemDef(game, target);
  const label = itemLabel(def, target);
  const custom = def?.messages?.drop;
  if (custom) {
    await sendText(jid, custom.replace("{item}", label));
  } else {
    const tpl = game.ui?.templates?.dropConfirmed || "Dropped: {item}.";
    await sendText(jid, tpl.replace("{item}", label));
  }
}
