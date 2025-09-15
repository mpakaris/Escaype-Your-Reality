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
import { sendImage, sendText } from "../services/whinself.js";

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

function pickRandom(pool = []) {
  if (!Array.isArray(pool) || pool.length === 0) return "";
  return pool[Math.floor(Math.random() * pool.length)];
}

export async function run({ jid, user, game, state, args }) {
  // Validate argument
  const rc = (args?.[0] || "").trim();
  if (!/^([1-3]{2})$/.test(rc)) {
    await sendText(
      jid,
      "Invalid move. Use a 3x3 grid coordinate like */move 11*, */move 23*, */move 33*."
    );
    return;
  }

  // Translate to cartridge id format "r,c"
  const id = rc; // plain two-digit form
  const loc = getLocationById(game, id);
  if (!loc) {
    await sendText(jid, "No such intersection. The grid goes from 11 to 33.");
    return;
  }

  // Check if already at this location (supports legacy "1,1" in state)
  const current = String(state.location || "");
  const currentPlain = current.replace(",", "");
  if (currentPlain === id) {
    const pool = game.ui?.moveSameLocationRemarks || [];
    const fallback = ["You’re already here."];
    const remark = pickRandom(pool.length ? pool : fallback);
    await sendText(jid, remark);
    return;
  }

  // Update state
  state.location = String(loc.id);
  state.inStructure = false;
  state.structureId = null;
  state.roomId = null;

  // Media: arrival image if available
  const arrivalImg =
    loc.media?.arrivalImage ||
    (Array.isArray(loc.arrival?.images) ? loc.arrival.images[0] : null);
  if (arrivalImg) {
    try {
      await sendImage(jid, arrivalImg, loc.name);
    } catch {}
  }

  // Flavor text
  const flavorBase = loc.flavor || "";
  const weather = pickRandom(loc.weatherPool || game.ui?.weatherPool);
  const activity = pickRandom(loc.activityPool || game.ui?.activityPool);
  const flavor = [flavorBase, weather, activity].filter(Boolean).join(" ");

  // Arrival text using templates
  const arrivalTpl = game.ui?.templates?.arrival;
  const whereTpl = game.ui?.templates?.whereOutside;
  const structuresAll = Array.isArray(loc.structures) ? loc.structures : [];
  const structures = structuresAll.map((s) => s.displayName).filter(Boolean);
  const enterableNames = structuresAll
    .filter((s) => s.enterable)
    .map((s) => s.displayName)
    .filter(Boolean);

  const structuresList = formatList(structures);
  const whereText = whereTpl
    ? String(whereTpl)
        .replace("{location}", loc.name)
        .replace("{flavor}", flavor)
        .replace("{structures}", structuresList)
    : `You’re at *${loc.name}*. ${flavor}\n\n*Around you:* ${structuresList}`;

  const parts = [
    `You arrived at your destination. You look around this dark city.`,
    whereText,
  ];

  if (enterableNames.length) {
    const enterSuggest = suggestEnter(enterableNames);
    parts.push(`\nUse */enter ${enterSuggest}* to step inside.`);
  }

  await sendText(jid, parts.join("\n\n"));
}
