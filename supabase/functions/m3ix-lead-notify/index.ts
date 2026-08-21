import "jsr:@supabase/functions-js/edge-runtime.d.ts";

/* ===========================================================================
   Lead notification. Called by the m3ix_lead_notify database trigger (pg_net)
   on every insert into m3ix_leads, with the shared secret from m3ix_config.

   Finds who should hear about the lead — the agency behind a property tour,
   or the owner of an AI world — and emails them through Resend. If no email
   provider is configured, or delivery fails, the reason is written on the
   lead row (notify_error) so the dashboard can show it instead of hiding it.

   Secrets: RESEND_API_KEY (required to send), LEAD_FROM (optional sender,
   e.g. "M3XI Tours <leads@m3xi.com>" — the domain must be verified in Resend).
   =========================================================================== */

const BASE = () => Deno.env.get("SUPABASE_URL") ?? "";
function svc() {
  const k = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  return { apikey: k, Authorization: `Bearer ${k}`, "Content-Type": "application/json" };
}
async function db(path: string, init?: RequestInit) {
  const r = await fetch(`${BASE()}/rest/v1/${path}`, { ...init, headers: { ...svc(), ...(init?.headers ?? {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`db ${r.status}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}
const one = async (path: string) => (await db(path))?.[0] ?? null;
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

async function recipientsFor(lead: Record<string, unknown>): Promise<{ to: string[]; about: string; link: string }> {
  if (lead.property_id) {
    const prop = await one(`m3ix_property?id=eq.${lead.property_id}&select=org_id,address_line`);
    const members = prop ? await db(`m3ix_org_member?org_id=eq.${prop.org_id}&select=user_id`) : [];
    const ids = (members ?? []).map((m: { user_id: string }) => m.user_id);
    const accts = ids.length ? await db(`m3ix_accounts?user_id=in.(${ids.join(",")})&select=email`) : [];
    const tour = lead.tour_id ? await one(`m3ix_tour?id=eq.${lead.tour_id}&select=slug`) : null;
    return {
      to: (accts ?? []).map((a: { email?: string }) => a.email).filter(Boolean),
      about: prop?.address_line ? `${prop.address_line}` : "your property tour",
      link: tour?.slug ? `https://www.m3xi.com/tour/?t=${encodeURIComponent(tour.slug)}` : "https://www.m3xi.com/tours/",
    };
  }
  if (lead.space_id) {
    const sp = await one(`m3ix_spaces?id=eq.${lead.space_id}&select=owner_id,title,embed_slug`);
    const acct = sp?.owner_id ? await one(`m3ix_accounts?user_id=eq.${sp.owner_id}&select=email`) : null;
    return {
      to: acct?.email ? [acct.email] : [],
      about: sp?.title ? `your world "${sp.title}"` : "your world",
      link: sp?.embed_slug ? `https://www.m3xi.com/studio/walkthrough.html?world=${encodeURIComponent(sp.embed_slug)}` : "https://www.m3xi.com/studio/",
    };
  }
  return { to: [], about: "a tour", link: "https://www.m3xi.com/" };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const body = await req.json().catch(() => ({}));
  const lead_id = String(body.lead_id ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(lead_id)) return json({ error: "lead_id required" }, 400);

  // The trigger proves itself with the secret stored beside it in the database.
  const cfg = await one(`m3ix_config?key=eq.lead_notify_secret&select=value`);
  if (!cfg?.value || req.headers.get("x-m3ix-secret") !== cfg.value) return json({ error: "forbidden" }, 403);

  const lead = await one(`m3ix_leads?id=eq.${lead_id}&select=*`);
  if (!lead) return json({ error: "lead not found" }, 404);
  const mark = (patch: Record<string, unknown>) => db(`m3ix_leads?id=eq.${lead_id}`, { method: "PATCH", body: JSON.stringify(patch) });

  try {
    const { to, about, link } = await recipientsFor(lead);
    if (!to.length) { await mark({ notify_error: "no recipient: the agency has no account email" }); return json({ ok: false, reason: "no recipient" }); }
    const key = Deno.env.get("RESEND_API_KEY");
    if (!key) { await mark({ notify_error: "RESEND_API_KEY is not set — the lead is in your dashboard but no email was sent" }); return json({ ok: false, reason: "no provider" }); }
    const from = Deno.env.get("LEAD_FROM") || "M3XI Tours <onboarding@resend.dev>";
    const subject = `New enquiry — ${about}`;
    const html = `
      <div style="font-family:Segoe UI,system-ui,sans-serif;font-size:15px;line-height:1.6;color:#161512">
        <p><b>${esc(lead.name || "Someone")}</b> enquired from inside ${esc(about)}.</p>
        <p><b>Contact:</b> ${esc(lead.contact)}<br>
           ${lead.node_label ? `<b>Standing in:</b> ${esc(lead.node_label)}<br>` : ""}
           <b>Sent:</b> ${esc(new Date(String(lead.created_at)).toUTCString())}</p>
        ${lead.message ? `<p style="white-space:pre-wrap;border-left:3px solid #d0402b;padding-left:12px">${esc(lead.message)}</p>` : ""}
        <p><a href="${esc(link)}">Open the tour</a> · <a href="https://www.m3xi.com/tours/">All enquiries</a></p>
      </div>`;
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, subject, html, reply_to: /@/.test(String(lead.contact)) ? String(lead.contact) : undefined }),
    });
    const t = await r.text();
    if (!r.ok) { await mark({ notify_error: `email failed (${r.status}): ${t.slice(0, 200)}` }); return json({ ok: false, reason: "provider error" }, 502); }
    await mark({ notified_at: new Date().toISOString(), notify_error: null });
    return json({ ok: true, to: to.length });
  } catch (e) {
    await mark({ notify_error: `notify crashed: ${(e as Error).message.slice(0, 200)}` }).catch(() => {});
    return json({ error: (e as Error).message }, 500);
  }
});
