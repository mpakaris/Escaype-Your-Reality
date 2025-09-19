// src/test/headlessRunner.js
// Headless test runner: feeds commands to the engine stack without WhatsApp.

import path from "path";
import fs from "fs";
import url from "url";

// Core engine pieces
import { applyEffects } from "../services/effects.js";
import { checkAndAdvanceChapter } from "../services/progress.js";
import registry from "../commands/registry.js";
import { loadCartridgeFromDir } from "../services/cartridgeLoader.js";

// Command modules (register as built-ins)
import * as askCmd from "../commands/ask.js";
import * as talktoCmd from "../commands/talkto.js";
import * as openCmd from "../commands/open.js";
import * as takeCmd from "../commands/take.js";
import * as useCmd from "../commands/use.js";
import * as enterCmd from "../commands/enter.js";
import * as moveCmd from "../commands/move.js";
import * as examineCmd from "../commands/examine.js";
import * as showCmd from "../commands/show.js";
import * as inventoryCmd from "../commands/inventory.js";
import * as progressCmd from "../commands/progress.js";

// Minimal no-op transport so command modules can call senders safely
// If your whinself.js supports HEADLESS mode, set it here as well
globalThis.__HEADLESS__ = true;

function makeGameFromCartridge(gameUUID) {
  const ROOT = path.resolve(
    path.dirname(url.fileURLToPath(import.meta.url)),
    "..",
    ".."
  );
  const gameDir = path.join(ROOT, "db", "games", gameUUID);
  const cart = loadCartridgeFromDir(gameDir);
  const sequences = {
    intro: Array.isArray(cart.intro) ? cart.intro : [],
    tutorial: Array.isArray(cart.tutorial) ? cart.tutorial : [],
  };
  return {
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
}

function initState() {
  return {
    flags: [],
    counters: {},
    inventory: [],
    location: undefined,
    inStructure: false,
    structureId: undefined,
    roomId: undefined,
    chapter: 1,
    log: [],
  };
}

function registerBuiltIns() {
  const builtIns = {
    ask: { run: askCmd.run || askCmd.default },
    talkto: { run: talktoCmd.run || talktoCmd.default },
    open: { run: openCmd.run || openCmd.default },
    take: { run: takeCmd.run || takeCmd.default },
    use: { run: useCmd.run || useCmd.default },
    enter: { run: enterCmd.run || enterCmd.default },
    move: { run: moveCmd.run || moveCmd.default },
    examine: { run: examineCmd.run || examineCmd.default },
    show: { run: showCmd.run || showCmd.default },
    inventory: { run: inventoryCmd.run || inventoryCmd.default },
    progress: { run: progressCmd.run || progressCmd.default },
  };
  for (const [k, mod] of Object.entries(builtIns)) {
    const fn = typeof mod?.run === "function" ? mod.run : async () => {};
    registry.registerHandler(k, async (ctx) => {
      await fn(ctx);
      return { effects: [] };
    });
  }
}

async function stepOnce({ ctx, input }) {
  const dispatchRes = await registry.dispatch(ctx, input);
  if (dispatchRes?.effects?.length) {
    await applyEffects(ctx, dispatchRes.effects);
  }
  // Progression check after each input
  await checkAndAdvanceChapter(ctx);
}

function hasAll(arr, elems) {
  return elems.every((e) => arr.includes(e));
}

function notAny(arr, elems) {
  return elems.every((e) => !arr.includes(e));
}

function assertState(state, expect) {
  const failures = [];
  if (!expect) return failures;

  if (
    expect.chapterIs !== undefined &&
    Number(state.chapter) !== Number(expect.chapterIs)
  ) {
    failures.push(`chapterIs=${expect.chapterIs} but was ${state.chapter}`);
  }
  if (expect.flagsHas && !hasAll(state.flags || [], expect.flagsHas)) {
    failures.push(
      `flagsHas missing: ${expect.flagsHas
        .filter((f) => !(state.flags || []).includes(f))
        .join(", ")}`
    );
  }
  if (expect.flagsNot && !notAny(state.flags || [], expect.flagsNot)) {
    failures.push(
      `flagsNot present: ${expect.flagsNot
        .filter((f) => (state.flags || []).includes(f))
        .join(", ")}`
    );
  }
  if (
    expect.inventoryHas &&
    !hasAll(state.inventory || [], expect.inventoryHas)
  ) {
    failures.push(
      `inventoryHas missing: ${expect.inventoryHas
        .filter((f) => !(state.inventory || []).includes(f))
        .join(", ")}`
    );
  }
  if (
    expect.inventoryNot &&
    !notAny(state.inventory || [], expect.inventoryNot)
  ) {
    failures.push(
      `inventoryNot present: ${expect.inventoryNot
        .filter((f) => (state.inventory || []).includes(f))
        .join(", ")}`
    );
  }
  if (expect.countersAtLeast) {
    for (const [k, v] of Object.entries(expect.countersAtLeast)) {
      const cur = Number(state.counters?.[k] || 0);
      if (cur < Number(v)) failures.push(`counter '${k}' < ${v} (was ${cur})`);
    }
  }
  if (expect.locationIs && state.location !== expect.locationIs) {
    failures.push(`locationIs=${expect.locationIs} but was ${state.location}`);
  }
  return failures;
}

export async function runScript({ gameId, steps, collectOutputs = false }) {
  const game = makeGameFromCartridge(gameId);
  const state = initState();
  const jid = "test@headless";
  const user = { id: "test-user" };

  registry.init(game.commands || {}, game.ui?.templates || game.ui || {});
  registerBuiltIns();

  const ctx = { jid, user, game, state };
  const results = [];
  let passed = true;

  for (let i = 0; i < steps.length; i += 1) {
    const s = steps[i];
    const input = s.input || "";
    try {
      await stepOnce({ ctx, input });
      const fails = assertState(state, s.expect);
      const ok = fails.length === 0;
      results.push({ i: i + 1, input, ok, fails });
      if (!ok) passed = false;
    } catch (e) {
      passed = false;
      results.push({
        i: i + 1,
        input,
        ok: false,
        error: e?.message || String(e),
      });
    }
  }

  return { passed, results, state };
}

// CLI usage: node src/test/headlessRunner.js --game 1000 --script scripts/happy_path.json
if (import.meta.url === url.pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const get = (k, def) => {
    const ix = args.indexOf(`--${k}`);
    return ix >= 0 ? args[ix + 1] : def;
  };
  const gameId = get("game", "1000");
  const scriptPath = get("script", null);
  if (!scriptPath) {
    console.error(
      "Usage: node src/test/headlessRunner.js --game <id> --script <path.json>"
    );
    process.exit(2);
  }
  const raw = fs.readFileSync(scriptPath, "utf8");
  const steps = JSON.parse(raw);
  runScript({ gameId, steps })
    .then(({ passed, results }) => {
      for (const r of results) {
        if (r.ok) console.log(`✅  [${r.i}] ${r.input}`);
        else if (r.error)
          console.log(`❌  [${r.i}] ${r.input} — ERROR: ${r.error}`);
        else console.log(`❌  [${r.i}] ${r.input} — ${r.fails.join("; ")}`);
      }
      process.exit(passed ? 0 : 1);
    })
    .catch((e) => {
      console.error("Runner failure:", e);
      process.exit(1);
    });
}
