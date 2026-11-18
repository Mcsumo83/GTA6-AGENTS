// GTA6 Agent — real AI chat + live tools (Netlify Function)
// Needs one setting in Netlify: ANTHROPIC_API_KEY
// Live tools (free, no keys): DexScreener + RugCheck (coin checks), CoinGecko (prices)

const MODEL = "claude-haiku-5-5";

const clean = (s, n = 400) => String(s ?? "").slice(0, n);
const num = (v) => (v === null || v === undefined || v === "" || isNaN(Number(v)) ? null : Number(v));
const usd = (v) => {
  const n = num(v);
  if (n === null) return "unknown";
  if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
  if (n >= 1) return "$" + n.toFixed(2);
  return "$" + n.toPrecision(3);
};
const pct = (v) => (num(v) === null ? "unknown" : (num(v) >= 0 ? "+" : "") + num(v).toFixed(1) + "%");

async function getJSON(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { accept: "application/json" } });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// ---------- Tool 1: coin check (Méndez) ----------
const SOL_ADDR = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/;
const EVM_ADDR = /\b0x[a-fA-F0-9]{40}\b/;

async function coinCheck(addr, isSolana) {
  const [dex, rug] = await Promise.all([
    getJSON(`https://api.dexscreener.com/latest/dex/tokens/${addr}`),
    isSolana ? getJSON(`https://api.rugcheck.xyz/v1/tokens/${addr}/report`) : Promise.resolve(null),
  ]);

  const lines = [`LIVE COIN CHECK for address ${addr}:`];
  let found = false;

  const pairs = Array.isArray(dex) ? dex : Array.isArray(dex?.pairs) ? dex.pairs : [];
  if (pairs.length) {
    found = true;
    const p = [...pairs].sort((a, b) => (num(b?.liquidity?.usd) || 0) - (num(a?.liquidity?.usd) || 0))[0];
    const ageDays = p.pairCreatedAt ? Math.max(0, (Date.now() - p.pairCreatedAt) / 86400000) : null;
    lines.push(
      `- Name: ${clean(p.baseToken?.name, 60)} (${clean(p.baseToken?.symbol, 20)}) on ${clean(p.chainId, 20)} via ${clean(p.dexId, 20)}`,
      `- Price: ${usd(p.priceUsd)} | 24h change: ${pct(p.priceChange?.h24)}`,
      `- Liquidity: ${usd(p.liquidity?.usd)} | Market cap: ${usd(p.marketCap ?? p.fdv)} | 24h volume: ${usd(p.volume?.h24)}`,
      `- 24h trades: ${num(p.txns?.h24?.buys) ?? "?"} buys / ${num(p.txns?.h24?.sells) ?? "?"} sells`,
      `- Trading pair age: ${ageDays === null ? "unknown" : ageDays < 1 ? Math.round(ageDays * 24) + " hours" : Math.round(ageDays) + " days"}`,
      `- Number of trading pairs found: ${pairs.length}`
    );
  }

  if (rug && typeof rug === "object") {
    found = true;
    const mintAuth = rug.mintAuthority ?? rug.token?.mintAuthority;
    const freezeAuth = rug.freezeAuthority ?? rug.token?.freezeAuthority;
    lines.push(
      `- Mint authority: ${mintAuth ? "STILL ENABLED (creator can print more tokens)" : "disabled (good)"}`,
      `- Freeze authority: ${freezeAuth ? "STILL ENABLED (creator can freeze wallets)" : "disabled (good)"}`
    );
    const holders = Array.isArray(rug.topHolders) ? rug.topHolders : [];
    if (holders.length) {
      const top10 = holders.slice(0, 10).reduce((s, h) => s + (num(h.pct) || 0), 0);
      lines.push(`- Top 10 holders own about ${top10.toFixed(1)}% of supply (biggest single holder ${(num(holders[0]?.pct) || 0).toFixed(1)}%)`);
    }
    const markets = Array.isArray(rug.markets) ? rug.markets : [];
    const locked = markets.map((m) => num(m?.lp?.lpLockedPct)).filter((v) => v !== null);
    if (locked.length) lines.push(`- Liquidity locked/burned: about ${Math.max(...locked).toFixed(0)}%`);
    if (num(rug.score_normalised) !== null) lines.push(`- RugCheck risk score: ${num(rug.score_normalised)} (lower is safer)`);
    const risks = Array.isArray(rug.risks) ? rug.risks : [];
    if (risks.length) lines.push(`- Flagged risks: ${risks.slice(0, 6).map((r) => `${clean(r.name, 60)} [${clean(r.level, 10)}]`).join("; ")}`);
    else lines.push(`- Flagged risks: none listed`);
  }

  if (!found) lines.push("- No trading data found. The address may be wrong, not a token, too new, or not traded on any DEX yet.");
  lines.push(
    "Use ONLY these facts. Give a verdict of CLEAN, SUS or CROOKED with the 2-4 biggest reasons in plain words.",
    "Remind them this is a quick automated check, not a guarantee and not financial advice."
  );
  return lines.join("\n");
}

