// Command registry: normalize → authorize → execute → return declarative effects
// No game-specific logic. Handlers live elsewhere and emit effects only.

import { evaluateRequirements } from "../services/progress.js";

// Default commands used when cartridge.commands is missing or empty
const DEFAULT_COMMANDS = {
  reset: { enabled: true, aliases: ["restart"] },
  exit: { enabled: true, aliases: [] },
  next: { enabled: true, aliases: [] },
  move: { enabled: true, aliases: ["go"] },
  enter: { enabled: true, aliases: [] },
  check: { enabled: true, aliases: [] },
  search: { enabled: true, aliases: [] },
  show: { enabled: true, aliases: ["look"] },
  examine: { enabled: true, aliases: ["investigate", "inspect", "read"] },
  open: { enabled: true, aliases: [] },
  take: { enabled: true, aliases: ["pick", "pickup", "grab"] },
  use: { enabled: true, aliases: [] },
  talkto: { enabled: true, aliases: ["talk"] },
  ask: { enabled: true, aliases: ["question", "askto"] },
  inventory: { enabled: true, aliases: ["inv", "bag"] },
  progress: { enabled: true, aliases: [] },
};

// Internal state
let _commandsCfg = {}; // from cartridge.commands
let _aliases = new Map(); // alias -> cmd
let _handlers = new Map(); // cmd -> async handler(ctx, args)
let _ui = {}; // cartridge.ui.templates

function init(commandsConfig = {}, uiTemplates = {}) {
  const isEmpty = !commandsConfig || Object.keys(commandsConfig).length === 0;
  const merged = isEmpty
    ? { ...DEFAULT_COMMANDS }
    : { ...DEFAULT_COMMANDS, ...commandsConfig };
  _commandsCfg = merged;
  _aliases = new Map();
  _handlers = new Map(_handlers); // keep previously registered handlers if any
  _ui = uiTemplates || {};

  // Build alias index
  for (const [cmd, cfg] of Object.entries(_commandsCfg)) {
    if (!cfg || cfg.enabled === false) continue;
    _aliases.set(cmd, cmd);
    const al = Array.isArray(cfg.aliases) ? cfg.aliases : [];
    for (const a of al) _aliases.set(String(a).toLowerCase(), cmd);
  }
  return { size: _aliases.size };
}

function registerHandler(cmd, fn) {
  if (!cmd || typeof fn !== "function")
    throw new Error("registerHandler(cmd, fn) requires a function");
  _handlers.set(cmd.toLowerCase(), fn);
}

function _normalizeInput(input) {
  if (!input || typeof input !== "string") return { cmd: null, args: [] };
  const t = input.trim();
  const noSlash = t.startsWith("/") ? t.slice(1) : t;
  const parts = noSlash.split(/\s+/);
  const cmdKey = (parts.shift() || "").toLowerCase();
  const args = parts;
  const cmd = _aliases.get(cmdKey) || null;
  return { cmd, args, rawCmd: cmdKey };
}

function resolve(input) {
  return _normalizeInput(input);
}

function _now() {
  return Date.now();
}

function _getCooldown(state, cmd) {
  const cd = state && state.cooldowns && state.cooldowns[cmd];
  return typeof cd === "number" ? cd : 0;
}

function _setCooldown(state, cmd, ms) {
  if (!state) return;
  if (!state.cooldowns) state.cooldowns = {};
  state.cooldowns[cmd] = _now() + ms;
}

function authorize(state, cmd) {
  if (!cmd) return { ok: false, reason: "unknown" };
  const cfg = _commandsCfg[cmd];
  if (!cfg || cfg.enabled === false) return { ok: false, reason: "disabled" };

  // Cooldown check
  const until = _getCooldown(state, cmd);
  if (until && until > _now()) return { ok: false, reason: "cooldown", until };

  // Gates via DSL
  if (cfg.gates && !evaluateRequirements(state, cfg.gates)) {
    return { ok: false, reason: "gated" };
  }
  return { ok: true, cfg };
}

function _tpl(key, vars = {}) {
  const s = _ui && _ui[key];
  if (!s) return "";
  return String(s).replace(/\{\{(\w+)\}\}/g, (_, k) =>
    k in vars ? String(vars[k]) : ""
  );
}

function _msg(key, fallback, vars = {}) {
  const t = _tpl(key, vars);
  return t && t.length ? t : fallback;
}

async function dispatch(ctx, input) {
  const { state } = ctx; // effects layer will render
  const { cmd, args, rawCmd } = _normalizeInput(input);

  if (!cmd) {
    const text = _msg("unknownCommand", `Unknown command: ${rawCmd}`, {
      cmd: rawCmd,
    });
    return { effects: [{ sendText: text }] };
  }

  const auth = authorize(state, cmd);
  if (!auth.ok) {
    if (auth.reason === "disabled") {
      const text = _msg("commandDisabled", `Command '${cmd}' is disabled.`, {
        cmd,
      });
      return { effects: [{ sendText: text }] };
    }
    if (auth.reason === "cooldown") {
      const secs = Math.ceil((auth.until - _now()) / 1000);
      const text = _msg(
        "commandCooldown",
        `Command '${cmd}' is on cooldown for ${secs}s.`,
        { cmd, secs }
      );
      return { effects: [{ sendText: text }] };
    }
    if (auth.reason === "gated") {
      const text = _msg(
        "commandBlocked",
        `You cannot use '${cmd}' right now.`,
        { cmd }
      );
      return { effects: [{ sendText: text }] };
    }
    const text = _msg("unknownCommand", `Unknown command: ${rawCmd}`, {
      cmd: rawCmd,
    });
    return { effects: [{ sendText: text }] };
  }

  const handler = _handlers.get(cmd);
  if (!handler) {
    const text = _msg(
      "commandUnhandled",
      `Command '${cmd}' is not implemented.`,
      { cmd }
    );
    return { effects: [{ sendText: text }] };
  }

  if (auth.cfg && Number.isFinite(auth.cfg.cooldown) && auth.cfg.cooldown > 0) {
    _setCooldown(state, cmd, auth.cfg.cooldown);
  }

  const res = await handler({ ...ctx, cmd, args, config: auth.cfg });
  const effects = Array.isArray(res?.effects)
    ? res.effects
    : Array.isArray(res)
    ? res
    : [];
  return { effects };
}

function getConfig() {
  return _commandsCfg;
}

const api = { init, registerHandler, resolve, authorize, dispatch, getConfig };
export { authorize, dispatch, getConfig, init, registerHandler, resolve };
export default api;
