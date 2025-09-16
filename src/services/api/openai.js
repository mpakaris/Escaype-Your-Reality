import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Call OpenAI with gpt-5-nano
 * @param {string} prompt - user text to send
 * @param {object} [options] - optional overrides like max tokens
 * @param {Array<{user: string, assistant: string}>} [conversationHistory] - previous conversation turns
 * @returns {Promise<string>} model response text
 */
export async function askOpenAI(
  prompt,
  options = {},
  conversationHistory = []
) {
  try {
    const messages = [
      {
        role: "system",
        content:
          "You are an NPC object. Stick strictly to your role and do not invent information outside of it.",
      },
      ...conversationHistory.flatMap((turn) => [
        { role: "user", content: turn.user },
        { role: "assistant", content: turn.assistant },
      ]),
      { role: "user", content: prompt },
    ];

    const response = await client.chat.completions.create({
      model: "gpt-5-nano",
      messages,
      // max_tokens: options.max_tokens ?? 200,
      // temperature: options.temperature ?? 0.6,
    });

    return response.choices?.[0]?.message?.content?.trim() || "";
  } catch (err) {
    console.error("OpenAI API error:", err);
    return "Sorry, I couldn’t reach the AI service right now.";
  }
}
