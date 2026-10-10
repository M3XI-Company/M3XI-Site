/*
 * m3xi.com — Google ads in the side margins of the Help page (/questions/).
 *
 * OFF until Google approves the site. Switching on is this one object: set
 * `enabled: true` and paste the two ad-unit ids from AdSense into `slots`.
 * docs/ADS_SWITCH_ON.md has the whole checklist, including the privacy page.
 *
 *   enabled: false   nothing happens. The rails in questions/index.html stay
 *                    `hidden`, no Google script is requested, no cookie is set.
 *   enabled: true    each rail whose slot id is filled in gets one ad unit; a
 *                    rail with an empty slot id stays hidden. If neither has an
 *                    id, the Google script is never requested.
 *
 * Ads are only for wide screens. The rails sit in the empty margins either
 * side of the page's 1100px column, and questions/index.html shows them only
 * where they fit without touching it (1520px and up; 300px-wide units from
 * 1800px). Below that this file does nothing at all: a phone or tablet never
 * downloads the Google script, so it never sees an ad or a consent message.
 * A window that starts narrow and is widened later gets its ads then.
 *
 * CONSENT is Google's own certified consent message (AdSense, "Privacy &
 * messaging"), which adsbygoogle.js shows in the UK and EEA before any ad
 * cookie is set. There is deliberately no banner of ours: a second one would
 * ask the same question twice and could disagree with Google's.
 *
 * Bundled by Vite from questions/index.html (no inline script), so it runs
 * under `script-src 'self'`. It adds the Google script with createElement,
 * which a nonce-based 'strict-dynamic' policy trusts by itself.
 *
 * The switch is a window property, the way site-chrome.js keeps
 * M3XI_APPSTORE, and not a plain constant on purpose: Rollup can prove a
 * constant `enabled: false` makes everything below dead code and deletes the
 * whole file from the build, so the live page would carry no trace of the
 * wiring until the day it is switched on. Kept like this, the loader ships
 * (about 1 kB), does nothing, and can be checked in production beforehand.
 */
window.M3XI_ADS = {
  enabled: false,
  client: 'ca-pub-3432976752504337',
  slots: { left: '', right: '' }
};

(function () {
  var ADS = window.M3XI_ADS || {};
  // Shapes Google issues: ca-pub- and 16 digits; a slot id is digits only. Anything
  // else is a typo, and a typo should leave the margin empty, not request ads
  // for somebody else's account or draw a box Google will never fill.
  var CLIENT = /^ca-pub-\d{16}$/;
  var SLOT = /^\d{6,20}$/;
  var SCRIPT = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=';

  if (!ADS.enabled || !CLIENT.test(ADS.client)) return;

  var rails = Array.prototype.slice.call(document.querySelectorAll('[data-ad-rail]'))
    .filter(function (rail) {
      return SLOT.test(String((ADS.slots || {})[rail.getAttribute('data-ad-rail')] || ''));
    });
  if (!rails.length) return;

  // Un-hiding is not the same as showing: the page's CSS still keeps a rail at
  // display:none below the breakpoint, so on a narrow screen this draws nothing.
  // The label stays invisible until Google says the unit is filled (see watch()).
  rails.forEach(function (rail) {
    rail.setAttribute('data-ad-state', 'waiting');
    rail.hidden = false;
  });

  var requested = false;
  function loadScript() {
    if (requested) return;
    requested = true;
    if (document.querySelector('script[src^="' + SCRIPT + '"]')) return;
    var s = document.createElement('script');
    s.async = true;
    s.crossOrigin = 'anonymous';
    s.src = SCRIPT + encodeURIComponent(ADS.client);
    // Carry a page nonce across if one is ever set, so a nonce policy without
    // 'strict-dynamic' still lets the script through.
    var withNonce = document.querySelector('script[nonce]');
    if (withNonce && withNonce.nonce) s.nonce = withNonce.nonce;
    // Blocked (an ad blocker, a firewall): fold the rails away again rather
    // than leave a labelled margin with nothing under it.
    s.addEventListener('error', function () {
      rails.forEach(function (rail) { rail.hidden = true; });
    });
    document.head.appendChild(s);
  }

  // Google marks each unit data-ad-status="filled" or "unfilled" once it has
  // decided. Filled shows the label; unfilled folds the rail away, because an
  // "Advertisements" label over an empty margin is exactly the empty box this
  // file exists to avoid.
  function watch(rail, ins) {
    function apply() {
      var status = ins.getAttribute('data-ad-status');
      if (status === 'filled') rail.setAttribute('data-ad-state', 'filled');
      else if (status === 'unfilled') rail.hidden = true;
    }
    if (window.MutationObserver) {
      new MutationObserver(apply).observe(ins, { attributes: true, attributeFilter: ['data-ad-status'] });
    }
    apply();
  }

  function fill() {
    var pending = 0;
    rails.forEach(function (rail) {
      if (rail.hasAttribute('data-ad-filled')) return;
      // offsetWidth is 0 while the CSS hides the rail: too narrow, so no ad,
      // and no request. A responsive unit pushed while hidden also errors.
      if (!rail.offsetWidth) { pending++; return; }
      var box = rail.querySelector('.ad-slot');
      if (!box) return;
      var ins = document.createElement('ins');
      ins.className = 'adsbygoogle';
      // Google's own snippet sets this inline; the size (160x600 or 300x600)
      // comes from the page's CSS for the width of the screen.
      ins.style.display = 'inline-block';
      ins.setAttribute('data-ad-client', ADS.client);
      ins.setAttribute('data-ad-slot', String(ADS.slots[rail.getAttribute('data-ad-rail')]));
      box.appendChild(ins);
      rail.setAttribute('data-ad-filled', '');
      watch(rail, ins);
      loadScript();
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    });
    if (!pending) window.removeEventListener('resize', onResize);
  }

  var timer = 0;
  function onResize() {
    clearTimeout(timer);
    timer = setTimeout(fill, 250);
  }
  window.addEventListener('resize', onResize);
  fill();
})();
