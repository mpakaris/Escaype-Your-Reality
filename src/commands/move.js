function suggestEnter(structures = []) {
  if (!structures.length) return "building";
  const first = String(structures[0] || "");
  const words = first
    .replace(/[^\p{L}\p{N}\s']/gu, "")
    .trim()
    .split(/\s+/);
  if (!words.length) return "building";
  // prefer last word (Bank, Apartment, Diner, etc.)
  return words[words.length - 1].toLowerCase();
}
import { runEntityHook } from "../services/hooks.js";
import { tpl } from "../services/renderer.js";
import { sendText } from "../services/whinself.js";

function formatList(items = []) {
  const arr = items.filter(Boolean);
  if (arr.length === 0) return "nothing notable";
  if (arr.length === 1) return arr[0];
  if (arr.length === 2) return `${arr[0]} and ${arr[1]}`;
  return `${arr.slice(0, -1).join(", ")}, and ${arr[arr.length - 1]}`;
}

function getLocationById(game, id) {
  const idStr = String(id);
  const plain = idStr.replace(",", "");
  const comma = plain.length === 2 ? `${plain[0]},${plain[1]}` : idStr;
  return (
    (game.locations || []).find((l) => {
      const lid = String(l.id);
      return lid === plain || lid === comma;
    }) || null
  );
}

export async function run({ jid, user, game, state, args }) {
  // DEV mode: auto-complete intro/tutorial so registry gates won't block moving
  if (process?.env?.CODING_ENV === "DEV") {
    state.flags = state.flags || {};
    state.flags.introDone = true;
    state.flags.tutorialDone = true;
    state.introActive = false;
    if (state.flow && typeof state.flow === "object") state.flow.active = false;
  }
  // Validate argument
  const rc = (args?.[0] || "").trim();
  if (!/^([1-3]{2})$/.test(rc)) {
    await sendText(
      jid,
      tpl(game?.ui, "move.invalid", {
        examples: "*/move 11*, */move 23*, */move 33*",
      }) ||
        "Invalid move. Use a 3x3 grid coordinate like */move 11*, */move 23*, */move 33*."
    );
    return;
  }

  // Translate to cartridge id format "r,c"
  const id = rc; // plain two-digit form
  const loc = getLocationById(game, id);
  const prevLoc = state.location ? getLocationById(game, state.location) : null;
  if (!loc) {
    await sendText(
      jid,
      tpl(game?.ui, "move.notFound") ||
        "No such intersection. The grid goes from 11 to 33."
    );
    return;
  }

  // Check if already at this location (supports legacy "1,1" in state)
  const current = String(state.location || "");
  const currentPlain = current.replace(",", "");
  if (currentPlain === id) {
    const pool = game.ui?.moveSameLocationRemarks || [];
    const fallback = [
      tpl(game?.ui, "move.alreadyHere") || "You’re already here.",
    ];
    const remark = pool.length
      ? pool[Math.floor(Math.random() * pool.length)]
      : fallback[0];
    await sendText(jid, remark);
    return;
  }

  // Update state
  state.location = String(loc.id);
  state.inStructure = false;
  state.structureId = null;
  state.roomId = null;

  // Run exit hook for previous location, then arrival hook for new location
  const ctx = { jid, user, game, state };
  try {
    if (prevLoc) await runEntityHook(ctx, prevLoc, "onExit");
  } catch {}
  try {
    await runEntityHook(ctx, loc, "onArrival");
  } catch {}

  // Fallback narrative if no hooks are defined on the new location
  const hasArrivalHook =
    Array.isArray(loc.onArrival) && loc.onArrival.length > 0;
  if (!hasArrivalHook) {
    const structuresAll = Array.isArray(loc.structures) ? loc.structures : [];
    const structures = structuresAll.map((s) => s.displayName).filter(Boolean);
    const enterableNames = structuresAll
      .filter((s) => s.enterable)
      .map((s) => s.displayName)
      .filter(Boolean);

    const structuresList = formatList(structures);
    const whereText =
      tpl(game?.ui, "whereOutside", {
        location: loc.name,
        flavor: loc.flavor || "",
        structures: structuresList,
      }) ||
      `You’re at *${loc.name}*. ${
        loc.flavor || ""
      }\n\n*Around you:* ${structuresList}`;

    const arrived =
      tpl(game?.ui, "move.arrived") || "You arrived at your destination.";
    const parts = [arrived, whereText];

    if (enterableNames.length) {
      const enterSuggest = suggestEnter(enterableNames);
      const hint =
        tpl(game?.ui, "move.enterHint", { suggest: enterSuggest }) ||
        `Use */enter ${enterSuggest}* to step inside.`;
      parts.push(`\n${hint}`);
    }

    await sendText(jid, parts.join("\n\n"));
  }
}
