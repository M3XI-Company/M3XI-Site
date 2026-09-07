import "jsr:@supabase/functions-js/edge-runtime.d.ts";

/* =============================================================================
   M3XI WALLET — the founder's one page.

   Answers one question: is the provider balance being refilled by customers
   faster than the Studio is spending it? Reads the provider-spend log written
   by m3ix-generate, the credit ledger, the purchases table and the manual
   top-up log; returns the totals the panel draws. Admins only.
   ============================================================================= */

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const BASE = () => Deno.env.get("SUPABASE_URL") ?? "";
function svc() {
  const k = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  return { apikey: k, Authorization: `Bearer ${k}`, "Content-Type": "application/json" };
}
function adminEmails(): string[] {
  return (Deno.env.get("M3IX_ADMINS") ?? "admin@m3xi.com").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
}
/* Base pack rate, used only for purchases recorded before amount_pence existed. */
const PENCE_PER_CREDIT = Number(Deno.env.get("M3IX_PENCE_PER_CREDIT") ?? 4.5);
/* Pounds per dollar for the margin line. Env-overridable; roughly right is fine. */
const GBP_PER_USD = Number(Deno.env.get("M3IX_GBP_PER_USD") ?? 0.78);

async function caller(req: Request): Promise<{ id: string; email: string } | null> {
  const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token || token === anon) return null;
  const r = await fetch(`${BASE()}/auth/v1/user`, { headers: { Authorization: `Bearer ${token}`, apikey: anon } });
  if (!r.ok) return null;
  const u = await r.json();
  return u?.id ? { id: String(u.id), email: String(u?.email ?? "").toLowerCase() } : null;
}

async function rows(path: string): Promise<any[]> {
  const r = await fetch(`${BASE()}/rest/v1/${path}`, { headers: svc() });
  if (!r.ok) return [];
  const j = await r.json();
  return Array.isArray(j) ? j : [];
}
const sum = (a: any[], k: string) => a.reduce((t, r) => t + Number(r?.[k] ?? 0), 0);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const me = await caller(req);
  if (!me) return json({ error: "Sign in." }, 401);
  if (!adminEmails().includes(me.email)) return json({ error: "Not your wallet." }, 403);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* summary */ }
  const action = String(body.action ?? "summary");

  if (action === "topup") {
    const amount = Number(body.amount_usd);
    if (!(amount > 0)) return json({ error: "Amount in dollars, more than zero." }, 400);
    const r = await fetch(`${BASE()}/rest/v1/m3ix_wallet_topups`, {
      method: "POST", headers: { ...svc(), Prefer: "return=minimal" },
      body: JSON.stringify({ provider: String(body.provider ?? "fal").slice(0, 30), amount_usd: amount, note: String(body.note ?? "").slice(0, 200) || null }),
    });
    if (!r.ok) return json({ error: "Could not record the top-up." }, 500);
    // fall through to a fresh summary
  }

  const since30 = new Date(Date.now() - 30 * 864e5).toISOString();
  const [topups, spendAll, spend30, purchases, ledgerPaid, ledgerSpent30, workers, recent, jobs] = await Promise.all([
    rows(`m3ix_wallet_topups?select=provider,amount_usd,note,created_at&order=created_at.desc&limit=50`),
    rows(`m3ix_provider_spend?select=provider,cost_usd,credits,ok&ok=eq.true`),
    rows(`m3ix_provider_spend?select=kind,provider,cost_usd,credits&ok=eq.true&created_at=gte.${since30}`),
    rows(`m3ix_purchases?select=credits,amount_pence,created_at`),
    rows(`m3ix_credit_ledger?select=delta,reason,created_at&reason=in.(purchase,redeem)`),
    rows(`m3ix_credit_ledger?select=delta&delta=lt.0&created_at=gte.${since30}`),
    rows(`m3ix_workers?select=name,gpu,kinds,last_seen,jobs_done&order=last_seen.desc`),
    rows(`m3ix_provider_spend?select=kind,model,provider,credits,cost_usd,ok,created_at&order=created_at.desc&limit=40`),
    rows(`m3ix_jobs?select=status&status=in.(queued,running)`),
  ]);

  // Provider balance estimate: what we put in minus what we spent (fal only —
  // World Labs has its own balance; shown separately).
  const byProvider: Record<string, { in: number; out: number }> = {};
  for (const t of topups) { const p = t.provider ?? "fal"; byProvider[p] ??= { in: 0, out: 0 }; byProvider[p].in += Number(t.amount_usd); }
  for (const s of spendAll) { const p = s.provider ?? "fal"; if (p === "local") continue; byProvider[p] ??= { in: 0, out: 0 }; byProvider[p].out += Number(s.cost_usd); }

  // Revenue: real pence where we have it, estimated at the base rate otherwise.
  const knownPence = purchases.filter((p) => p.amount_pence != null);
  const revenuePence = sum(knownPence, "amount_pence") +
    (sum(purchases.filter((p) => p.amount_pence == null), "credits")) * PENCE_PER_CREDIT;
  // Ledger purchases predate m3ix_purchases; count those too, estimated.
  const ledgerCredits = sum(ledgerPaid, "delta");
  const purchaseCredits = sum(purchases, "credits");
  const extraCredits = Math.max(0, ledgerCredits - purchaseCredits);
  const revenueGbp = (revenuePence + extraCredits * PENCE_PER_CREDIT) / 100;

  const spend30Usd = sum(spend30.filter((s) => s.provider !== "local"), "cost_usd");
  const spend30Gbp = spend30Usd * GBP_PER_USD;
  const credits30 = -sum(ledgerSpent30, "delta");
  const revenue30Gbp = credits30 * PENCE_PER_CREDIT / 100;   // what those spent credits were sold for
  const margin30 = revenue30Gbp > 0 ? (revenue30Gbp - spend30Gbp) / revenue30Gbp : null;

  const byKind: Record<string, { credits: number; usd: number; n: number }> = {};
  for (const s of spend30) { const k = s.kind; byKind[k] ??= { credits: 0, usd: 0, n: 0 }; byKind[k].credits += Number(s.credits); byKind[k].usd += Number(s.cost_usd); byKind[k].n++; }

  const fal = byProvider["fal"] ?? { in: 0, out: 0 };
  const balance = fal.in - fal.out;
  const dailyBurn = spend30Usd / 30;
  const runwayDays = dailyBurn > 0 ? balance / dailyBurn : null;

  return json({
    balance_usd: balance, topped_up_usd: fal.in, spent_usd: fal.out,
    providers: byProvider,
    spend_30d_usd: spend30Usd, spend_30d_gbp: spend30Gbp,
    credits_spent_30d: credits30, revenue_30d_gbp: revenue30Gbp, margin_30d: margin30,
    revenue_all_gbp: revenueGbp, credits_sold_all: ledgerCredits,
    daily_burn_usd: dailyBurn, runway_days: runwayDays,
    by_kind_30d: byKind,
    workers, jobs_open: jobs.length,
    topups: topups.slice(0, 12), recent,
    rates: { pence_per_credit: PENCE_PER_CREDIT, gbp_per_usd: GBP_PER_USD },
    at: new Date().toISOString(),
  });
});
