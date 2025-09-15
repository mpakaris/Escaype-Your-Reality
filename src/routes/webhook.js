import { Router } from "express";
import { handleIncoming } from "../game/engine.js";

const router = Router();

function extractJidAndText(b = {}) {
  // Whinself primary shape
  const w = b.event || {};
  const info = w.Info || {};
  const msg = w.Message || {};

  // text candidates
  const text =
    msg.conversation ||
    msg?.message?.conversation ||
    b.text ||
    b.message ||
    b.body ||
    b?.messages?.[0]?.text?.body ||
    b?.messages?.[0]?.body ||
    b?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.text?.body ||
    "";

  // jid candidates
  const fromA = info.Chat; // e.g., '363...@s.whatsapp.net'
  const fromB = info.Sender; // sometimes '363...:19@s.whatsapp.net'
  const fromC = b.from || b.sender || b.contact || b?.messages?.[0]?.from;
  const pick = fromA || fromB || fromC || "";

  let jid = null;
  if (String(pick).includes("@s.whatsapp.net")) {
    // Normalize Sender like '36308548589:19@s.whatsapp.net' → '36308548589@s.whatsapp.net'
    const [left, right] = String(pick).split("@");
    const phone = left.split(":")[0];
    jid = `${phone}@${right}`;
  } else if (/^\d{6,}$/.test(String(pick))) {
    jid = `${pick}@s.whatsapp.net`;
  }

  return { jid, text };
}

router.post("/", async (req, res) => {
  try {
    // ACK fast
    res.status(200).json({ received: true });

    // Debug: dump headers and body once you reproduce
    // console.log("WEBHOOK HEADERS:", req.headers);
    // console.log("WEBHOOK RAW BODY:", JSON.stringify(req.body));

    const { jid, text } = extractJidAndText(req.body);
    console.log("WEBHOOK PARSED:", {
      jid,
      text,
      phone: req.body?.phone,
      // slotid: req.body?.slotid,
    });

    if (!jid) return;

    Promise.resolve(handleIncoming({ jid, from: jid, text })).catch((e) =>
      console.error("engine error", e)
    );
  } catch (e) {
    console.error("webhook error", e);
    try {
      res.status(200).json({ received: true });
    } catch {}
  }
});

export default router;
