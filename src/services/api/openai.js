import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Call OpenAI with gpt-5-nano
 * @param {string} prompt - user text to send
 * @param {object} [options] - optional overrides like max tokens
 * @returns {Promise<string>} model response text
 */
export async function askOpenAI(prompt, options = {}) {
  try {
    const response = await client.chat.completions.create({
      model: "gpt-5-nano",
      messages: [{ role: "user", content: prompt }],
      // max_tokens: options.max_tokens || 200,
    });

    return response.choices?.[0]?.message?.content?.trim() || "";
  } catch (err) {
    console.error("OpenAI API error:", err);
    return "Sorry, I couldn’t reach the AI service right now.";
  }
}
