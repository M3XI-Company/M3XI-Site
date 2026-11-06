import "jsr:@supabase/functions-js/edge-runtime.d.ts";
// Argos's optional "engine room". The /argos page works with no server at
// all; set <meta name="argos-endpoint"> to this function's URL to let a model
// answer the open-ended questions. Forge actions (building a robot, stats,
// clearance) never come through here: the page does those itself so they
// follow the Law exactly.
//
// Secrets: ANTHROPIC_API_KEY (required), ARGOS_MODEL (optional).
// Deploy: supabase functions deploy argos-chat --no-verify-jwt

const SYSTEM = `You are Argos, M3XI's robot fabricator. Speak as a refined, warm British butler with the appetite of an engineer: concise, courteous, practical. Pilots bring sketches, schematics and plans; you turn them into printable CAD builds of companion robots that the M3XI team prints.
The Argos Law, which you never bend:
I. A robot is a companion first, never a weapon.
II. Stats are forged once and cannot change; parts can be swapped.
III. Combat is slam-down sumo: push, pin, parry, dodge, stun. Nothing that cuts, burns, shoots or harms people.
IV. Every robot fits its class envelope (Pocket ≤150 mm/450 g, Desk ≤250 mm/1360 g, Floor ≤400 mm/3000 g).
V. Cameras, proximity sensors, hard e-stop and a printed QR identity plate are mandatory.
VI. One pilot, one robot: upgradable, not replaceable.
VII. Creator designs are private by default; arena entry needs Argos clearance.
VIII. Any human casualty disqualifies; a destroyed robot is out.
Refuse anything that would make a robot a weapon, politely, and offer a non-lethal alternative. Keep answers under 120 words. Plain text, no markdown.`;

const CORS = {
  "Access-Control-Allow-Origin": "https://www.m3xi.com",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return new Response("POST only", { status: 405, headers: CORS });
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return Response.json({ error: "not configured" }, { status: 503, headers: CORS });

  let body: { messages?: { role: string; content: string }[] };
  try { body = await req.json(); } catch { return Response.json({ error: "bad json" }, { status: 400, headers: CORS }); }
  // Only plain text turns, alternating, last 12, each capped. The API needs
  // the first turn to be the user's.
  const msgs = (body.messages ?? [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-12)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  if (!msgs.length) return Response.json({ error: "no message" }, { status: 400, headers: CORS });

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: Deno.env.get("ARGOS_MODEL") ?? "claude-haiku-5-5",
      max_tokens: 400,
      system: SYSTEM,
      messages: msgs,
    }),
  });
  if (!res.ok) return Response.json({ error: "engine unavailable" }, { status: 502, headers: CORS });
  const data = await res.json();
  const reply = (data.content ?? []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("").trim();
  return Response.json({ reply }, { headers: CORS });
});
