"use strict";

import { sendText } from "../services/whinself.js";
import { tpl } from "../services/renderer.js";
import { unmetReasons, evaluateRequirements } from "../services/progress.js";

function bullets(arr) {
  return (arr || []).map((s) => `• ${s}`).join("\n");
}

export async function run({ jid, user, game, state, args }) {
  const chapters = game?.progression?.chapters || [];
  const idx = Math.max(
    0,
    Math.min((state.chapter || 1) - 1, chapters.length - 1)
  );
  const cfg = chapters[idx] || null;

  if (!cfg) {
    await sendText(
      jid,
      tpl(game?.ui, "progress.noChapter") || "No active chapter."
    );
    return;
  }

  const ok = evaluateRequirements(state, cfg.requires);
  const reasons = ok ? [] : unmetReasons(state, cfg.requires);

  const header =
    tpl(game?.ui, "progress.header", {
      chapter: cfg.id || idx + 1,
      title: cfg.title || "",
    }) || `Chapter ${cfg.id || idx + 1}${cfg.title ? ` — ${cfg.title}` : ""}`;

  if (ok) {
    const msg =
      tpl(game?.ui, "progress.met") ||
      "All requirements met. Type */next* if this is a scripted sequence, or continue playing to trigger advancement.";
    await sendText(jid, `${header}\n${msg}`);
    return;
  }

  const unmetHdr =
    tpl(game?.ui, "progress.unmetHeader") || "Unmet requirements:";
  const body = reasons.length
    ? bullets(reasons)
    : tpl(game?.ui, "progress.unknown") || "Unknown blocking condition.";
  await sendText(jid, `${header}\n${unmetHdr}\n${body}`);
}

export default { run };
