// src/services/renderer.js
import { sendAudio, sendDocument, sendText, sendVideo } from "./whinself.js";

export function resolveMedia(game, type, idOrUrl) {
  if (!idOrUrl) return null;
  const val = String(idOrUrl);
  if (val.startsWith("http")) return val;
  const bucketName = type === "image" ? "images" : type;
  const bucket = game.media?.[bucketName] || {};
  return bucket[val] || null;
}

export async function renderStep(jid, game, step) {
  if (!step) return;
  switch (step.type) {
    case "narrator":
    case "text":
      await sendText(jid, step.text || "");
      break;
    case "image": {
      const url = resolveMedia(game, "image", step.url || step.id);
      if (url) await sendDocument(jid, url, "image.jpg");
      break;
    }
    case "audio": {
      const url = resolveMedia(game, "audio", step.url || step.id);
      if (url) await sendAudio(jid, url);
      break;
    }
    case "video": {
      const url = resolveMedia(game, "video", step.url || step.id);
      if (url) await sendVideo(jid, url);
      break;
    }
    case "document": {
      const url = resolveMedia(game, "document", step.url || step.id);
      if (url) await sendDocument(jid, url, step.filename || "doc");
      break;
    }
    default:
      await sendText(jid, step.text || "");
  }
}
