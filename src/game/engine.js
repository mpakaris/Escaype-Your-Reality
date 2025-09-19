import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import askCmd from "../commands/ask.js";
import * as checkCmd from "../commands/check.js";
import * as dropCmd from "../commands/drop.js";
import * as enterCmd from "../commands/enter.js";
import * as examineCmd from "../commands/examine.js";
import * as exitCmd from "../commands/exit.js";
import * as inventoryCmd from "../commands/inventory.js";
import * as moveCmd from "../commands/move.js";
import * as nextCmd from "../commands/next.js";
import * as openCmd from "../commands/open.js";
import * as progressCmd from "../commands/progress.js";
import * as readCmd from "../commands/read.js";
import * as resetCmd from "../commands/reset.js";
import * as searchCmd from "../commands/search.js";
import * as showCmd from "../commands/show.js";
import * as skipCmd from "../commands/skip.js";
import * as takeCmd from "../commands/take.js";
import * as talktoCmd from "../commands/talkto.js";
import * as useCmd from "../commands/use.js";
import { routeIntent } from "../services/api/openai.js";
import { checkAndAdvanceChapter } from "../services/progress.js";
import { sendText } from "../services/whinself.js";
import { inSequence } from "./flow.js";

import registry from "../commands/registry.js";
import { applyEffects } from "../services/effects.js";

import { mountCapabilities } from "../services/capabilities.js";

import cartridgeLoader from "../services/cartridgeLoader.js";
const { loadCartridgeFromDir } = cartridgeLoader;

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
  // Use cartridge loader + schema validation
  const cart = loadCartridgeFromDir(gameDir);

  // Map to legacy engine surface to avoid downstream changes
  const sequences = {
    intro: Array.isArray(cart.intro) ? cart.intro : [],
    tutorial: Array.isArray(cart.tutorial) ? cart.tutorial : [],
  };

  const game = {
    id: gameUUID,
    title: cart.meta?.title || cart.title || "",
    ui: cart.ui || {},
    progression: cart.progression || {},
    media: cart.media || {},
    capabilities: cart.capabilities || {},
    sequences,
    locations:
      cart.world && Array.isArray(cart.world.locations)
        ? cart.world.locations
        : [],
    commands: cart.commands || {},
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
  talkto: talktoCmd,
  open: openCmd,
  search: searchCmd,
  examine: examineCmd,
  ask: { run: askCmd },
};

