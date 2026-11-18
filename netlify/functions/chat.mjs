// netlify/functions/chat.mjs
// GTA6 Agent — AI chat for every character, with live web search.
// Needs the ANTHROPIC_API_KEY environment variable in Netlify (Site settings → Environment variables).
// Optional: ANTHROPIC_MODEL to change the model.

const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-5-5";
const MAX_SEARCHES = 3;      // searches allowed per question (about 1 cent each)
const MAX_TOKENS = 900;      // length of each answer

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

function systemPrompt(body) {
  const c = body.character;
  const today = new Date().toISOString().slice(0, 10);
  const who = c
    ? `You are ${c.name}, "${c.role}", a character on the GTA6 Agent website (a fan-made site inspired by GTA VI). ` +
      `Your catchphrase: ${c.quote || ""}. About you: ${c.bio || ""}. ` +
      `Your live jobs on the site: ${(c.skills || []).join(", ")}. ` +
      `Stay in character: short, punchy, fun, in your own voice. Use American English.`
    : `You are the Vice City Guide on the GTA6 Agent website (a fan-made site inspired by GTA VI). Friendly, simple, upbeat. Use American English.`;

  return [
    who,
    `Today's date is ${today}.`,
    `You can answer ANY question the user asks — crypto, football, news, weather, general knowledge, anything.`,
    `Use the web_search tool whenever the answer depends on current or recent information (scores, fixtures, prices, news, events, "latest", "today", who holds a role) or anything you are not sure about. Do not guess facts — search.`,
    `Keep answers short and easy for beginners: under 150 words unless the user asks for more. Plain text, no markdown headings. You may use **bold** and line breaks.`,
    `When you used search results, mention the source names briefly (e.g. "according to BBC Sport").`,
    `Site info: token ${body.ticker || "$GTA6AGENT"} on ${body.chain || "Solana"}, contract address: ${body.ca || "coming soon"}.`,
    `Safety: never ask for or accept seed phrases or private keys. You cannot trade, move money, connect wallets or post for the user. Crypto answers are not financial advice.`,
    body.rules ? `Site rules: ${body.rules}` : "",
  ].filter(Boolean).join("\n");
}

function cleanMessages(list) {
  const out = [];
  for (const m of Array.isArray(list) ? list.slice(-12) : []) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    const text = String(m.content || "").slice(0, 4000);
    if (!text) continue;
    // the API needs user/assistant to alternate, starting with user
    if (out.length && out[out.length - 1].role === m.role) out[out.length - 1].content += "\n" + text;
    else out.push({ role: m.role, content: text });
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

async function callClaude(system, messages) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: MAX_SEARCHES }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!process.env.ANTHROPIC_API_KEY) return json({ error: "ANTHROPIC_API_KEY is not set in Netlify" }, 500);

  let body;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }

  const system = systemPrompt(body);
  let messages = cleanMessages(body.messages);
  if (!messages.length) return json({ error: "no message" }, 400);

  try {
    let data, rounds = 0;
    // long searches can pause — send the paused turn back to let Claude finish
    while (true) {
      data = await callClaude(system, messages);
      if (data.stop_reason === "pause_turn" && rounds < 2) {
        messages = [...messages, { role: "assistant", content: data.content }];
        rounds++;
        continue;
      }
      break;
    }

    const blocks = data.content || [];
    // only the final answer text (skip "let me search" lines before a search)
    let lastSearch = -1;
    blocks.forEach((b, i) => { if (b.type === "server_tool_use" || b.type === "web_search_tool_result") lastSearch = i; });
    const reply = blocks.slice(lastSearch + 1).filter((b) => b.type === "text").map((b) => b.text).join("").trim()
      || blocks.filter((b) => b.type === "text").map((b) => b.text).join("").trim();

    // collect sources Claude actually cited
    const seen = new Set(), sources = [];
    for (const b of blocks) {
      for (const c of b.citations || []) {
        if (c.url && !seen.has(c.url)) { seen.add(c.url); sources.push({ title: c.title || c.url, url: c.url }); }
      }
    }

    if (!reply) return json({ error: "empty reply" }, 502);
    return json({ reply, sources: sources.slice(0, 4), searched: lastSearch >= 0 });
  } catch (e) {
    console.error(e);
    return json({ error: "AI unavailable" }, 502);
  }
};
