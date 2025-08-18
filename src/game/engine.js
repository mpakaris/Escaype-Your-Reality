import { promises as fs } from "fs";
import path from "path";
import * as checkCmd from "../commands/check.js";
import * as dropCmd from "../commands/drop.js";
import * as enterCmd from "../commands/enter.js";
import * as exitCmd from "../commands/exit.js";
import * as inventoryCmd from "../commands/inventory.js";
import * as lookCmd from "../commands/look.js";
import * as moveCmd from "../commands/move.js";
import * as nextCmd from "../commands/next.js";
import * as openCmd from "../commands/open.js";
import * as readCmd from "../commands/read.js";
import * as resetCmd from "../commands/reset.js";
import * as searchCmd from "../commands/search.js";
import * as skipCmd from "../commands/skip.js";
import * as takeCmd from "../commands/take.js";
import * as talkCmd from "../commands/talk.js";
import * as useCmd from "../commands/use.js";
import { checkAndAdvanceChapter } from "../services/progress.js";
import { sendText } from "../services/whinself.js";
import { inSequence } from "./flow.js";

const commands = {
  next: nextCmd,
  reset: resetCmd,
  exit: exitCmd,
  skip: skipCmd,
  move: moveCmd,
  enter: enterCmd,
  look: lookCmd,
  check: checkCmd,
  take: takeCmd,
  inventory: inventoryCmd,
  read: readCmd,
  drop: dropCmd,
  use: useCmd,
  talk: talkCmd,
  open: openCmd,
  search: searchCmd,
};

async function loadUser(userId) {
  const p = path.resolve(process.cwd(), "src", "db", "user", `${userId}.json`);
  const raw = await fs.readFile(p, "utf-8");
  return { data: JSON.parse(raw), path: p };
}
async function saveUser(userObj, filePath) {
  await fs.writeFile(filePath, JSON.stringify(userObj, null, 2), "utf-8");
}
async function loadGame(gameUUID) {
  const p = path.resolve(
    process.cwd(),
    "src",
    "db",
    "games",
    `${gameUUID}.json`
  );
  const raw = await fs.readFile(p, "utf-8");
  return JSON.parse(raw);
}

function getCurrentLocation(game, state) {
  return (game.locations || []).find((l) => l.id === state.location) || null;
}
function getCurrentStructure(game, state) {
  const loc = getCurrentLocation(game, state);
  if (!loc) return null;
  return (loc.structures || []).find((s) => s.id === state.structureId) || null;
}

function ensureRoomInStructure(game, state) {
  const struct = getCurrentStructure(game, state);
  if (!struct || !Array.isArray(struct.rooms) || struct.rooms.length === 0)
    return;
  // Prefer existing id if valid, else 'main', else first room
  const byId = state.roomId && struct.rooms.find((r) => r.id === state.roomId);
  const main = struct.rooms.find((r) => r.id === "main");
  const chosen = byId || main || struct.rooms[0];
  if (!state.roomId || state.roomId !== chosen.id) state.roomId = chosen.id;
}

