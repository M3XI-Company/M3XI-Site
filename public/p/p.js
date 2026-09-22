/* m3xi.com/p/<code> — where a phone camera lands.
   Kept out of the page so /p/ can ship script-src 'self'.

   The only thing this page does is hand the code to the app. It never talks
   to the server, so a scanned code is not spent by looking at it, and it can
   say nothing about whose session it is. */
(function () {
  var ALPHABET = /^[A-Z2-9]{10}$/;

  function codeFromUrl() {
    var path = (location.pathname || '').replace(/\/+$/, '');
    var last = path.slice(path.lastIndexOf('/') + 1);
    var guess = decodeURIComponent(last || '').toUpperCase();
    if (ALPHABET.test(guess)) return guess;
    // A camera app that kept the query rather than the path.
    var q = new URLSearchParams(location.search).get('c');
    q = (q || '').toUpperCase();
    return ALPHABET.test(q) ? q : '';
  }

  function pretty(c) {
    return [c.slice(0, 4), c.slice(4, 8), c.slice(8, 10)].filter(Boolean).join(' ');
  }

  var code = codeFromUrl();
  var $code = document.getElementById('code');
  var $open = document.getElementById('open');
  var $head = document.getElementById('head');
  var $lede = document.getElementById('lede');
  var $foot = document.getElementById('foot');

  if (!code) {
    $head.textContent = 'That is not a CallMe code';
    $lede.textContent = 'The link is missing its code, or it has been typed slightly wrong. Go back to the page you scanned it from and use the fresh one.';
    $code.textContent = '— — —';
    $open.setAttribute('href', 'callme://poster');
    $open.textContent = 'Open CallMe anyway';
    $foot.textContent = 'Codes are ten letters and numbers, and they only last a few minutes.';
    return;
  }

  $code.textContent = pretty(code);
  $code.setAttribute('aria-label', 'Your code is ' + code.split('').join(' '));
  $open.setAttribute('href', 'callme://pair/' + code);
})();
