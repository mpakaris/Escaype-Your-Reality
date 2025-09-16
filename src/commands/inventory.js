import { sendText } from "../services/whinself.js";

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

function mapItemNames(game, ids) {
  const candMap = game?.candidates?.itemIndex || {};
  const gameDict = Object.fromEntries(
    (game.items || []).map((i) => [i.id, i.displayName || i.name || i.id])
  );
  return (ids || []).map((id) => {
    const fromCand = candMap[id]?.displayName || candMap[id]?.name;
    if (fromCand) return fromCand;
    const fromGame = gameDict[id];
    if (fromGame) return fromGame;
    return prettyId(id);
  });
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
