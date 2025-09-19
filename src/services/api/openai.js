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

/**
 * Ask OpenAI for STRICT JSON using Structured Outputs.
 * @param {string} prompt - full prompt (may include system + user guidance)
 * @param {object} schema - JSON Schema for the expected object
 * @param {object} options - { temperature?: number, max_tokens?: number }
 * @returns {Promise<object>} parsed JSON or throws
 */
export async function askOpenAIStructured(prompt, schema, options = {}) {
  console.log("Prompt 2: ", JSON.toString(prompt));
  try {
    const response = await client.chat.completions.create({
      model: "gpt-5-nano",
      messages: [
        {
          role: "system",
          content:
            "You are a strict classifier. Reply ONLY with valid JSON matching the provided schema.",
        },
        { role: "user", content: prompt },
      ],
      // temperature: options.temperature ?? 0.2,
      // max_tokens: options.max_tokens ?? 80,
      response_format: {
        type: "json_schema",
        json_schema: { name: "NpcReply", schema, strict: true },
      },
    });
    const raw = response.choices?.[0]?.message?.content?.trim() || "{}";
    return JSON.parse(raw);
  } catch (err) {
    console.error("OpenAI Structured API error:", err);
    throw err;
  }
}

/**
 * Classify a user question into one of the scripted NPC reply indices using structured outputs.
 * Returns { index:number, tag:string }.
 */
export async function classifyNpcReply({
  question,
  npc = {},
  map = {},
  context = {},
  policy = {},
}) {
  const indices = Object.keys(map)
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const tags = Array.from(
    new Set(Object.values(map).map((t) => String(t || "").toLowerCase()))
  );

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      index: {
        type: "integer",
        minimum: indices[0] || 1,
        maximum: indices[indices.length - 1] || 10,
      },
      tag: { type: "string", enum: tags.length ? tags : ["vague"] },
    },
    required: ["index", "tag"],
  };

  const disallowClue = !policy?.allowClue;
  const lastType =
    Array.isArray(context?.lastTypes) && context.lastTypes.length
      ? String(context.lastTypes.slice(-1)[0])
      : "";
  const avoidRepeat = !!policy?.avoidRepeatTypes;

  const lines = [
    `NPC: ${npc?.id || "npc"} tone=${npc?.tone || ""}`,
    `indices: { ${indices.map((i) => `${i}:${map[i]}`).join(", ")} }`,
    lastType ? `lastType: ${lastType}` : "",
    `avoidRepeat: ${avoidRepeat ? "true" : "false"}`,
    `allowClue: ${!disallowClue}`,
    `question: ${String(question || "").trim()}`,
    "Rules:",
    "- If rude/insulting → choose tag 'insulted' if available.",
    "- If asking for concrete details → choose 'observant' or 'personal'.",
    "- If vague early in conversation → choose 'vague' or 'confused'.",
    disallowClue ? "- Do NOT choose tag 'clue'." : "- Tag 'clue' is permitted.",
    avoidRepeat && lastType ? `- Avoid repeating tag '${lastType}'.` : "",
    'Return JSON only: {"index": number, "tag": string}',
  ].filter(Boolean);

  try {
    const out = await askOpenAIStructured(lines.join("\n"), schema, {
      temperature: 0.2,
      max_tokens: 60,
    });
    let idx = Number(out.index);
    let tag = String(out.tag || "");
    if (!Number.isFinite(idx) || !map[idx]) throw new Error("bad index");
    if (disallowClue && tag.toLowerCase() === "clue") {
      const alt = indices.find((i) => String(map[i]).toLowerCase() !== "clue");
      if (alt) return { index: alt, tag: map[alt] };
    }
    if (
      avoidRepeat &&
      lastType &&
      tag.toLowerCase() === lastType.toLowerCase()
    ) {
      const alt2 = indices.find(
        (i) => String(map[i]).toLowerCase() !== tag.toLowerCase()
      );
      if (alt2) return { index: alt2, tag: map[alt2] };
    }
    return { index: idx, tag };
  } catch (e) {
    // Heuristic fallback
    const q = String(question || "").toLowerCase();
    const rude = /\b(stupid|idiot|dumb|shut up|f\*+|fuck|bitch|asshole)\b/.test(
      q
    );
    if (rude) {
      const alt = indices.find(
        (i) => String(map[i]).toLowerCase() === "insulted"
      );
      if (alt) return { index: alt, tag: map[alt] };
    }
    const detail =
      /(why|how|when|where|what|explain|detail|specific|exact)/.test(q);
    if (detail) {
      const alt = indices.find((i) =>
        ["observant", "personal"].includes(String(map[i]).toLowerCase())
      );
      if (alt) return { index: alt, tag: map[alt] };
    }
    const def = indices[0] || 1;
    return { index: def, tag: map[def] || "vague" };
  }
}

/**
 * Analyzes user input text to determine the intended command, its arguments,
 * target identifiers, and confidence level using OpenAI's structured output.
 *
 * @param {string} text - The user input text to interpret.
 * @param {object} [context={}] - Contextual information including available commands, objects, items, and NPCs.
 * @param {object} [options={}] - Optional overrides for the OpenAI API call such as temperature and max_tokens.
 * @returns {Promise<object>} An object containing:
 *  - command: {string} The identified command.
 *  - args: {string[]} Array of argument strings for the command.
 *  - targetIds: {object} Object containing optional target identifiers (item, object, npc).
 *  - confidence: {number} Confidence score between 0 and 1 indicating certainty of the classification.
 */
export async function routeIntent(text, context = {}, options = {}) {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      command: { type: "string" },
      args: {
        type: "array",
        items: { type: "string" },
      },
      targetIds: {
        type: "object",
        properties: {
          item: { type: "string" },
          object: { type: "string" },
          npc: { type: "string" },
        },
        additionalProperties: false,
        required: ["item", "object", "npc"],
      },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1,
      },
    },
    required: ["command", "args", "targetIds", "confidence"],
  };

  const { commands = [], objects = [], items = [], npcs = [] } = context;

  const promptLines = [
    `User input: ${text}`,
    `Available commands: ${commands.join(", ")}`,
    `Known objects: ${objects.join(", ")}`,
    `Known items: ${items.join(", ")}`,
    `Known NPCs: ${npcs.join(", ")}`,
    "Always include targetIds.item, targetIds.object, and targetIds.npc. If a field is not applicable, set it to an empty string.",
    "Return a JSON object with the following structure:",
    JSON.stringify(schema, null, 2),
  ];

  try {
    console.log("prompt Lines 1: ", JSON.toString(prompt));

    const result = await askOpenAIStructured(promptLines.join("\n"), schema, {
      temperature: 0,
      max_tokens: 64,
      ...options,
    });
    console.log("Route Intent Result: ", result);
    return result;
  } catch (err) {
    return { command: "unknown", args: [], targetIds: {}, confidence: 0 };
  }
}
