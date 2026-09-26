/*
 * m3xi.com — the shared header and footer's behaviour, and the store badges.
 *
 * The Help menu is a <details>, so it opens and closes with no script. This
 * only adds what people expect of a menu on top: Escape closes it and hands
 * focus back to Help, and a click or tab outside it closes it. It also sets
 * the footer's year. Bundled by Vite from every root page (no inline script),
 * so it runs under `script-src 'self'`.
 *
 * STORE BADGES. CallMe is on Google Play; the App Store listing is in review.
 * Every App Store badge on the site follows the ONE flag below:
 *
 *   live: false  every [data-store="appstore"] is a plain card (a <span>, not
 *                a link) that says "Coming soon to the App Store".
 *   live: true   every one becomes a real link to `url`, the header's
 *                "Get CallMe" opens the App Store on an iPhone or iPad, and
 *                copy marked data-appstore="soon" hides while copy marked
 *                data-appstore="live" shows.
 *
 * Flip it on release day and every page that loads this script follows. Three
 * places cannot follow a flag, so change them by hand in the same push:
 *
 *   questions/index.html      the JSON-LD answer to "Is CallMe on iPhone?"
 *                             (search engines read it without running script;
 *                             the visible answer below it already switches).
 *   public/invite/index.html  the #iosHint sentence, and the line that hides
 *                             "Open CallMe" on an iPhone. Served as-is from
 *                             public/, so it never loads this file.
 *   public/p/p.js             hides "Get CallMe" on an iPhone because there
 *                             was no App Store listing; point it there instead.
 *
 * `grep -rn -i "app store" --include=*.html --include=*.js .` finds any more.
 *
 * SCREENSHOTS. Every .cm-phone picture on every page also gets its fallback
 * here (see the end of this file): a missing -720.webp falls back to the PNG,
 * and a missing PNG shows "Screenshot on its way" instead of a broken image.
 */
window.M3XI_APPSTORE = { live: false, url: 'https://apps.apple.com/app/id6811338775' };

var PLAY_URL = 'https://play.google.com/store/apps/details?id=com.m3xi.callme';

