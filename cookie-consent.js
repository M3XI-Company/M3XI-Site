(function initCookieConsent() {
  const CONSENT_KEY = "m3xi_cookie_consent_v1";

  try {
    if (window.localStorage.getItem(CONSENT_KEY) === "accepted") {
      return;
    }
  } catch {
    // If storage is unavailable, continue to show banner.
  }

  const banner = document.createElement("aside");
  banner.className = "cookie-banner";
  banner.setAttribute("role", "dialog");
  banner.setAttribute("aria-live", "polite");
  banner.innerHTML = `
    <p class="cookie-text">
      This page uses cookies to improve your experience.
      <a href="/privacy.html">Learn more</a>
    </p>
    <div class="cookie-actions">
      <button class="cookie-btn" type="button">Got it</button>
    </div>
  `;

  document.body.appendChild(banner);
  requestAnimationFrame(() => banner.classList.add("is-visible"));

  const acknowledgeBtn = banner.querySelector(".cookie-btn");
  acknowledgeBtn?.addEventListener("click", () => {
    try {
      window.localStorage.setItem(CONSENT_KEY, "accepted");
    } catch {
      // No-op if storage cannot be written.
    }
    banner.classList.remove("is-visible");
    setTimeout(() => banner.remove(), 220);
  });
})();
