import { runEntityHook } from "../services/hooks.js";
import { tpl } from "../services/renderer.js";
import { sendText } from "../services/whinself.js";

function findStructure(game, id) {
  if (!id) return null;
  const pools = [
    game?.structures,
    game?.catalogue?.structures,
    game?.structure_catalogue,
  ].filter(Boolean);
  for (const list of pools) {
    const hit = Array.isArray(list) ? list.find((s) => s?.id === id) : null;
    if (hit) return hit;
  }
  return null;
}

export default async function exitCmd(ctx /* { jid, game, state } */) {
  const { jid, game, state } = ctx;
  if (process?.env?.NODE_ENV !== "production")
    console.log("[exit] handler invoked", {
      inStructure: state?.inStructure,
      structureId: state?.structureId,
    });

  if (!state?.inStructure || !state?.structureId) {
    await sendText(
      jid,
      tpl(game?.ui, "exit.alreadyOutside") || "You are already outside."
    );
    return;
  }

  const struct = findStructure(game, state.structureId);

  // Run data-driven onExit effects if present
  if (struct) {
    await runEntityHook(ctx, struct, "onExit");
  }

  // Clear structure context
  state.inStructure = false;
  state.structureId = null;
  state.roomId = null;

  const name = struct?.displayName || struct?.name || struct?.id || "outside";
  const msg =
    struct?.messages?.onExitMessage ||
    tpl(game?.ui, "exit.toStreet", { structure: name }) ||
    `You step out of *${name}*.`;

  await sendText(jid, msg);
}
