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
function unique(arr = []) {
  return Array.from(new Set((arr || []).filter(Boolean)));
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

function applyEffects(effects, state) {
  const list = Array.isArray(effects)
    ? effects
    : typeof effects === "string"
    ? [effects]
    : Array.isArray(effects?.effect)
    ? effects.effect
    : [];
  if (!list.length) return;
  state.flags =
    state.flags && typeof state.flags === "object" ? state.flags : {};
  for (const e of list) {
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
  }
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

  console.debug("[talk] args", {
    raw: args,
    joined: (args && args.join(" ")) || "",
  });

  const loc = getCurrentLocation(game, state);
  const structure = getCurrentStructure(loc, state);
  const room = getCurrentRoom(structure, state);
  if (!structure || !room) {
    await sendText(jid, "No one to talk to here.");
    return;
  }

  // room.npcs can be ["id", { id, visibleWhen }]
  const entries = Array.isArray(room.npcs) ? room.npcs : [];
  const visibleIds = entries
    .map((e) => (typeof e === "string" ? { id: e } : e))
    .filter((e) => e && e.id && condOk(e.visibleWhen, state))
    .map((e) => e.id);
  const visibleNpcs = (game.npcs || []).filter((n) =>
    visibleIds.includes(n.id)
  );

  // Collect visible NPCs in other rooms of the same structure (honor visibleWhen)
  const rooms = Array.isArray(structure.rooms) ? structure.rooms : [];
  const elsewhere = [];
  for (const r of rooms) {
    if (!r || r.id === room.id) continue;
    const entriesR = Array.isArray(r.npcs) ? r.npcs : [];
    const idsR = entriesR
      .map((e) => (typeof e === "string" ? { id: e } : e))
      .filter((e) => e && e.id && condOk(e.visibleWhen, state))
      .map((e) => e.id);
    if (!idsR.length) continue;
    const npcsR = (game.npcs || []).filter((n) => idsR.includes(n.id));
    for (const n of npcsR) {
      elsewhere.push({ npc: n, roomId: r.id });
    }
  }

  if (!visibleNpcs.length && !elsewhere.length) {
    await sendText(jid, "No one here seems willing to talk.");
    return;
  }

  const targetRaw = (args && args.join(" "))?.trim() || "";
  let targetNpc = null;

  if (!targetRaw) {
    // If only one NPC present, talk to them. Otherwise ask to specify.
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
    const optTokens = options.map((o) =>
      o
        .toLowerCase()
        .split(/[^a-z0-9]+/g)
        .filter(Boolean)
    );
    const qtokAll = (targetRaw || "").toLowerCase();
    const tokenHitsCurrent = optTokens.some((ts) =>
      ts.some((t) => qtokAll.includes(t) || t.includes(qtokAll))
    );

    // If the query doesn't resemble anyone here, try elsewhere first
    if (!tokenHitsCurrent && elsewhere.length) {
      const elseOptions = elsewhere.map(
        ({ npc }) => npc.displayName || npc.name || npc.id
      );
      const eHitRaw = fuzzyMatch(targetRaw, elseOptions, {
        threshold: 0.45,
        maxResults: 1,
      });
      const eHit = normalizeFuzzyResult(eHitRaw);
      let found = null;
      if (typeof eHit === "string" && eHit.length) {
        const hlc = eHit.toLowerCase();
        found = elsewhere.find(
          ({ npc }) =>
            (npc.displayName || npc.name || npc.id).toLowerCase() === hlc
        );
      }
      if (!found) {
        const ids2 = elsewhere.map(({ npc }) => npc.id);
        const idRaw2 = fuzzyMatch(targetRaw, ids2, {
          threshold: 0.45,
          maxResults: 1,
        });
        const idNorm2 = normalizeFuzzyResult(idRaw2) || "";
        const idLc2 = typeof idNorm2 === "string" ? idNorm2.toLowerCase() : "";
        found = elsewhere.find(({ npc }) => npc.id.toLowerCase() === idLc2);
      }
      if (!found) {
        const q2 = targetRaw.toLowerCase();
        found = elsewhere.find(({ npc }) =>
          (npc.displayName || npc.name || npc.id).toLowerCase().includes(q2)
        );
      }
      if (!found) {
        const q3 = targetRaw.toLowerCase();
        found = elsewhere.find(({ npc }) => {
          const label = (npc.displayName || npc.name || npc.id).toLowerCase();
          const toks = label.split(/[^a-z0-9]+/g).filter(Boolean);
          return toks.some((t) => q3.includes(t) || t.includes(q3));
        });
      }
      if (found) {
        state.roomId = found.roomId;
        await sendText(jid, "You step into the adjoining room.");
        targetNpc = found.npc;
      }
    }

    if (!targetNpc) {
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
      if (!targetNpc) {
        const qtok = targetRaw.toLowerCase();
        targetNpc = visibleNpcs.find((n, idx) =>
          optTokens[idx].some((t) => qtok.includes(t) || t.includes(qtok))
        );
      }
    }

    // If still no match, search elsewhere rooms and hop if found
    if (!targetNpc && elsewhere.length) {
      const elseOptions = elsewhere.map(
        ({ npc }) => npc.displayName || npc.name || npc.id
      );
      const eHitRaw = fuzzyMatch(targetRaw, elseOptions, {
        threshold: 0.45,
        maxResults: 1,
      });
      const eHit = normalizeFuzzyResult(eHitRaw);
      let found = null;
      if (typeof eHit === "string" && eHit.length) {
        const hlc = eHit.toLowerCase();
        found = elsewhere.find(
          ({ npc }) =>
            (npc.displayName || npc.name || npc.id).toLowerCase() === hlc
        );
      }
      if (!found) {
        const ids2 = elsewhere.map(({ npc }) => npc.id);
        const idRaw2 = fuzzyMatch(targetRaw, ids2, {
          threshold: 0.45,
          maxResults: 1,
        });
        const idNorm2 = normalizeFuzzyResult(idRaw2) || "";
        const idLc2 = typeof idNorm2 === "string" ? idNorm2.toLowerCase() : "";
        found = elsewhere.find(({ npc }) => npc.id.toLowerCase() === idLc2);
      }
      if (!found) {
        const q2 = targetRaw.toLowerCase();
        found = elsewhere.find(({ npc }) =>
          (npc.displayName || npc.name || npc.id).toLowerCase().includes(q2)
        );
      }
      if (!found) {
        const q3 = targetRaw.toLowerCase();
        found = elsewhere.find(({ npc }) => {
          const label = (npc.displayName || npc.name || npc.id).toLowerCase();
          const toks = label.split(/[^a-z0-9]+/g).filter(Boolean);
          return toks.some((t) => q3.includes(t) || t.includes(q3));
        });
      }
      if (found) {
        state.roomId = found.roomId;
        await sendText(jid, "You step into the adjoining room.");
        targetNpc = found.npc;
      }
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
  applyEffects(eff, state);

  state.talkedTo = Array.isArray(state.talkedTo) ? state.talkedTo : [];
  if (!state.talkedTo.includes(targetNpc.id)) state.talkedTo.push(targetNpc.id);
}
