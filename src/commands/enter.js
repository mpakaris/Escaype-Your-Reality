import { sendText } from "../services/whinself.js";
import { fuzzyPickFromObjects } from "../utils/fuzzyMatch.js";

function getCurrentLocation(game, state) {
  const id = state.location;
  return (game.locations || []).find((l) => l.id === id) || null;
}

function findEnterableAtLocation(loc) {
  const all = Array.isArray(loc?.structures) ? loc.structures : [];
  return all.filter((s) => s && s.enterable);
}

function pickRandom(arr = []) {
  if (!Array.isArray(arr) || !arr.length) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

export async function run({ jid, user, game, state, args }) {
  // already inside?
  if (state.inStructure && state.structureId) {
    await sendText(
      jid,
      game.ui?.templates?.alreadyInside || "You are already inside."
    );
    return;
  }

  const loc = getCurrentLocation(game, state);
  if (!loc) {
    await sendText(
      jid,
      game.ui?.templates?.whereAmI || "You are nowhere. Use /move."
    );
    return;
  }

  const enterables = findEnterableAtLocation(loc);
  if (!enterables.length) {
    await sendText(jid, "No enterable buildings here.");
    return;
  }

  // choose target — argument REQUIRED even if only one building
  const token = args && args.length ? args.join(" ") : "";
  if (!token) {
    const names = enterables.map((s) => `*${s.displayName}*`).join(", ");
    await sendText(
      jid,
      `Enter which building? ${names}\nExample: */enter ${enterables[0].displayName
        .split(" ")
        .pop()
        .toLowerCase()}*`
    );
    return;
  }

  const hit = fuzzyPickFromObjects(token, enterables, ["id", "displayName"], {
    threshold: 0.55,
    maxResults: 1,
  });
  const target = hit?.obj || null;
  if (!target) {
    const names = enterables.map((s) => `*${s.displayName}*`).join(", ");
    await sendText(jid, `No such building here. Try one of: ${names}`);
    return;
  }

  // mutate state to inside
  state.inStructure = true;
  state.structureId = target.id;
  const firstRoom =
    Array.isArray(target.rooms) && target.rooms.length
      ? target.rooms[0].id
      : null;
  state.roomId = firstRoom;

  // Message 1: confirmation
  const confirmTpl =
    game.ui?.templates?.enterConfirmed || "You slip inside *{structure}*.";
  await sendText(
    jid,
    confirmTpl.replace("{structure}", target.displayName || target.id)
  );

  // Message 2: a random onEnter line if present
  const onEnter = Array.isArray(target.onEnter) ? target.onEnter : [];
  const narratorLines = onEnter
    .filter((s) => s && s.type === "narrator" && s.text)
    .map((s) => s.text);
  const line = pickRandom(narratorLines);
  if (line) {
    await sendText(jid, line);
  }
}