(function () {
  function all(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  /* ── Help menu ─────────────────────────────────────────────────────────── */

  var drops = all('details.m3-drop');

  document.addEventListener('click', function (e) {
    drops.forEach(function (d) {
      if (d.open && !d.contains(e.target)) d.open = false;
    });
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    drops.forEach(function (d) {
      if (!d.open) return;
      var inside = d.contains(document.activeElement);
      d.open = false;
      if (inside) {
        var s = d.querySelector('summary');
        if (s) s.focus();
      }
    });
  });

  drops.forEach(function (d) {
    d.addEventListener('focusout', function (e) {
      if (d.open && e.relatedTarget && !d.contains(e.relatedTarget)) d.open = false;
    });
  });

  var year = document.getElementById('year');
  if (year) year.textContent = String(new Date().getFullYear());

  /* ── Store badges ──────────────────────────────────────────────────────── */

  var app = window.M3XI_APPSTORE || {};
  var appLive = !!(app.live && typeof app.url === 'string' && /^https:\/\/apps\.apple\.com\//.test(app.url));
  var isApple = /iPhone|iPad|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  document.documentElement.setAttribute('data-appstore-state', appLive ? 'live' : 'soon');

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  }

  // Swap an element for one with a different tag, keeping its classes, data-
  // and aria- attributes, id and style (but not href, rel or target).
  function retag(node, tag) {
    if (node.tagName.toLowerCase() === tag) return node;
    var fresh = document.createElement(tag);
    Array.prototype.forEach.call(node.attributes, function (a) {
      if (!/^(href|rel|target|role|tabindex|aria-disabled|download|ping|referrerpolicy|type)$/i.test(a.name)) {
        fresh.setAttribute(a.name, a.value);
      }
    });
    node.parentNode.replaceChild(fresh, node);
    return fresh;
  }

  function renderStore(node, o) {
    node = retag(node, o.href ? 'a' : 'span');
    if (o.href) {
      node.setAttribute('href', o.href);
      node.setAttribute('rel', 'noopener');
    }
    node.classList.add('cm-store');
    node.classList.toggle('cm-store--soon', !o.href);
    while (node.firstChild) node.removeChild(node.firstChild);

    var ico = el('span', 'cm-store-ico');
    ico.setAttribute('aria-hidden', 'true');
    ico.appendChild(el('i', 'cm-ico cm-ico--' + o.icon));
    var txt = el('span', 'cm-store-txt');
    txt.appendChild(el('small', '', o.small));
    txt.appendChild(document.createTextNode(' '));
    txt.appendChild(el('b', '', o.name));
    node.appendChild(ico);
    node.appendChild(txt);
    if (!o.href) {
      var stamp = el('span', 'cm-rubber', 'Soon');
      stamp.setAttribute('aria-hidden', 'true');
      node.appendChild(stamp);
    }
  }

  // Every page gets the two cards under the footer's logo, so "coming soon to
  // the App Store" reads the same everywhere, unless the page has its own.
  var footBrand = document.querySelector('.m3-foot .m3-footin > div:first-child');
  if (footBrand && !document.querySelector('.m3-foot [data-store]')) {
    var row = el('div', 'cm-stores');
    var play = el('a', 'cm-store cm-store--sm');
    play.setAttribute('data-store', 'play');
    var ios = el('span', 'cm-store cm-store--sm');
    ios.setAttribute('data-store', 'appstore');
    row.appendChild(play);
    row.appendChild(ios);
    footBrand.appendChild(row);
  }

  all('[data-store="play"]').forEach(function (n) {
    renderStore(n, { href: PLAY_URL, icon: 'play', small: 'Get it on', name: 'Google Play' });
  });

  all('[data-store="appstore"]').forEach(function (n) {
    renderStore(n, appLive
      ? { href: app.url, icon: 'handset', small: 'Download on the', name: 'App Store' }
      : { href: '', icon: 'handset', small: 'Coming soon to the', name: 'App Store' });
  });

  // "Get CallMe" links (the header's, and any marked data-store="auto") go to
  // Google Play, and to the App Store on Apple devices once it is live.
  if (appLive && isApple) {
    all('.m3-get, [data-store="auto"]').forEach(function (a) {
      if (a.tagName.toLowerCase() === 'a') a.setAttribute('href', app.url);
    });
  }

  all('[data-appstore="soon"]').forEach(function (n) { n.hidden = appLive; });
  all('[data-appstore="live"]').forEach(function (n) { n.hidden = !appLive; });

  /* ── Screenshots ───────────────────────────────────────────────────────── */

  // An app screenshot is a 1080x2400 PNG in a .cm-phone frame, and its srcset
  // offers a 720px-wide WebP copy (tools/callme-shots.py makes them) so a phone
  // does not pull the full PNG. If the WebP is missing, dropping the srcset
  // sends the browser back to the PNG; if the PNG is missing too, the frame is
  // marked is-empty and site-chrome.css draws paper and the dog in it.
  function shotBroken(img) {
    if (img.hasAttribute('srcset')) {
      img.addEventListener('error', function () { shotBroken(img); }, { once: true });
      img.removeAttribute('srcset');
      img.removeAttribute('sizes');
      return;
    }
    var frame = img.closest('.cm-phone');
    if (frame) frame.classList.add('is-empty');
  }

  all('.cm-phone img').forEach(function (img) {
    // A lazy image not fetched yet is not `complete`, so this only catches a
    // picture that failed before this module ran; the listener catches the rest.
    if (img.complete && img.naturalWidth === 0 && img.getAttribute('src')) shotBroken(img);
    else img.addEventListener('error', function () { shotBroken(img); }, { once: true });
  });

  /* ── Handwriting font ──────────────────────────────────────────────────── */

  // Captions are written in Caveat. A page should load it in its <head>; this
  // is the safety net for one that uses the handwriting and forgot.
  if (document.querySelector('.cm-hand, .cm-polaroid')
      && !document.querySelector('link[href*="family=Caveat"]')) {
    var font = document.createElement('link');
    font.rel = 'stylesheet';
    font.href = 'https://fonts.googleapis.com/css2?family=Caveat:wght@500;600&display=swap';
    document.head.appendChild(font);
  }
})();
