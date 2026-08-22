/* M3XI property tour embed.
   Paste on a listing page:
   <script src="https://www.m3xi.com/tour/embed.js" data-tour="<slug>" async></script>
   It replaces itself with a responsive 16:9 frame holding the tour. No dependencies. */
(function () {
  var me = document.currentScript;
  if (!me) {
    var all = document.getElementsByTagName('script');
    for (var i = all.length - 1; i >= 0; i--) if (all[i].getAttribute('data-tour') && /\/tour\/embed\.js/.test(all[i].src || '')) { me = all[i]; break; }
  }
  if (!me) return;
  var slug = (me.getAttribute('data-tour') || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,120}$/.test(slug)) return;
  var vk = (me.getAttribute('data-key') || '').trim();
  var ratio = parseFloat(me.getAttribute('data-ratio')) || (9 / 16);

  var src = 'https://www.m3xi.com/tour/?t=' + encodeURIComponent(slug) + '&embed=1' + (vk ? '&vk=' + encodeURIComponent(vk) : '');
  var box = document.createElement('div');
  box.className = 'm3xi-tour';
  box.style.cssText = 'position:relative;width:100%;max-width:100%;padding-top:' + (ratio * 100) + '%;background:#161512;overflow:hidden';
  var f = document.createElement('iframe');
  f.src = src;
  f.title = 'Property tour';
  f.loading = 'lazy';
  f.setAttribute('allow', 'accelerometer; gyroscope; fullscreen');
  f.setAttribute('allowfullscreen', '');
  f.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
  f.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;display:block';
  box.appendChild(f);
  if (me.parentNode) me.parentNode.insertBefore(box, me);
})();
