/*
 * m3xi.com/contact/ — the form opens the visitor's own email app with the
 * message filled in. Nothing is sent to a server from this page.
 */
document.getElementById('cf').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = (id) => document.getElementById(id).value;
  const name = v('cf-name'), email = v('cf-email'), type = v('cf-type'), msg = v('cf-msg');
  const subject = encodeURIComponent('[' + type + '] enquiry from ' + (name || 'website'));
  const body = encodeURIComponent((msg || '') + '\n\n— ' + (name || '') + (email ? ' (' + email + ')' : ''));
  window.location.href = 'mailto:support@m3xi.com?subject=' + subject + '&body=' + body;
});
