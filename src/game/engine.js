import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as checkCmd from "../commands/check.js";
import * as dropCmd from "../commands/drop.js";
import * as enterCmd from "../commands/enter.js";
import * as examineCmd from "../commands/examine.js";
import * as exitCmd from "../commands/exit.js";
import * as inventoryCmd from "../commands/inventory.js";
import * as moveCmd from "../commands/move.js";
import * as nextCmd from "../commands/next.js";
import * as openCmd from "../commands/open.js";
import * as readCmd from "../commands/read.js";
import * as resetCmd from "../commands/reset.js";
import * as searchCmd from "../commands/search.js";
import * as showCmd from "../commands/show.js";
import * as skipCmd from "../commands/skip.js";
import * as takeCmd from "../commands/take.js";
import * as talkCmd from "../commands/talk.js";
import * as useCmd from "../commands/use.js";
import { checkAndAdvanceChapter } from "../services/progress.js";
import { sendText } from "../services/whinself.js";
import { inSequence } from "./flow.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");

async function readJSONL(filePath) {
  try {
    let raw = await fs.readFile(filePath, "utf-8");
    if (!raw) {
      return [];
    }
    // strip BOM
    raw = raw.replace(/^\uFEFF/, "");
    const trimmed = raw.trim();

    // Fallback: allow full JSON array files for convenience
    if (trimmed.startsWith("[")) {
      try {
        const arr = JSON.parse(trimmed);
        return Array.isArray(arr) ? arr : [];
      } catch (e) {
        throw e;
      }
    }

    // JSONL path
    const lines = raw.split(/\r?\n/);
    const rows = [];
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
      if (!line) continue; // blank
      line = line.trim();
      if (!line) continue;
      if (line.startsWith("//") || line.startsWith("#")) continue; // allow comments
      try {
        rows.push(JSON.parse(line));
      } catch (e) {
        // hard fail to surface data issue
        throw e;
      }
    }
    return rows;
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

async function writeJSONL(filePath, rows) {
  const txt = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await fs.writeFile(filePath, txt, "utf-8");
}

async function loadUser(userId) {
  const usersPath = path.resolve(ROOT, "src", "db", "users.jsonl");
  const statesPath = path.resolve(ROOT, "src", "db", "user_states.jsonl");
  const users = await readJSONL(usersPath);
  const userRow = users.find((u) => String(u.userId) === String(userId));
  if (!userRow) {
    throw new Error("user-not-found");
  }

  const states = await readJSONL(statesPath);
  // Prefer active game state; fallback to first by this user
  const activeGame = userRow.activeGame;
  const stateRow =
    states.find(
      (s) =>
        String(s.userId || s.phone) === String(userId) &&
        (!activeGame || s.currentGameUuid === activeGame)
    ) || states.find((s) => String(s.userId || s.phone) === String(userId));

  const gameUUID = stateRow?.currentGameUuid || activeGame;
  const state = stateRow?.currentState?.[gameUUID] || {};

  // Normalize to legacy shape the engine expects
  const legacyUser = {
    userId: String(userId),
    currentGameUuid: gameUUID,
    currentState: { [gameUUID]: state },
  };

  return {
    data: legacyUser,
    path: statesPath,
    _usersPath: usersPath,
    _stateRowKey: { userId: String(userId), gameUUID },
  };
}

async function saveUser(userObj, statesFilePath, key) {
  const rows = await readJSONL(statesFilePath);
  const { userId } = userObj;
  const gameUUID = userObj.currentGameUuid;
  // Find existing row for this user+game; if none, append new
  let idx = rows.findIndex(
    (r) =>
      String(r.userId || r.phone) === String(userId) &&
      r.currentGameUuid === gameUUID
  );
  const statePayload = userObj.currentState?.[gameUUID] || {};
  const newRow = {
    userId: String(userId),
    currentGameUuid: gameUUID,
    currentState: { [gameUUID]: statePayload },
  };
  if (idx === -1) rows.push(newRow);
  else rows[idx] = newRow;
  await writeJSONL(statesFilePath, rows);
}

async function loadGame(gameUUID) {
  const gameDir = path.resolve(ROOT, "src", "db", "games", gameUUID);
  // general
  const generalPath = path.resolve(gameDir, "general_object.jsonl");
  const generalRows = await readJSONL(generalPath);
  const general =
    generalRows.find((r) => r.gameId === gameUUID) || generalRows[0] || {};

  // sequences
  const sequences = {};
  try {
    const introRows = await readJSONL(path.resolve(gameDir, "intro.jsonl"));
    const introRow =
      introRows.find((r) => r.gameId === gameUUID) || introRows[0];
    if (introRow?.data) sequences.intro = introRow.data;
  } catch {}
  try {
    const tutorialRows = await readJSONL(
      path.resolve(gameDir, "tutorial.jsonl")
    );
    const tutorialRow =
      tutorialRows.find((r) => r.gameId === gameUUID) || tutorialRows[0];
    if (tutorialRow?.data) sequences.tutorial = tutorialRow.data;
  } catch {}

  // locations (JSONL table, no fallback)
  const locationsPath = path.resolve(gameDir, "locations.jsonl");
  const locationRows = await readJSONL(locationsPath);
  const locations = (locationRows || [])
    .filter((r) => String(r.gameId) === String(gameUUID))
    .map((r) => {
      // Rows may already be in location shape. If a `data` wrapper exists, unwrap it.
      if (r && r.data && typeof r.data === "object") return r.data;
      const { gameId, ...rest } = r || {};
      return rest;
    });

  // Compose legacy game object the engine expects
  const game = {
    id: gameUUID,
    title: general.title || "",
    ui: general.ui || {},
    progression: general.progression || {},
    media: general.media || {},
    sequences,
    locations,
  };
  return game;
}

const commands = {
  next: nextCmd,
  reset: resetCmd,
  exit: exitCmd,
  skip: skipCmd,
  move: moveCmd,
  enter: enterCmd,
  show: showCmd,
  check: checkCmd,
  take: takeCmd,
  inventory: inventoryCmd,
  read: readCmd,
  drop: dropCmd,
  use: useCmd,
  talk: talkCmd,
  open: openCmd,
  search: searchCmd,
  examine: examineCmd,
};

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

function getCurrentRoom(game, state) {
  const struct = getCurrentStructure(game, state);
  if (!struct || !Array.isArray(struct.rooms) || struct.rooms.length === 0)
    return null;
  const roomId = state.roomId || "main";
  return struct.rooms.find((r) => r.id === roomId) || struct.rooms[0] || null;
}

function dedupe(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}

function collectCandidateIds(game, state) {
  const room = getCurrentRoom(game, state);
  const objectIds = dedupe(room?.objects || []);
  const npcIds = dedupe(room?.npcs || []);
  // Items in plain sight (not inside objects) live on the room as `items` if present
  const itemIds = dedupe(room?.items || []);
  return { objectIds, npcIds, itemIds };
}

async function readJSONLFiltered(filePath, predicate) {
  let raw = await fs.readFile(filePath, "utf-8").catch((e) => {
    if (e && e.code === "ENOENT") return "";
    throw e;
  });
  if (!raw) return [];
  raw = raw.replace(/^\uFEFF/, "");
  const trimmed = raw.trim();

  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed);
      return (Array.isArray(arr) ? arr : []).filter(predicate);
    } catch {
      return [];
    }
  }

  const out = [];
  const lines = raw.split(/\r?\n/);
  for (let line of lines) {
    line = (line || "").trim();
    if (!line || line.startsWith("//") || line.startsWith("#")) continue;
    try {
      const row = JSON.parse(line);
      if (predicate(row)) out.push(row);
    } catch {
      // skip bad line
    }
  }
  return out;
}

