/* m3xi.com/events — kept out of the page so /events/ can ship script-src self. */
(function () {
  // The CallMe project's public (anon) key: it can only call events_upcoming(),
  // which returns published events and their public fields. No table is readable.
  var URL_ = 'https://cwjspmhgspiavyzrtosl.supabase.co';
  var KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN3anNwbWhnc3BpYXZ5enJ0b3NsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM1MTI5NTQsImV4cCI6MjA5OTA4ODk1NH0.jhS5adiCcZFbfq5zRXQdRLN1k1hCOQ-Ft5ZhcLJO1zc';
  var $state = document.getElementById('state');
  var $list = document.getElementById('list');
  document.getElementById('year').textContent = new Date().getFullYear();

  /* Everything from the database is set as text, never as HTML. */
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') n.textContent = attrs[k];
      else if (k === 'class') n.className = attrs[k];
      else if (k.indexOf('on') === 0) n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] != null && attrs[k] !== false) n.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  var SVGNS = 'http://www.w3.org/2000/svg';
  function seal() {
    var s = document.createElementNS(SVGNS, 'svg');
    s.setAttribute('viewBox', '0 0 36 36'); s.setAttribute('class', 'seal'); s.setAttribute('aria-hidden', 'true');
    s.innerHTML = '<circle cx="18" cy="18" r="17" fill="#B3402A"/><circle cx="18" cy="18" r="13" fill="none" stroke="rgba(255,255,255,.28)" stroke-width="1"/>' +
      '<path d="M18 11c-2.6 1.4-4 3.6-4 6.2 0 2.1 1.8 3.8 4 3.8s4-1.7 4-3.8c0-2.6-1.4-4.8-4-6.2z" fill="#F7E7DA"/>' +
      '<path d="M18 21v6M18 25c-1.8-.2-3-1.2-3.6-2.6M18 25c1.8-.2 3-1.2 3.6-2.6" stroke="#F7E7DA" stroke-width="1.4" fill="none" stroke-linecap="round"/>';
    return s;
  }
  var tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  var dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  var timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  function whenLine(e) {
    var s = new Date(e.starts_at);
    var line = dayFmt.format(s) + ' · ' + timeFmt.format(s);
    if (e.ends_at) line += ' – ' + timeFmt.format(new Date(e.ends_at));
    return line;
  }
  function icsStamp(d) { return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }
  function icsText(t) { return String(t).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, '\\$&'); }
  /* Built in the browser; nothing is sent anywhere. */
  function addToCalendar(e) {
    var s = new Date(e.starts_at);
    var end = e.ends_at ? new Date(e.ends_at) : new Date(s.getTime() + 2 * 3600e3);
    var ics = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//M3XI//CallMe events//EN', 'CALSCALE:GREGORIAN',
      'BEGIN:VEVENT',
      'UID:' + e.slug + '@m3xi.com',
      'DTSTAMP:' + icsStamp(new Date()),
      'DTSTART:' + icsStamp(s),
      'DTEND:' + icsStamp(end),
      'SUMMARY:' + icsText(e.title),
      'DESCRIPTION:' + icsText(e.body + '\n\nhttps://www.m3xi.com/events/#' + e.slug),
      e.where_label ? 'LOCATION:' + icsText(e.where_label) : '',
      'URL:https://www.m3xi.com/events/#' + e.slug,
      'BEGIN:VALARM', 'TRIGGER:-PT60M', 'ACTION:DISPLAY', 'DESCRIPTION:' + icsText(e.title + ' starts in an hour'), 'END:VALARM',
      'END:VEVENT', 'END:VCALENDAR',
    ].filter(Boolean).join('\r\n');
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
    a.download = e.slug + '.ics';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }
  function render(rows) {
    if (!rows.length) {
      $state.textContent = 'Nothing is planned just yet. Check back soon — events go up here a few days ahead.';
      return;
    }
    $state.hidden = true;
    $list.hidden = false;
    rows.forEach(function (e) {
      var safeLink = e.cta_url && /^https:\/\/(www\.)?m3xi\.com(\/\S*)?$/i.test(e.cta_url) ? e.cta_url : null;
      $list.appendChild(el('article', { class: 'letter', id: e.slug }, [
        el('span', { class: 'tape', 'aria-hidden': 'true' }), seal(),
        el('div', { class: 'when', text: whenLine(e) }),
        el('h2', { text: e.title }),
        e.where_label ? el('div', { class: 'where', text: e.where_label }) : null,
        el('p', { text: e.body }),
        el('div', { class: 'actions' }, [
          el('button', { class: 'btn', type: 'button', text: 'Add to calendar', onclick: function () { addToCalendar(e); } }),
          safeLink && e.cta_label ? el('a', { class: 'btn rose', href: safeLink, text: e.cta_label }) : null,
        ]),
      ]));
    });
    if (location.hash) {
      var t = document.getElementById(location.hash.slice(1));
      if (t) t.scrollIntoView();
    }
  }
  fetch(URL_ + '/rest/v1/rpc/events_upcoming', {
    method: 'POST',
    headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
    body: '{}',
  }).then(function (r) {
    if (!r.ok) throw new Error(r.status);
    return r.json();
  }).then(function (rows) {
    render(Array.isArray(rows) ? rows : []);
  }).catch(function () {
    $state.textContent = 'Events didn\'t load. Check your connection and refresh the page.';
  });
  // Times are shown in the visitor's own zone.
  document.documentElement.setAttribute('data-tz', tz);
})();
