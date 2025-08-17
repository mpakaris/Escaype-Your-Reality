import { sendText } from "../services/whinself.js";

const bullets = (arr) =>
  (arr || [])
    .filter(Boolean)
    .map((t) => `• ${t}`)
    .join("\n");

function mapItemNames(game, ids) {
  const dict = Object.fromEntries(
    (game.items || []).map((i) => [i.id, i.displayName || i.name || i.id])
  );
  return (ids || []).map((id) => dict[id] || id);
}

export async function run({ jid, user, game, state }) {
  state.inventory = Array.isArray(state.inventory) ? state.inventory : [];
  const names = mapItemNames(game, state.inventory);

  if (!names.length) {
    const empty =
      game.ui?.templates?.inventoryEmpty || "Your pockets are empty.";
    await sendText(jid, empty);
    return;
  }

  const header = game.ui?.templates?.inventoryHeader || "You’re carrying:";
  await sendText(jid, `${header}\n${bullets(names)}`);
}
