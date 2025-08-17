import { sendText } from "../services/whinself.js";
import { fuzzyPickFromObjects } from "../utils/fuzzyMatch.js";

function itemDef(game, id) {
  return (game.items || []).find((i) => i.id === id) || null;
}
function itemLabel(def, id) {
  return def?.displayName || def?.name || id;
}

function renderTokens(text) {
  if (!text) return text;
  // {{yesterday_date:%m-%d-%Y}}
  return String(text).replace(
    /\{\{\s*yesterday_date\s*:(.*?)\}\}/g,
    (_, fmt) => {
      const d = new Date();
      d.setDate(d.getDate() - 1);
      // Minimal strftime-like formatter for %Y, %m, %d, %H, %M
      const pad = (n) => String(n).padStart(2, "0");
      const map = {
        "%Y": String(d.getFullYear()),
        "%m": pad(d.getMonth() + 1),
        "%d": pad(d.getDate()),
        "%H": pad(d.getHours()),
        "%M": pad(d.getMinutes()),
      };
      return fmt.replace(/%[YmdHM]/g, (t) => map[t] ?? t);
    }
  );
}

export async function run({ jid, user, game, state, args }) {
  const token = args && args.length ? args.join(" ") : "";
  if (!token) {
    await sendText(jid, "Read what? Example: */read receipt*.");
    return;
  }

  const inv = Array.isArray(state.inventory) ? state.inventory : [];
  const invForMatch = inv.map((id) => ({
    id,
    label: itemDef(game, id)?.displayName || id,
  }));

  // Try to match against items currently in inventory
  const hit = fuzzyPickFromObjects(token, invForMatch, ["id", "label"], {
    threshold: 0.55,
    maxResults: 1,
  });
  const inHandId = hit?.obj?.id || null;

  if (!inHandId) {
    // Not in inventory. Check if such an item exists in game and might be readable
    const allItems = game.items || [];
    const gameHit = fuzzyPickFromObjects(
      token,
      allItems.map((i) => ({
        id: i.id,
        label: i.displayName || i.name || i.id,
      })),
      ["id", "label"],
      { threshold: 0.55, maxResults: 1 }
    );
    const def = gameHit?.obj
      ? allItems.find((i) => i.id === gameHit.obj.id)
      : null;

    if (
      def &&
      (def.actions?.includes("read") ||
        def.messages?.read ||
        def.content ||
        def.read ||
        def.readText ||
        def.text)
    ) {
      const hintTpl =
        game.ui?.templates?.readNeedToTake ||
        "You eye the *{item}*, but it’s not on you. Maybe pick it up first.";
      await sendText(jid, hintTpl.replace("{item}", itemLabel(def, def?.id)));
      return;
    }

    await sendText(jid, "You don’t have that item.");
    return;
  }

  const def = itemDef(game, inHandId);
  const label = itemLabel(def, inHandId);

  // Determine readability and resolve text with priority: messages.read > content > read.text > readText > text > description
  const isReadable = !!(
    def &&
    (def.actions?.includes("read") ||
      def.messages?.read ||
      def.content ||
      def.read ||
      def.readText ||
      def.text)
  );
  if (!isReadable) {
    const nopeTpl =
      game.ui?.templates?.readNotReadable ||
      "You squint at *{item}*, but there’s nothing to read.";
    await sendText(jid, nopeTpl.replace("{item}", label));
    return;
  }

  const raw =
    (def.messages && def.messages.read) ||
    def.content ||
    (def.read && def.read.text) ||
    def.readText ||
    def.text ||
    def.description ||
    "";
  const text = renderTokens(raw);

  const hdr = game.ui?.templates?.readHeader;
  if (hdr) await sendText(jid, hdr.replace("{item}", label));
  await sendText(jid, text);
}