function indexById(rows) {
  const idx = Object.create(null);
  for (const r of rows || []) {
    if (r?.id) idx[r.id] = r;
  }
  return idx;
}

async function loadCandidatesLimited(gameUUID, ids) {
  const dbDir = path.resolve(ROOT, "src", "db");
  const gameDir = path.resolve(ROOT, "src", "db", "games", gameUUID);
  const byGame = (r) => String(r.gameId) === String(gameUUID);

  const objIds = new Set(ids.objectIds || []);
  const npcIds = new Set(ids.npcIds || []);
  const itemIds = new Set(ids.itemIds || []);

  // Helpers to robustly read id/gameId from row or row.data
  const rowGameId = (r) => String(r?.gameId ?? r?.data?.gameId ?? "");
  const rowId = (r) => String(r?.id ?? r?.data?.id ?? "");
  const byGameAny = (r) => rowGameId(r) === String(gameUUID);

  function unwrap(row) {
    if (!row) return null;
    if (row.data && typeof row.data === "object") return row.data;
    return row;
  }

  const tryPaths = (names) =>
    names.map((n) => [path.resolve(gameDir, n), path.resolve(dbDir, n)]).flat();
  const readMany = async (paths, predicate) => {
    const acc = [];
    for (const p of paths) {
      try {
        const rows = await readJSONLFiltered(p, predicate);
        if (rows && rows.length) acc.push(...rows);
      } catch {}
    }
    return acc;
  };

  // Merge and dedupe objects from per-game and root
  const objectRows = await readMany(
    tryPaths(["object_catalogue.jsonl"]),
    (r) => byGameAny(r) && objIds.has(rowId(r))
  );
  const objects = objectRows.map(unwrap);

  // Merge and dedupe npcs from per-game and root, singular/plural
  const npcRows = await readMany(
    tryPaths(["npcs_catalogue.jsonl", "npc_catalogue.jsonl"]),
    (r) => byGameAny(r) && npcIds.has(rowId(r))
  );
  const npcs = npcRows.map(unwrap);

  // Items catalogue filename can be singular or plural and may live per-game or at root
  const itemRows = await readMany(
    tryPaths(["items_catalogue.jsonl", "item_catalogue.jsonl"]),
    (r) => byGameAny(r) && itemIds.has(rowId(r))
  );
  const itemsMerged = itemRows.map(unwrap);
  const items = Object.values(
    itemsMerged.reduce((acc, it) => {
      if (it && it.id && !acc[it.id]) acc[it.id] = it;
      return acc;
    }, {})
  );

  // Deduplicate by id for objects and npcs as well
  const objectsById = {};
  for (const o of objects) if (o && o.id) objectsById[o.id] = o;
  const objectsDedup = Object.values(objectsById);

  const npcsById = {};
  for (const n of npcs) if (n && n.id) npcsById[n.id] = n;
  const npcsDedup = Object.values(npcsById);

  return {
    objects: objectsDedup,
    items,
    npcs: npcsDedup,
    objectIndex: indexById(objectsDedup),
    itemIndex: indexById(items),
    npcIndex: indexById(npcsDedup),
  };
}
export async function handleIncoming({ jid, from, text }) {
  if (!jid) return;
  const userId = jid.replace(/@s\.whatsapp\.net$/, "");
  let userWrap;
  try {
    userWrap = await loadUser(userId);
  } catch (err) {
    await sendText(jid, "Player not found. Use /start to begin.");
    return;
  }
  const user = userWrap.data;
  const gameUUID = user.currentGameUuid;
  if (!gameUUID) return;
  let game;
  try {
    game = await loadGame(gameUUID);
  } catch (err) {
    await sendText(jid, "Game content missing. Please try again later.");
    return;
  }
  const state =
    (user.currentState && user.currentState[gameUUID]) ||
    (user.currentState[gameUUID] = {});

  const input = (text || "").trim();
  const isCmd = input.startsWith("/");
  const parts = isCmd ? input.slice(1).split(/\s+/) : [];
  const cmd = parts[0]?.toLowerCase() || "";
  const args = parts.slice(1);

  const needsCatalog = new Set([
    "show",
    "check",
    "open",
    "search",
    "take",
    "read",
    "drop",
    "use",
    "talk",
    "present",
    "examine",
  ]);

  if (inSequence(state)) {
    const allowed = new Set(["next", "reset", "exit"]);
    if (process.env.CODING_ENV === "DEV") {
      allowed.add("skip");
    }

    const introLen = (game.sequences?.intro || []).length;
    const atSeq = state.flow?.seq ?? 0;
    const atStep = state.flow?.step ?? 0;

    if (!isCmd || !allowed.has(cmd)) {
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
      await handler.run({ jid, user, game, state, args, candidates: null });
      // Normalize room after command side-effects
      if (state.inStructure && state.structureId) {
        try {
          ensureRoomInStructure(game, state);
        } catch {}
      } else {
        if (state.roomId) state.roomId = null;
      }
      await checkAndAdvanceChapter({ jid, game, state });
      await saveUser(user, userWrap.path, userWrap._stateRowKey);
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

  if (needsCatalog.has(cmd)) {
    // Collect only the ids present in the current room for targeted preloading
    if (state.inStructure && state.structureId) {
      ensureRoomInStructure(game, state);
    }
    const ids = collectCandidateIds(game, state);
    // Ensure catalogue rows exist for inventory and revealed items when examining
    if (cmd === "examine") {
      const inv = Array.isArray(state.inventory) ? state.inventory : [];
      const rev = Array.isArray(state.revealedItems) ? state.revealedItems : [];
      if (inv.length || rev.length) {
        const merged = new Set([...(ids.itemIds || []), ...inv, ...rev]);
        ids.itemIds = Array.from(merged);
      }
    }
    const cats = await loadCandidatesLimited(gameUUID, ids);
    if (process.env.CODING_ENV === "DEV") {
      console.debug("[candidates] room ids", ids);
      console.debug("[candidates] loaded counts", {
        objects: cats.objects?.length,
        items: cats.items?.length,
        npcs: cats.npcs?.length,
      });
    }
    // Attach narrow candidates for commands to fuzzy-match and resolve
    const candidates = {
      objects: cats.objects,
      items: cats.items,
      npcs: cats.npcs,
      objectIndex: cats.objectIndex,
      itemIndex: cats.itemIndex,
      npcIndex: cats.npcIndex,
    };
    // Stash on game for backward compat, and pass along via context
    game.candidates = candidates;
  }

  const ctx = {
    jid,
    user,
    game,
    state,
    args,
    candidates: game.candidates || null,
  };
  await handler.run(ctx);
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
  await saveUser(user, userWrap.path, userWrap._stateRowKey);
}
