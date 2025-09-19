import axios from "axios";

const base = process.env.WHINSELF_BASE_URL?.replace(/\/+$/, "");
const api = axios.create({ baseURL: base, timeout: 10000 });

function isAllowedDevJid(jid) {
  if (
    process.env.CODING_ENV === "DEV" &&
    jid !== "36308548589@s.whatsapp.net"
  ) {
    return false;
  }
  return true;
}

export async function sendText(jid, text) {
  if (!isAllowedDevJid(jid)) {
    console.log(`DEV mode: blocked send to ${jid}`);
    return;
  }
  if (!base) throw new Error("WHINSELF_BASE_URL not set");
  try {
    const { status, data } = await api.post("/wspout", { jid, text });
    if (status !== 200) console.error("whinself non-200", status, data);
  } catch (err) {
    console.error("whinself send error", err.response?.data || err.message);
  }
}

export async function sendImage(jid, url, caption) {
  if (!isAllowedDevJid(jid)) {
    console.log(`DEV mode: blocked send to ${jid}`);
    return;
  }
  try {
    await api.post("/wspout", { image: { url, caption }, jid });
  } catch (err) {
    console.error(
      "whinself image send error",
      err.response?.data || err.message
    );
  }
}

export async function sendAudio(jid, url) {
  if (!isAllowedDevJid(jid)) {
    console.log(`DEV mode: blocked send to ${jid}`);
    return;
  }
  if (!base) throw new Error("WHINSELF_BASE_URL not set");
  if (!jid || !url) throw new Error("jid and url required");
  try {
    await api.post("/wspout", {
      audio: { url }, // media by URL per docs
      jid,
    });
  } catch (err) {
    console.error(
      "whinself audio send error",
      err.response?.data || err.message
    );
  }
}

export async function sendVideo(jid, url) {
  if (!isAllowedDevJid(jid)) {
    console.log(`DEV mode: blocked send to ${jid}`);
    return;
  }
  if (!base) throw new Error("WHINSELF_BASE_URL not set");
  if (!jid || !url) throw new Error("jid and url required");
  try {
    await api.post("/wspout", { video: { url }, jid });
  } catch (err) {
    console.error(
      "whinself video send error",
      err.response?.data || err.message
    );
  }
}

export async function sendDocument(jid, url, filename) {
  if (!isAllowedDevJid(jid)) {
    console.log(`DEV mode: blocked send to ${jid}`);
    return;
  }
  try {
    await api.post("/wspout", { document: { url, fileName: filename }, jid });
  } catch (err) {
    console.error("whinself doc send error", err.response?.data || err.message);
  }
}

/**
 * Generic media sender used by the engine. Accepts a single media ref or an array.
 * MediaRef: { type: 'video'|'audio'|'image'|'doc', url: string, caption?: string, filename?: string }
 */
function _guessFilename(url, fallback) {
  try {
    const u = new URL(url);
    const last = (u.pathname.split("/").pop() || "").trim();
    return last || fallback || "file";
  } catch (_) {
    return fallback || "file";
  }
}

export async function sendMedia(jid, media) {
  const list = Array.isArray(media) ? media : [media];
  for (const m of list) {
    if (!m || !m.url) continue;
    const t = String(m.type || "").toLowerCase();
    const caption = m.caption || undefined;
    if (t === "video") {
      await sendVideo(jid, m.url, caption);
      continue;
    }
    if (t === "audio") {
      await sendAudio(jid, m.url);
      continue;
    }
    if (t === "image") {
      await sendImage(jid, m.url, caption);
      continue;
    }
    if (t === "doc") {
      const name = m.filename || _guessFilename(m.url, "document");
      await sendDocument(jid, m.url, name);
      continue;
    }
    // Fallback: send URL as text if type is unknown
    await sendText(jid, m.url);
  }
}
