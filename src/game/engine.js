import { promises as fs } from "fs";
import path from "path";
import * as dropCmd from "../commands/drop.js";
import * as enterCmd from "../commands/enter.js";
import * as exitCmd from "../commands/exit.js";
import * as inventoryCmd from "../commands/inventory.js";
import * as lookCmd from "../commands/look.js";
import * as moveCmd from "../commands/move.js";
import * as nextCmd from "../commands/next.js";
import * as readCmd from "../commands/read.js";
import * as resetCmd from "../commands/reset.js";
import * as searchCmd from "../commands/search.js";
import * as skipCmd from "../commands/skip.js";
import * as takeCmd from "../commands/take.js";
import * as useCmd from "../commands/use.js";
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
  search: searchCmd,
  check: searchCmd,
  take: takeCmd,
  inventory: inventoryCmd,
  read: readCmd,
  drop: dropCmd,
  use: useCmd,
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
    const allowed = new Set(["next", "reset"]);

    if (process.env.CODING_ENV === "DEV") {
      allowed.add("skip");
    }

    // Allow /exit only when the intro flow has fully finished
    let introAtEnd = false;
    if (state.flow?.type === "intro") {
      const introLen = (game.sequences?.intro || []).length;
      introAtEnd = (state.flow?.seq || 0) >= introLen;
      if (introAtEnd) allowed.add("exit");
    }

    if (!isCmd || !allowed.has(cmd)) {
      const msg = introAtEnd
        ? "Intro finished. Type */exit* to begin."
        : game.ui?.templates?.unknownCommandDuringIntro ||
          "Finish the introduction first. Type */next* or */reset*.";
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

  const handler = commands[cmd];
  if (!handler) {
    await sendText(
      jid,
      game.ui?.templates?.unknownCommandGeneric || "Unknown command."
    );
    return;
  }

  await handler.run({ jid, user, game, state, args });
  await saveUser(user, userWrap.path);
  console.log("ENGINE: state saved", {
    seq: state.flow?.seq,
    step: state.flow?.step,
    hdr: state.flow?._headerShown,
  });
}
