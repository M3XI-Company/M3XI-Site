/* M3XI shared waitlist — posts signups to Supabase.
   Usage: <form class="m3xi-waitlist" data-product="cornelia|autouv|callme">
     <input name="email" type="email" required />
     [<input name="name" type="text" />]
     [honeypot: <input name="company" />]
     <button type="submit">…</button>
     <p class="wl-msg" aria-live="polite"></p>
   </form>
*/
(function () {
  var SB_URL = "https://nfdegwfgrlikmmzakxqw.supabase.co";
  var SB_KEY = "sb_publishable_7ChibjJuhY73-E_PGHz1DA_Pq_SnsNT";
  var PRODUCTS = { cornelia: "Cornelia", autouv: "AutoUV", callme: "CallMe" };

  function setMsg(el, text, kind) {
    if (!el) return;
    el.textContent = text;
    el.classList.remove("ok", "err");
    if (kind) el.classList.add(kind);
  }

  function handle(form) {
    var product = (form.getAttribute("data-product") || "").toLowerCase();
    if (!PRODUCTS[product]) return;

    form.addEventListener("submit", async function (e) {
      e.preventDefault();

      var emailEl = form.querySelector('input[name="email"]');
      var nameEl = form.querySelector('input[name="name"]');
      var hpEl = form.querySelector('input[name="company"]');
      var btn = form.querySelector('button[type="submit"]');
      var msg = form.querySelector(".wl-msg");

      // Honeypot: quietly pretend success for bots
      if (hpEl && hpEl.value) {
        setMsg(msg, "You're on the list — see you soon!", "ok");
        form.reset();
        return;
      }

      var email = (emailEl && emailEl.value || "").trim();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        setMsg(msg, "Please enter a valid email address.", "err");
        if (emailEl) emailEl.focus();
        return;
      }

      var payload = {
        email: email.toLowerCase(),
        product: product,
        source: "website",
        metadata: { page: location.pathname }
      };
      var name = (nameEl && nameEl.value || "").trim();
      if (name) payload.name = name.slice(0, 120);

      var original = btn ? btn.textContent : "";
      if (btn) { btn.disabled = true; btn.textContent = "Adding you…"; }
      setMsg(msg, "");

      try {
        var res = await fetch(SB_URL + "/rest/v1/waitlist", {
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
          setMsg(msg, "You're on the " + PRODUCTS[product] + " waitlist. We'll email you at launch!", "ok");
          form.reset();
        } else if (res.status === 409) {
          setMsg(msg, "Good news — you're already on the " + PRODUCTS[product] + " waitlist.", "ok");
        } else {
          setMsg(msg, "Something went wrong. Please try again, or email support@m3xi.com.", "err");
        }
      } catch (err) {
        setMsg(msg, "Couldn't reach the waitlist. Check your connection and try again.", "err");
      } finally {
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
