import { onEnter as runOnEnter } from "../services/hooks.js";
import { tpl } from "../services/renderer.js";
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

export async function run({ jid, user, game, state, args }) {
  // already inside?
  if (state.inStructure && state.structureId) {
    await sendText(
      jid,
      tpl(game?.ui, "enter.alreadyInside") || "You are already inside."
    );
    return;
  }

  const loc = getCurrentLocation(game, state);
  if (!loc) {
    await sendText(
      jid,
      tpl(game?.ui, "enter.whereAmI") || "You are nowhere. Use /move."
    );
    return;
  }

  const enterables = findEnterableAtLocation(loc);
  if (!enterables.length) {
    await sendText(
      jid,
      tpl(game?.ui, "enter.noneHere") || "No enterable buildings here."
    );
    return;
  }

  // choose target — argument REQUIRED even if only one building
  const token = args && args.length ? args.join(" ") : "";
  if (!token) {
    const names = enterables.map((s) => `*${s.displayName}*`).join(", ");
    const example = enterables[0].displayName.split(" ").pop().toLowerCase();
    const msg =
      tpl(game?.ui, "enter.whichOne", { names, example }) ||
      `Enter which building? ${names}\nExample: */enter ${example}*`;
    await sendText(jid, msg);
    return;
  }

  const hit = fuzzyPickFromObjects(token, enterables, ["id", "displayName"], {
    threshold: 0.55,
    maxResults: 1,
  });
  const target = hit?.obj || null;
  if (!target) {
    const names = enterables.map((s) => `*${s.displayName}*`).join(", ");
    await sendText(
      jid,
      tpl(game?.ui, "enter.notFound", { names }) ||
        `No such building here. Try one of: ${names}`
    );
    return;
  }

  // mutate state to inside
  state.inStructure = true;
  state.structureId = target.id;
  state.roomId = "main";

  // Confirmation
  const confirmTpl =
    tpl(game?.ui, "enter.confirmed", {
      structure: target.displayName || target.id,
    }) || `You slip inside *${target.displayName || target.id}*.`;
  await sendText(jid, confirmTpl);

  // Declarative onEnter effects from the cartridge (texts, media, flags, etc.)
  try {
    await runOnEnter({ jid, user, game, state }, target);
  } catch {}
}
