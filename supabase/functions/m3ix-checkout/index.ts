import "jsr:@supabase/functions-js/edge-runtime.d.ts";
// Creates a Stripe Checkout session for an M3XI credit pack.
//
// If the buyer is signed in, their user id rides along in the session metadata
// so the credits can be posted straight to their account ledger after payment.
// If they are not, the old anonymous credit-code path still works — nobody is
// forced to make an account in order to pay.

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const PACKS: Record<string, { amount: number; credits: number; name: string }> = {
  starter: { amount: 500, credits: 100, name: "M3XI — 100 credits" },
  creator: { amount: 2000, credits: 450, name: "M3XI — 450 credits" },
  pro: { amount: 4500, credits: 1150, name: "M3XI — 1,150 credits" },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Who is buying? Returns null for an anonymous buyer, which is allowed. */
async function callerId(req: Request): Promise<string | null> {
  const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const base = Deno.env.get("SUPABASE_URL") ?? "";
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  // The site calls this with the anon key when signed out; that is not a user.
  if (!token || !base || token === anon) return null;
  try {
    const r = await fetch(`${base}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: anon },
    });
    if (!r.ok) return null;
    const u = await r.json();
    return UUID.test(String(u?.id ?? "")) ? String(u.id) : null;
  } catch {
    return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const sk = Deno.env.get("STRIPE_SECRET_KEY");
  if (!sk) return json({ error: "STRIPE_SECRET_KEY secret is not set in this project." }, 500);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const pack = PACKS[String(body.pack ?? "")];
  if (!pack) return json({ error: "Unknown pack. Use starter | creator | pro" }, 400);

  const uid = await callerId(req);

  /* An affiliate discount is read AND cleared server-side before the price is
     set, so the amount Stripe is told to charge is never influenced by the
     browser. Clearing as we read is what stops the same discount being spent
     from two checkout tabs. */
  let discountPct = 0;
  if (uid) {
    try {
      const dr = await fetch(`${Deno.env.get("SUPABASE_URL")}/rest/v1/rpc/m3ix_take_discount`, {
        method: "POST",
        headers: {
          apikey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
          Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ p_user: uid }),
      });
      if (dr.ok) discountPct = Math.max(0, Math.min(50, Number(await dr.json()) || 0));
    } catch { discountPct = 0; }
  }
  const amount = Math.max(50, Math.round(pack.amount * (1 - discountPct / 100)));

  const thanks = `${Deno.env.get("SUPABASE_URL")}/functions/v1/m3ix-thanks`;
  const form = new URLSearchParams();
  form.set("mode", "payment");
  form.set("success_url", `${thanks}?sid={CHECKOUT_SESSION_ID}`);
  form.set("cancel_url", `${thanks}?cancelled=1`);
  form.set("line_items[0][quantity]", "1");
  form.set("line_items[0][price_data][currency]", "gbp");
  form.set("line_items[0][price_data][unit_amount]", String(amount));
  form.set("line_items[0][price_data][product_data][name]", pack.name + (discountPct ? ` (−${discountPct}% referral)` : ""));
  form.set("metadata[m3ix_credits]", String(pack.credits));
  // The amount of credits is set HERE, server-side, from a fixed table — never
  // taken from the request. A client that could name its own credit figure
  // could buy 100 credits and be granted a million.
  if (uid) form.set("metadata[m3ix_user]", uid);

  const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${sk}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const s = await r.json();
  if (!r.ok) return json({ error: `stripe ${r.status}: ${s?.error?.message ?? "unknown"}` }, 502);
  return json({
    discount_pct: discountPct,
    url: s.url,
    mode: String(s.id ?? "").startsWith("cs_test") ? "test" : "live",
    to_account: !!uid,
  });
});
