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