export async function handleIncoming({ jid, from, text }) {
  if (!jid) return;
  const userId = jid.replace(/@s\.whatsapp\.net$/, "");
  let userWrap;
  try {
    userWrap = await loadUser(userId);
  } catch {
    return;
  }
  const user = userWrap.data;
  const gameUUID = user.currentGameUuid;
  if (!gameUUID) return;
  let game;
  try {
    game = await loadGame(gameUUID);
  } catch {
    return;
  }
  const state =
    (user.currentState && user.currentState[gameUUID]) ||
    (user.currentState[gameUUID] = {});

  const input = (text || "").trim();
  const isCmd = input.startsWith("/");
  const parts = isCmd ? input.slice(1).split(/\s+/) : [];
  const cmd = parts[0]?.toLowerCase() || "";
  if (cmd === "next") {
    console.log("ENGINE: User sent /next", { jid, flow: state.flow });
  }
  if (cmd === "reset") {
    console.log("ENGINE: User sent /reset", { jid, flow: state.flow });
  }
  if (cmd === "exit") {
    console.log("ENGINE: User sent /exit", { jid, flow: state.flow });
  }
  const args = parts.slice(1);
  console.log("engine parsed:", { input, isCmd, cmd, flow: state.flow });

  if (inSequence(state)) {
    const allowed = new Set(["next", "reset", "exit"]);
    if (process.env.CODING_ENV === "DEV") {
      allowed.add("skip");
    }

    const introLen = (game.sequences?.intro || []).length;
    const atSeq = state.flow?.seq ?? 0;
    const atStep = state.flow?.step ?? 0;

    if (!isCmd || !allowed.has(cmd)) {
      console.debug("[engine] intro gate block:", {
        input,
        cmd,
        allowed: Array.from(allowed),
        flow: state.flow,
        introLen,
        atSeq,
        atStep,
      });
      const msg =
        game.ui?.templates?.unknownCommandDuringIntro ||
        "Finish the introduction first. Type */next*, */exit*, or */reset*.";
      await sendText(jid, msg);
      return;
    }
  } else {
    // When not in sequence, allow /move as valid command
    const allowed = new Set(Object.keys(commands));
    if (isCmd && !allowed.has(cmd)) {
      await sendText(
        jid,
        game.ui?.templates?.unknownCommandGeneric || "Unknown command."
      );
      return;
    }
  }

  // Always honor reset/exit immediately to avoid being blocked by any gating
  if (isCmd && (cmd === "reset" || cmd === "exit")) {
    const handler = commands[cmd];
    if (handler?.run) {
      console.debug("[engine] early-dispatch", { cmd, flow: state.flow });
      await handler.run({ jid, user, game, state, args });
      // Normalize room after command side-effects
      if (state.inStructure && state.structureId) {
        try {
          ensureRoomInStructure(game, state);
        } catch {}
      } else {
        if (state.roomId) state.roomId = null;
      }
      await checkAndAdvanceChapter({ jid, game, state });
      await saveUser(user, userWrap.path);
      console.log("ENGINE: state saved (early)", {
        seq: state.flow?.seq,
        step: state.flow?.step,
        hdr: state.flow?._headerShown,
      });
      return;
    }
  }

  const handler = commands[cmd];
  if (!handler) {
    await sendText(
      jid,
      game.ui?.templates?.unknownCommandGeneric || "Unknown command."
    );
    return;
  }

  // Normalize room context to single-room model
  if (state.inStructure && state.structureId) {
    try {
      ensureRoomInStructure(game, state);
    } catch {}
  } else {
    // outside any structure, keep roomId unset
    if (state.roomId) state.roomId = null;
  }

  await handler.run({ jid, user, game, state, args });
  console.debug("[engine] ran handler", { cmd, args });
  // Generic visit flags: mark location and structure visits in user state
  try {
    state.flags =
      state.flags && typeof state.flags === "object" ? state.flags : {};

    const loc = getCurrentLocation(game, state);
    if (loc?.id) {
      state.flags[`visited_location:${loc.id}`] = true;
    }

    if (state.inStructure) {
      const struct = getCurrentStructure(game, state);
      if (struct?.id) {
        state.flags[`visited_structure_id:${struct.id}`] = true;
        const label = (
          struct.displayName ||
          struct.name ||
          struct.id ||
          ""
        ).toLowerCase();
        const slug = label.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
        if (slug) state.flags[`visited_structure_label:${slug}`] = true;
      }
    }
  } catch {}
  await checkAndAdvanceChapter({ jid, game, state });
  await saveUser(user, userWrap.path);
  console.log("ENGINE: state saved", {
    seq: state.flow?.seq,
    step: state.flow?.step,
    hdr: state.flow?._headerShown,
  });
}
