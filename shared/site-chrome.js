/*
 * m3xi.com — the shared header and footer's behaviour.
 *
 * The Help menu is a <details>, so it opens and closes with no script. This
 * only adds what people expect of a menu on top: Escape closes it and hands
 * focus back to Help, and a click or tab outside it closes it. It also sets
 * the footer's year. Bundled by Vite from every root page (no inline script),
 * so it runs under `script-src 'self'`.
 */
(function () {
  var drops = Array.prototype.slice.call(document.querySelectorAll('details.m3-drop'));

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
})();
