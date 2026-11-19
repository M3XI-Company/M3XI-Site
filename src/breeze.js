/*
 * m3xi.com/breeze/ — the Breeze waitlist page's own script. The header and footer are
 * /shared/site-chrome.js.
 *
 * Signups go to public.breeze_waitlist on the Breeze Supabase project
 * (supabase/breeze/breeze_waitlist.sql): email, source, created_at. The key
 * below is the PUBLISHABLE key; row-level security lets it insert a row and
 * nothing else (no reading, changing or deleting), so it is safe in a public
 * repo. `source` is the visit's utm_source, so a TikTok bio link such as
 *   https://www.m3xi.com/breeze/?utm_source=tiktok-video-12
 * shows which video the signup came from.
 */
const SB_URL = 'https://eteqjblzumzgsvwhkxep.supabase.co';
const SB_KEY = 'sb_publishable_lg9KuropnY78dG9pNcEuhQ_V9ymlZJL';
const TABLE = 'breeze_waitlist';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// utm_source, kept for the tab so it survives a look round the site and back.
function source() {
  let s = new URLSearchParams(location.search).get('utm_source');
  try {
    if (s) sessionStorage.setItem('bz_source', s);
    else s = sessionStorage.getItem('bz_source');
  } catch { /* private mode: the URL alone is fine */ }
  s = (s || '').trim().toLowerCase().slice(0, 120);
  return s || null;
}
source();

const forms = [...document.querySelectorAll('form[data-waitlist]')];

function done(form, already) {
  // One signup answers both forms on the page.
  forms.forEach((f) => {
    const panel = f.parentElement.querySelector('.bz-done');
    if (!panel) return;
    panel.querySelector('.bz-done-title').textContent = already ? 'You are already on the list.' : 'You are on the list.';
    panel.querySelector('.bz-done-text').textContent = already
      ? 'No need to sign up twice. We will email you as soon as Breeze is ready.'
      : 'We will email you as soon as Breeze is ready to download.';
    f.hidden = true;
    panel.hidden = false;
  });
  const title = form.parentElement.querySelector('.bz-done-title');
  if (title) title.focus();
}

forms.forEach((form) => {
  const input = form.querySelector('input[name="email"]');
  const trap = form.querySelector('input[name="company"]');
  const button = form.querySelector('button[type="submit"]');
  const msg = form.querySelector('.bz-form-msg');
  let busy = false;

  const fail = (text) => {
    msg.textContent = text;
    msg.classList.add('is-err');
    input.setAttribute('aria-invalid', 'true');
    input.focus();
  };

  input.addEventListener('input', () => {
    msg.textContent = '';
    msg.classList.remove('is-err');
    input.removeAttribute('aria-invalid');
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;

    // Bots fill the hidden field; they get the same thank-you and no row.
    if (trap && trap.value) return done(form, false);

    const email = input.value.trim().toLowerCase();
    if (!email) return fail('Please enter your email address.');
    if (!EMAIL_RE.test(email) || email.length > 320) return fail('That does not look like an email address. Please check it.');

    busy = true;
    const label = button.textContent;
    button.disabled = true;
    button.textContent = 'Adding you…';
    try {
      const res = await fetch(SB_URL + '/rest/v1/' + TABLE, {
        method: 'POST',
        headers: {
          apikey: SB_KEY,
          Authorization: 'Bearer ' + SB_KEY,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ email, source: source() }),
      });
      if (res.ok) done(form, false);
      else if (res.status === 409) done(form, true); // unique(email): already signed up
      else if (res.status === 400) fail('That email address did not pass our check. Please look it over.');
      else fail('Something went wrong on our side. Please try again in a moment.');
    } catch {
      fail('We could not reach the waitlist. Check your connection and try again.');
    } finally {
      busy = false;
      button.disabled = false;
      button.textContent = label;
    }
  });
});
