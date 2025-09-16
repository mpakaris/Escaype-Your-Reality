import { askOpenAI } from "../services/api/openai.js";
import { sendText } from "../services/whinself.js";

export default async function askCommand({ jid, args }) {
  const question = Array.isArray(args) ? args.join(" ") : args;

  if (!question || !question.trim()) {
    await sendText(jid, "Ask what? Example: */ask Tell me a joke!*");
    return;
  }

  const reply = await askOpenAI(question.trim());
  await sendText(jid, reply || "The AI didn’t respond this time.");
}
