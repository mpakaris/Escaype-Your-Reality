import { sendText } from "../services/whinself.js";
import { fuzzyMatch } from "../utils/fuzzyMatch.js";

function getCurrentLocation(game, state) {
  return (game.locations || []).find((l) => l.id === state.location) || null;
}
function getCurrentStructure(loc, state) {
  if (!loc) return null;
  return (loc.structures || []).find((s) => s.id === state.structureId) || null;
}
function getCurrentRoom(structure, state) {
  if (!structure) return null;
  return (structure.rooms || []).find((r) => r.id === state.roomId) || null;
}

// Evaluate generic conditions (flags, !flags, hasItem)
function condOk(conds, state) {
  if (!Array.isArray(conds) || !conds.length) return true;
  const flags = state.flags || {};
  const hasItem = (id) =>
    Array.isArray(state.inventory) && state.inventory.includes(id);
  for (const c of conds) {
    if (typeof c !== "string") return false;
    if (c.startsWith("flag:")) {
      const k = c.slice(5);
      if (!flags[k]) return false;
      continue;
    }
    if (c.startsWith("!flag:")) {
      const k = c.slice(6);
      if (flags[k]) return false;
      continue;
    }
    if (c.startsWith("hasItem:")) {
      const k = c.slice(8);
      if (!hasItem(k)) return false;
      continue;
    }
  }
  return true;
}

function normalizeFuzzyResult(res) {
  if (!res) return null;
  if (typeof res === "string") return res;
  if (Array.isArray(res)) {
    const first = res[0];
    if (!first) return null;
    if (typeof first === "string") return first;
    if (typeof first === "object")
      return first.value || first.item || first.label || null;
    return null;
  }
  if (typeof res === "object")
    return res.value || res.item || res.label || null;
  return null;
}

export async function run({ jid, user, game, state, args }) {
  if (!state.inStructure || !state.structureId) {
    await sendText(jid, "You are not inside a building. Use /enter first.");
    return;
  }

  const loc = getCurrentLocation(game, state);
  const structure = getCurrentStructure(loc, state);
  const room = getCurrentRoom(structure, state);
  if (!structure || !room) {
    await sendText(jid, "No one to talk to here.");
    return;
  }

  // Resolve visible NPCs in THIS room only (room.npcs can be ["id", { id, visibleWhen }])
  const entries = Array.isArray(room.npcs) ? room.npcs : [];
  const visibleIds = entries
    .map((e) => (typeof e === "string" ? { id: e } : e))
    .filter((e) => e && e.id && condOk(e.visibleWhen, state))
    .map((e) => e.id);
  const visibleNpcs = (game.npcs || []).filter((n) =>
    visibleIds.includes(n.id)
  );

  if (!visibleNpcs.length) {
    await sendText(jid, "No one here seems willing to talk.");
    return;
  }

  const targetRaw = (args && args.join(" "))?.trim() || "";
  let targetNpc = null;

  if (!targetRaw) {
    if (visibleNpcs.length === 1) {
      targetNpc = visibleNpcs[0];
    } else {
      const names = visibleNpcs.map((n) => n.displayName || n.name || n.id);
      await sendText(
        jid,
        `Talk to who?\n\n${names.map((n) => `- ${n}`).join("\n")}`
      );
      return;
    }
  }

  if (!targetNpc && targetRaw) {
    const options = visibleNpcs.map((n) => n.displayName || n.name || n.id);
    const hitRaw = fuzzyMatch(targetRaw, options, {
      threshold: 0.45,
      maxResults: 1,
    });
    const hit = normalizeFuzzyResult(hitRaw);
    if (typeof hit === "string" && hit.length) {
      const hitLc = hit.toLowerCase();
      targetNpc = visibleNpcs.find(
        (n) => (n.displayName || n.name || n.id).toLowerCase() === hitLc
      );
    }
    if (!targetNpc) {
      const ids = visibleNpcs.map((n) => n.id);
      const idHitRaw = fuzzyMatch(targetRaw, ids, {
        threshold: 0.45,
        maxResults: 1,
      });
      const idHit = normalizeFuzzyResult(idHitRaw) || "";
      const idLc = typeof idHit === "string" ? idHit.toLowerCase() : "";
      targetNpc = visibleNpcs.find((n) => n.id.toLowerCase() === idLc);
    }
    if (!targetNpc) {
      const q = targetRaw.toLowerCase();
      targetNpc = visibleNpcs.find((n) =>
        (n.displayName || n.name || n.id).toLowerCase().includes(q)
      );
    }
  }

  if (!targetNpc) {
    const names = visibleNpcs.map((n) => n.displayName || n.name || n.id);
    await sendText(
      jid,
      `I don't see them here.\n\nHere you can talk to:\n\n${names
        .map((n) => `- ${n}`)
        .join("\n")}`
    );
    return;
  }

  const chapter = state.chapter || 0;
  const dialogues = Array.isArray(targetNpc.dialogues)
    ? targetNpc.dialogues
    : [];
  const candidates = dialogues.filter(
    (d) => d && (d.chapter === chapter || d.chapter == null)
  );
  let chosen = candidates.find((d) => condOk(d.conditions, state));
  if (!chosen) chosen = dialogues.find((d) => d.chapter == null) || null;

  if (!chosen) {
    await sendText(
      jid,
      `${
        targetNpc.displayName || targetNpc.name || "They"
      } has nothing new right now.`
    );
    return;
  }

  for (const ln of Array.isArray(chosen.lines) ? chosen.lines : []) {
    if (typeof ln === "string" && ln.trim()) await sendText(jid, ln);
  }

  // effects or effect
  const eff = Array.isArray(chosen.effects)
    ? chosen.effects
    : Array.isArray(chosen.effect)
    ? chosen.effect
    : typeof chosen.effect === "string"
    ? [chosen.effect]
    : [];
  // apply effects may grant items or set flags
  if (eff.length) {
    // inline minimal effect application (flags + grant items)
    state.flags =
      state.flags && typeof state.flags === "object" ? state.flags : {};
    state.inventory = Array.isArray(state.inventory) ? state.inventory : [];
    for (const e of eff) {
      if (typeof e !== "string") continue;
      if (e.startsWith("flag:")) {
        const k = e.slice(5);
        if (k) state.flags[k] = true;
        continue;
      }
      if (e.startsWith("!flag:")) {
        const k = e.slice(6);
        if (k) state.flags[k] = false;
        continue;
      }
      if (e.startsWith("get:") || e.startsWith("give:")) {
        const itemId = e.split(":")[1]?.trim();
        if (itemId && !state.inventory.includes(itemId))
          state.inventory.push(itemId);
      }
      if (e.startsWith("lose:") || e.startsWith("remove:")) {
        const itemId = e.split(":")[1]?.trim();
        if (!itemId) continue;
        const idx = state.inventory.indexOf(itemId);
        if (idx >= 0) state.inventory.splice(idx, 1);
      }
    }
  }

  state.talkedTo = Array.isArray(state.talkedTo) ? state.talkedTo : [];
  if (!state.talkedTo.includes(targetNpc.id)) state.talkedTo.push(targetNpc.id);
}