function getRun(mod) {
  if (!mod) return null;
  if (typeof mod === "function") return mod; // default export imported directly
  if (typeof mod?.run === "function") return mod.run; // named run
  if (typeof mod?.default === "function") return mod.default; // default on namespace import
  return null;
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
  // First try id-filtered read; if empty, fall back to all-by-game and filter in-memory
  let objectRows = await readMany(
    tryPaths([
      "object.jsonl",
      "objects.jsonl",
      "object.json",
      "objects.json",
      "object_catalogue.jsonl",
      "objects_catalogue.jsonl",
      "object_catalogue.json",
      "objects_catalogue.json",
    ]),
    (r) => byGameAny(r) && objIds.has(rowId(r))
  );
  if (!objectRows.length && objIds.size) {
    const allObjRows = await readMany(
      tryPaths([
        "object.jsonl",
        "objects.jsonl",
        "object.json",
        "objects.json",
        "object_catalogue.jsonl",
        "objects_catalogue.jsonl",
        "object_catalogue.json",
        "objects_catalogue.json",
      ]),
      byGameAny
    );
    objectRows = allObjRows.filter((r) => objIds.has(rowId(r)));
  }
  const objects = objectRows.map(unwrap);
  // Deduplicate by id for objects and npcs as well
  const objectsById = {};
  for (const o of objects) if (o && o.id) objectsById[o.id] = o;
  const objectsDedup = Object.values(objectsById);

  // Include items contained in the loaded objects as candidates
  // This enables commands like /take to resolve items revealed by /search or open containers
  for (const o of objectsDedup) {
    if (o && Array.isArray(o.contents)) {
      for (const itId of o.contents) {
        if (itId) itemIds.add(String(itId));
      }
    }
  }

  // Merge and dedupe npcs from per-game and root, singular/plural, include .json variants
  const npcRows = await readMany(
    tryPaths([
      "npc.jsonl",
      "npcs.jsonl",
      "npc.json",
      "npcs.json",
      "npcs_catalogue.jsonl",
      "npc_catalogue.jsonl",
      "npcs_catalogue.json",
      "npc_catalogue.json",
    ]),
    (r) => byGameAny(r) && npcIds.has(rowId(r))
  );
  const npcs = npcRows.map(unwrap);

  // Items catalogue filename can be singular or plural and may live per-game or at root, include .json variants
  const itemRows = await readMany(
    tryPaths([
      "item.jsonl",
      "items.jsonl",
      "item.json",
      "items.json",
      "items_catalogue.jsonl",
      "item_catalogue.jsonl",
      "items_catalogue.json",
      "item_catalogue.json",
    ]),
    (r) => byGameAny(r) && itemIds.has(rowId(r))
  );
  const itemsMerged = itemRows.map(unwrap);
  const items = Object.values(
    itemsMerged.reduce((acc, it) => {
      if (it && it.id && !acc[it.id]) acc[it.id] = it;
      return acc;
    }, {})
  );

  const npcsById = {};
  for (const n of npcs) if (n && n.id) npcsById[n.id] = n;
  const npcsDedup = Object.values(npcsById);

  if (process.env.CODING_ENV === "DEV") {
    console.debug("[loadCandidatesLimited] loaded", {
      objects: objects.length,
      items: items.length,
      npcs: npcsDedup.length,
    });
  }
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
    // Log full error for diagnostics in DEV/PROD
    try {
      console.error("[engine] loadGame failed:", err?.message || err);
      if (err?.details)
        console.error("[engine] validation details:", err.details);
      if (err?.stack) console.error(err.stack);
    } catch {}
    await sendText(jid, "Game content missing. Please try again later.");
    return;
  }

  // Initialize command registry for this request
  registry.init(game.commands || {}, game.ui?.templates || game.ui || {});
  // Register existing command handlers to keep behavior unchanged
  const builtIns = {
    next: nextCmd,
    reset: resetCmd,
    exit: exitCmd,
    skip: skipCmd,
    move: moveCmd,
    enter: enterCmd,
    show: showCmd,
    check: checkCmd,
    progress: progressCmd,
    take: takeCmd,
    inventory: inventoryCmd,
    read: readCmd,
    drop: dropCmd,
    use: useCmd,
    talkto: talktoCmd,
    open: openCmd,
    search: searchCmd,
    examine: examineCmd,
    ask: { run: askCmd },
  };
  for (const [k, mod] of Object.entries(builtIns)) {
    const fn = getRun(mod) || ((ctx) => Promise.resolve());
    registry.registerHandler(k, async (ctx) => {
      await fn(ctx);
      return { effects: [] };
    });
  }

  const state =
    (user.currentState && user.currentState[gameUUID]) ||
    (user.currentState[gameUUID] = {});
  // Ensure command event log exists
  if (!Array.isArray(state.log)) state.log = [];
  // Mount capabilities from cartridge onto state
  try {
    mountCapabilities(state, game);
  } catch {}

  // In DEV, force intro/tutorial skipped to avoid sequence gating during development
  if (process?.env?.CODING_ENV === "DEV") {
    state.flags = state.flags || {};
    state.flags.introDone = true;
    state.flags.tutorialDone = true;
    state.introActive = false;
    if (state.flow && typeof state.flow === "object") state.flow.active = false;
  }

  // --- Registry-based command parsing and gating ---
  const input = (text || "").trim();
  let isCmd = input.startsWith("/");
  let cmd = "";
  let args = [];
  let intentContext = null;
  if (isCmd) {
    const resolved = registry.resolve(input);
    cmd = resolved.cmd;
    args = resolved.args;
  } else {
    // Not a slash command: try intent routing
    const intent = await routeIntent({ text: input, game, state });
    if (intent && typeof intent === "object" && intent.command) {
      // Check if intent.command matches a built-in or registry handler
      const allCmds = new Set([
        ...Object.keys(registry.handlers || {}),
        ...Object.keys(commands),
      ]);
      if (allCmds.has(intent.command)) {
        cmd = intent.command;
        args = Array.isArray(intent.args) ? intent.args : [];
        isCmd = true;
        // Attach for debugging
        intentContext = {
          confidence: intent.confidence,
          target: intent.target,
          originalInput: input,
        };
      } else {
        // Unknown intent command; treat as unknown
        cmd = "";
        args = [];
      }
    } else if (intent === "unknown") {
      // Fallback: unknown intent
      const msg =
        game.ui?.templates?.unknownCommandGeneric || "Unknown command.";
      await sendText(jid, msg);
      return;
    }
  }

  if (inSequence(state)) {
    const allowed = new Set(["next", "reset", "exit", "progress"]);
    if (process.env.CODING_ENV === "DEV") allowed.add("skip");
    if (!isCmd || !allowed.has(cmd)) {
      const msg =
        game.ui?.templates?.unknownCommandDuringIntro ||
        "Finish the introduction first. Type */next*, */exit*, or */reset*.";
      await sendText(jid, msg);
      return;
    }
  } else {
    if (isCmd && !cmd) {
      const msg =
        game.ui?.templates?.unknownCommandGeneric || "Unknown command.";
      await sendText(jid, msg);
      return;
    }
  }

  // Always honor reset/exit immediately to avoid being blocked by any gating
  if (isCmd && (cmd === "reset" || cmd === "exit")) {
    const handler = builtIns[cmd];
    const run = getRun(handler);
    if (run) {
      await run({ jid, user, game, state, args, candidates: null });
      // Log command event
      state.log.push({
        t: Date.now(),
        cmd,
        args,
        location: state.location || null,
        inStructure: !!state.inStructure,
        structureId: state.structureId || null,
      });
      if (state.log.length > 1000) state.log = state.log.slice(-1000);
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

  // Candidate loading using resolved cmd (logic unchanged, but after sequence gating)
  const needsCatalog = new Set([
    "show",
    "check",
    "open",
    "search",
    "take",
    "read",
    "drop",
    "use",
    "talkto",
    "present",
    "examine",
    "ask",
  ]);
  if (needsCatalog.has(cmd)) {
    // Collect only the ids present in the current room for targeted preloading
    if (state.inStructure && state.structureId) {
      ensureRoomInStructure(game, state);
    }
    const ids = collectCandidateIds(game, state);
    // Ensure catalogue rows exist for inventory and revealed items when examining or using
    if (cmd === "examine" || cmd === "use") {
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

  // --- Dispatch via registry, apply effects ---
  const ctx = {
    jid,
    user,
    game,
    state,
    args,
    candidates: game.candidates || null,
  };
  // Attach intent routing info to ctx for debugging if present
  if (intentContext) {
    ctx.intent = intentContext;
  }
  // Dispatch via registry. Handlers call the legacy modules. Registry may also return effects (e.g., gating messages).
  const dispatchRes = isCmd
    ? await registry.dispatch(ctx, input)
    : { effects: [] };
  if (
    dispatchRes &&
    Array.isArray(dispatchRes.effects) &&
    dispatchRes.effects.length
  ) {
    await applyEffects({ jid, user, game, state }, dispatchRes.effects);
  }

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
  // Log command event
  state.log.push({
    t: Date.now(),
    cmd,
    args,
    location: state.location || null,
    inStructure: !!state.inStructure,
    structureId: state.structureId || null,
    ...(intentContext ? { intent: intentContext } : {}),
  });
  if (state.log.length > 1000) state.log = state.log.slice(-1000);
  await checkAndAdvanceChapter({ jid, game, state });
  await saveUser(user, userWrap.path, userWrap._stateRowKey);
}