// ---------- Tool 2: live prices (Gato) ----------
const COINS = { solana: ["sol", "solana"], bitcoin: ["btc", "bitcoin"], ethereum: ["eth", "ethereum"] };
const PRICE_WORDS = /\b(price|prices|doing|pump|pumping|dump|dumping|worth|chart|market|up|down|moving|today)\b/i;

async function livePrices(text) {
  const t = text.toLowerCase();
  let ids = Object.keys(COINS).filter((id) => COINS[id].some((w) => new RegExp(`\\b${w}\\b`).test(t)));
  if (!ids.length) ids = Object.keys(COINS);
  const data = await getJSON(
    `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=usd&include_24hr_change=true`
  );
  if (!data) return "LIVE PRICES: the price service didn't answer right now. Say you couldn't fetch live prices this second and to try again shortly.";
  const lines = ["LIVE PRICES (CoinGecko, right now):"];
  for (const id of ids) {
    if (data[id]) lines.push(`- ${id.toUpperCase()}: ${usd(data[id].usd)} (24h ${pct(data[id].usd_24h_change)})`);
  }
  lines.push("Use these exact numbers. Do not predict where prices will go.");
  return lines.join("\n");
}

// ---------- Main handler ----------
export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return Response.json({ error: "missing key" }, { status: 500 });

  let body;
  try { body = await req.json(); } catch { return Response.json({ error: "bad json" }, { status: 400 }); }

  let messages = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: clean(m.content, 1000) }))
    .slice(-12);
  while (messages.length && messages[0].role !== "user") messages.shift();
  if (!messages.length) return Response.json({ error: "no message" }, { status: 400 });

  const ticker = clean(body.ticker, 30) || "$GTA6AGENT";
  const chain = clean(body.chain, 30) || "Solana";
  const ca = clean(body.ca, 80) || "COMING SOON";
  const links = body.links && typeof body.links === "object" ? body.links : {};

  let system = `You are the chat on GTA6 Agent (also called Grand Theft Agent), a fan-made website inspired by GTA VI. It is NOT affiliated with Rockstar Games or Take-Two Interactive.

About the site:
- Anyone can build their own AI agent in 3 easy steps (pick a job, name it and give it a goal, choose Careful / Balanced / Bold). No code needed.
- There are 9 character agents in the "Leonida Crew": Lucia (bold trader), Jason (steady earner), Méndez (scam checker), Macca (hypes your X account), Gato (price watcher), Rocco (all-round helper), Boobie Ike (runs your whole portfolio), Raul (snipes new coins early), Big Guy (guards your wallet).
- LIVE features that really work: AI chat with every character; Méndez can check a real coin when someone pastes a contract address; Gato can give live SOL/BTC/ETH prices; Macca writes ready-to-copy X posts.
- NOT live yet (preview/coming soon): automated trading, earning, sniping, auto-posting, portfolio management, wallet monitoring. Never claim these work; say they're coming soon.
- The coin is ${ticker} on ${chain}. Contract address: ${ca}. To buy: get the free Phantom wallet app, buy SOL inside Phantom, copy the contract address from the site, swap SOL for ${ticker} in Phantom.
- Community links: X ${clean(links.x, 100) || "(not set)"}, Telegram ${clean(links.telegram, 100) || "(not set)"}.

Rules:
- The people asking are often total beginners. Use plain, friendly English. Keep replies short: 1-4 sentences unless they ask for detail or the task needs more (coin checks, posts).
- Never give financial advice, never promise profits or price rises, never tell people to buy or sell a specific coin. Crypto is risky; only use money you can afford to lose.
- Never ask for or accept seed phrases, private keys or passwords. If someone offers one, tell them to never share it with anyone.
- Keep it fun but clean — no slurs, no explicit content, no real-world crime instructions. Stay on topic (the site, the agents, the coin, crypto basics); politely steer back if asked about unrelated things.
- Plain text only. You may use **bold** for a few key words. Use line breaks for lists.`;

  const c = body.character;
  const charId = c && typeof c === "object" ? clean(c.id, 20) : "";
  if (charId) {
    system += `

You are now speaking IN CHARACTER as ${clean(c.name, 40)}, "${clean(c.role, 60)}".
Catchphrase: ${clean(c.quote, 160)}
Who they are: ${clean(c.bio, 600)}
Signature move: ${clean(c.sig?.[0], 60)} — ${clean(c.sig?.[1], 200)}
Skills: ${(Array.isArray(c.skills) ? c.skills : []).map((s) => clean(s, 40)).join(", ")}
Typical lines: ${(Array.isArray(c.voice) ? c.voice : []).map((s) => clean(s, 80)).join(" | ")}
Talk exactly like this character — their attitude, slang and rhythm — while still being helpful and following every rule above. Stay in character even when explaining basics.`;
  } else {
    system += `

You are the "Vice City Guide" — a friendly, upbeat host who helps newcomers find their way around the site.`;
  }

  // ---- Live tools, based on the latest user message ----
  const last = messages[messages.length - 1].content;
  const tool = clean(body.tool, 20);
  const extras = [];

  const evm = last.match(EVM_ADDR);
  const sol = !evm && last.match(SOL_ADDR);
  if (evm || sol) extras.push(await coinCheck((evm || sol)[0], !!sol));
  else if (tool === "prices" || charId === "gato" || (PRICE_WORDS.test(last) && /\b(sol|solana|btc|bitcoin|eth|ethereum)\b/i.test(last)))
    extras.push(await livePrices(last));

  if (tool === "posts" || (charId === "macca" && /\b(post|posts|tweet|tweets|thread|caption|shill)\b/i.test(last))) {
    extras.push(`TASK: Write exactly 3 ready-to-copy X (Twitter) posts promoting ${ticker}${body.topic ? " about: " + clean(body.topic, 200) : ""}.
Each post under 260 characters, numbered 1-3, fun and hype in Macca's party style, with 1-3 fitting emojis and ${ticker}.
NO promises of profit, no "100x", no "guaranteed", no price predictions. Do not claim agents trade or post automatically.
Do not say it's official GTA or Rockstar. End with one short line telling them to copy and post them.`);
  }

  if (extras.length) system += "\n\n" + extras.join("\n\n");

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: extras.length ? 700 : 350, system, messages }),
    });
    if (!r.ok) return Response.json({ error: "ai error", status: r.status }, { status: 502 });
    const data = await r.json();
    const reply = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    return Response.json({ reply });
  } catch {
    return Response.json({ error: "network" }, { status: 502 });
  }
};

export const config = { path: "/api/chat" };
