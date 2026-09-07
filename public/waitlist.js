/* M3XI shared waitlist — one script, one table, a separate list per product.
   Rows land in public.m3ix_waitlist on the M3XI-Studio Supabase project, keyed
   on (email, product), so the same address can join every product once and a
   second attempt is a clean "already on the list", never a second row.

   Usage:
     <form class="m3xi-waitlist" data-product="cornelia|callme|autouv|ai-stories|ugc|studio|spatial">
       <input name="email" type="email" required />
       [<input name="name" type="text" />]
       [honeypot: <input name="company" />]         (bots fill it; humans never see it)
       <button type="submit">…</button>
       <p class="wl-msg" aria-live="polite"></p>
     </form>

   Optional data-label="AI Stories" overrides the product name in messages.
   The publishable key can INSERT and nothing else (RLS + grants), so it is
   safe in a public repo. */
(function () {
  var SB_URL = "https://tnlcuptfldwxtxajudoq.supabase.co";
  var SB_KEY = "sb_publishable_9_QupB72Lwr4GnP2dhW0bg_TTLT_uiJ";
  var TABLE = "m3ix_waitlist";
  var PRODUCTS = {
    cornelia: "Cornelia",
    callme: "CallMe",
    autouv: "AutoUV",
    "ai-stories": "AI Stories",
    ugc: "UGC Studio",
    studio: "M3XI Studio",
    spatial: "M3XI Spatial"
  };
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function setMsg(el, text, kind) {
    if (!el) return;
    el.textContent = text || "";
    el.classList.remove("ok", "err");
    if (kind) el.classList.add(kind);
  }

  function utm() {
    var q = new URLSearchParams(location.search), out = {};
    ["utm_source", "utm_medium", "utm_campaign", "ref"].forEach(function (k) {
      var v = q.get(k); if (v) out[k] = v.slice(0, 80);
    });
    return out;
  }

  function handle(form) {
    var product = (form.getAttribute("data-product") || "").toLowerCase();
    if (!PRODUCTS[product]) return;
    var label = form.getAttribute("data-label") || PRODUCTS[product];
    var busy = false;

    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      if (busy) return;

      var emailEl = form.querySelector('input[name="email"]');
      var nameEl = form.querySelector('input[name="name"]');
      var hpEl = form.querySelector('input[name="company"]');
      var btn = form.querySelector('button[type="submit"]');
      var msg = form.querySelector(".wl-msg");

      // Honeypot: quietly pretend success for bots.
      if (hpEl && hpEl.value) {
        setMsg(msg, "You're on the list — see you soon!", "ok");
        form.reset();
        return;
      }

      var email = ((emailEl && emailEl.value) || "").trim().toLowerCase();
      if (!EMAIL_RE.test(email)) {
        setMsg(msg, "Please enter a valid email address.", "err");
        if (emailEl) emailEl.focus();
        return;
      }

      var payload = {
        email: email,
        product: product,
        source: "website",
        metadata: Object.assign({ page: location.pathname, ref: document.referrer || null }, utm())
      };
      var name = ((nameEl && nameEl.value) || "").trim();
      if (name) payload.name = name.slice(0, 120);

      var original = btn ? btn.textContent : "";
      busy = true;
      if (btn) { btn.disabled = true; btn.textContent = "Adding you…"; }
      setMsg(msg, "");

      try {
        var res = await fetch(SB_URL + "/rest/v1/" + TABLE, {
          method: "POST",
          headers: {
            apikey: SB_KEY,
            Authorization: "Bearer " + SB_KEY,
            "Content-Type": "application/json",
            Prefer: "return=minimal"
          },
          body: JSON.stringify(payload)
        });

        if (res.ok) {
          setMsg(msg, "You're on the " + label + " waitlist. We'll email you when it's your turn.", "ok");
          form.reset();
          form.dispatchEvent(new CustomEvent("m3xi:waitlist", { detail: { product: product, duplicate: false } }));
        } else if (res.status === 409) {
          // unique (email, product): this address already holds a place on THIS list.
          setMsg(msg, "Good news — you're already on the " + label + " waitlist.", "ok");
          form.dispatchEvent(new CustomEvent("m3xi:waitlist", { detail: { product: product, duplicate: true } }));
        } else if (res.status === 400) {
          setMsg(msg, "That email didn't pass our check — please look it over and try again.", "err");
        } else {
          setMsg(msg, "Something went wrong. Please try again, or email support@m3xi.com.", "err");
        }
      } catch (err) {
        setMsg(msg, "Couldn't reach the waitlist. Check your connection and try again.", "err");
      } finally {
        busy = false;
        if (btn) { btn.disabled = false; btn.textContent = original; }
      }
    });
  }

  function init() {
    document.querySelectorAll("form.m3xi-waitlist").forEach(handle);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
