import "jsr:@supabase/functions-js/edge-runtime.d.ts";
// Stripe Checkout landing. verify_jwt is intentionally off: Stripe redirects the
// customer's browser here, and a browser arriving from Stripe carries no JWT.
//
// Nothing here trusts the redirect. The session is re-fetched from Stripe with
// the secret key and only credited when Stripe itself says payment_status is
// "paid" — landing on this URL proves nothing on its own, and the credit figure
// is read from the session metadata that m3ix-checkout set server-side, never
// from the query string.
//
// Signed-in buyer  → credits posted to their account ledger, then bounced back
//                    to the Studio where the new balance is already showing.
// Anonymous buyer  → the original credit-code flow, unchanged.

const text = (t: string, s = 200) => new Response(t, { status: s, headers: { "Content-Type": "text/plain; charset=utf-8" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function svcHeaders() {
  const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  return { apikey: svc, Authorization: `Bearer ${svc}`, "Content-Type": "application/json" };
}

function mintCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const b = crypto.getRandomValues(new Uint8Array(8));
  let s = "";
  for (const x of b) s += alphabet[x % alphabet.length];
  return `M3IX-${s.slice(0, 4)}-${s.slice(4)}`;
}

Deno.serve(async (req: Request) => {
  const u = new URL(req.url);
  if (u.searchParams.has("cancelled")) return text("Payment cancelled — nothing was charged.\n\nYou can close this tab.");
  const sid = u.searchParams.get("sid");
  if (!sid) return text("M3XI — nothing to see here.", 404);

  const sk = Deno.env.get("STRIPE_SECRET_KEY");
  const base = Deno.env.get("SUPABASE_URL");
  if (!sk || !base) return text("Server not configured.", 500);
  const site = (Deno.env.get("SITE_URL") ?? "https://www.m3xi.com").replace(/\/+$/, "");

  const sr = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sid)}`, {
    headers: { Authorization: `Bearer ${sk}` },
  });
  const session = await sr.json();
  if (!sr.ok) return text("Could not verify this payment session.", 400);
  if (session.payment_status !== "paid") return text("Payment not completed yet.\n\nIf you just paid, refresh this page in a few seconds.");

  const credits = Number(session.metadata?.m3ix_credits ?? 0);
  if (!credits) return text("Paid session has no credit metadata — contact support.", 400);
  const uid = String(session.metadata?.m3ix_user ?? "");

  // ---- signed-in buyer: post to the ledger --------------------------------
  if (UUID.test(uid)) {
    // Idempotent on the Stripe session id. This page gets refreshed, and Stripe
    // itself can redirect more than once; without this a reload would be free
    // credits.
    const seen = await (await fetch(
      `${base}/rest/v1/m3ix_credit_ledger?ref=eq.${encodeURIComponent(sid)}&reason=eq.purchase&select=id`,
      { headers: svcHeaders() },
    )).json();
    if (!(Array.isArray(seen) && seen.length)) {
      const ins = await fetch(`${base}/rest/v1/m3ix_credit_ledger`, {
        method: "POST",
        headers: { ...svcHeaders(), Prefer: "return=minimal" },
        body: JSON.stringify({ user_id: uid, delta: credits, reason: "purchase", ref: sid }),
      });
      if (!ins.ok) {
        return text(`Payment received, but the credits could not be added automatically.\n\nQuote this reference to support: ${sid}`, 500);
      }
    }
    /* Paying is what earns the referrer their discount — not signing up, which
       costs nothing and would make the scheme farmable with throwaway
       addresses. Service role: a browser that could call this could mint
       discounts for itself. */
    try {
      await fetch(`${base}/rest/v1/rpc/m3ix_reward_referrer`, {
        method: "POST", headers: svcHeaders(),
        body: JSON.stringify({ p_referee: uid, p_pct: 15 }),
      });
    } catch { /* the payment already succeeded; a missed reward is recoverable */ }

    return new Response(null, {
      status: 303,
      headers: { Location: `${site}/studio/?paid=${credits}#account` },
    });
  }

  // ---- anonymous buyer: the original code flow ----------------------------
  const existing = await (await fetch(`${base}/rest/v1/m3ix_credit_codes?stripe_session_id=eq.${encodeURIComponent(sid)}&select=code,credits_total,credits_used`, { headers: svcHeaders() })).json();
  let code: string, total: number, used = 0;
  if (Array.isArray(existing) && existing[0]) {
    code = existing[0].code; total = existing[0].credits_total; used = existing[0].credits_used;
  } else {
    code = mintCode(); total = credits;
    const ins = await fetch(`${base}/rest/v1/m3ix_credit_codes`, {
      method: "POST",
      headers: { ...svcHeaders(), Prefer: "return=minimal" },
      body: JSON.stringify({ code, credits_total: credits, stripe_session_id: sid }),
    });
    if (!ins.ok) {
      const re = await (await fetch(`${base}/rest/v1/m3ix_credit_codes?stripe_session_id=eq.${encodeURIComponent(sid)}&select=code,credits_total,credits_used`, { headers: svcHeaders() })).json();
      if (Array.isArray(re) && re[0]) { code = re[0].code; total = re[0].credits_total; used = re[0].credits_used; }
      else return text("Could not issue your code — refresh this page.", 500);
    }
  }

  return text(
`M3XI — payment received. Thank you!

YOUR CREDIT CODE:

    ${code}

Credits: ${total - used} available

Keep this code safe: it IS your balance, and it is the only copy.

Better: open ${site}/studio/#account, sign in, and paste the code in to move
these credits onto your account. Then there is no code to lose.`);
});
