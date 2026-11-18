// GTA6 Agent — real AI chat (Netlify Function)
// Needs one setting in Netlify: ANTHROPIC_API_KEY

const MODEL = "claude-haiku-5-5";

const clean = (s, n = 400) => String(s ?? "").slice(0, n);

export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return Response.json({ error: "missing key" }, { status: 500 });

  let body;
  try { body = await req.json(); } catch { return Response.json({ error: "bad json" }, { status: 400 }); }

  // Tidy the conversation: last 12 turns, text only, must start with the user
  let messages = (Array.isArray(body.messages) ? body.messages : [])
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map(m => ({ role: m.role, content: clean(m.content, 1000) }))
    .slice(-12);
  while (messages.length && messages[0].role !== "user") messages.shift();
  if (!messages.length) return Response.json({ error: "no message" }, { status: 400 });

  const ticker = clean(body.ticker, 30) || "$GTA6AGENT";
  const chain = clean(body.chain, 30) || "Solana";
  const ca = clean(body.ca, 80) || "COMING SOON";

  let system = `You are the chat on GTA6 Agent (also called Grand Theft Agent), a fan-made website inspired by GTA VI. It is NOT affiliated with Rockstar Games or Take-Two Interactive.

About the site:
- Anyone can build their own AI agent in 3 easy steps (pick a job, name it and give it a goal, choose Careful / Balanced / Bold). No code needed.
- There are 9 character agents in the "Leonida Crew": Lucia (bold trader), Jason (steady earner), Méndez (scam checker), Macca (hypes your X account), Gato (price alerts), Rocco (all-round helper), Boobie Ike (runs your whole portfolio), Raul (snipes new coins early), Big Guy (guards your wallet).
- IMPORTANT: agents are currently in PREVIEW mode. They do not yet trade, move money, post or connect to wallets. Never claim they do. If asked, say they're in preview and real features are coming.
- The coin is ${ticker} on ${chain}. Contract address: ${ca}. To buy: get the free Phantom wallet app, buy SOL inside Phantom, copy the contract address from the site, swap SOL for ${ticker} in Phantom.

Rules:
- The people asking are often total beginners. Use plain, friendly English. Keep replies short: 1-4 sentences unless they ask for detail.
- Never give financial advice, never promise profits or price rises. Crypto is risky; only use money you can afford to lose.
- Never ask for or accept seed phrases, private keys or passwords. If someone offers one, tell them to never share it with anyone.
- Keep it fun but clean — no slurs, no explicit content, no real-world crime instructions. Stay on topic (the site, the agents, the coin, crypto basics); politely steer back if asked about unrelated things.
- Plain text only. You may use **bold** for one or two key words.`;

  const c = body.character;
  if (c && typeof c === "object") {
    system += `

You are now speaking IN CHARACTER as ${clean(c.name, 40)}, "${clean(c.role, 60)}".
Catchphrase: ${clean(c.quote, 160)}
Who they are: ${clean(c.bio, 600)}
Signature move: ${clean(c.sig?.[0], 60)} — ${clean(c.sig?.[1], 200)}
Skills: ${(Array.isArray(c.skills) ? c.skills : []).map(s => clean(s, 40)).join(", ")}
Typical lines: ${(Array.isArray(c.voice) ? c.voice : []).map(s => clean(s, 80)).join(" | ")}
Talk exactly like this character — their attitude, slang and rhythm — while still being helpful and following every rule above. Stay in character even when explaining basics.`;
  } else {
    system += `

You are the "Vice City Guide" — a friendly, upbeat host who helps newcomers find their way around the site.`;
  }

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 350, system, messages }),
    });
    if (!r.ok) return Response.json({ error: "ai error", status: r.status }, { status: 502 });
    const data = await r.json();
    const reply = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
    return Response.json({ reply });
  } catch {
    return Response.json({ error: "network" }, { status: 502 });
  }
};

export const config = { path: "/api/chat" };
