/**
 * Sign in.
 *
 * One form, one heading, real labels, and an error that says what to do rather
 * than what went wrong internally. The autocomplete tokens are there so a
 * password manager fills it; an operator signs in on a phone in a hallway.
 */

import { button, el, field, note } from '@m3xi/console-ui';
import { FIXTURE_ACCOUNTS, FIXTURE_PASSWORD_NOTE } from '../api/fixture.js';

export interface SignInResult {
  readonly email: string;
  readonly password: string;
}

export function renderSignIn(options: {
  readonly isFixture: boolean;
  readonly onSubmit: (input: SignInResult) => Promise<void>;
}): HTMLElement {
  const error = el('div', { id: 'signin-error' });

  const emailField = field({
    label: 'Email address',
    type: 'email',
    required: true,
    autocomplete: 'username',
    placeholder: options.isFixture ? FIXTURE_ACCOUNTS[0] : 'you@agency.co.uk',
  });
  const passwordField = field({
    label: 'Password',
    type: 'password',
    required: true,
    autocomplete: 'current-password',
    ...(options.isFixture ? { hint: 'Any password is accepted by the fixture backend.' } : {}),
  });

  const submit = button({ label: 'Sign in', emphasis: 'primary', type: 'submit' });

  const form = el('form', {
    style: 'max-width:380px',
    onsubmit: (e: Event) => {
      e.preventDefault();
      const email = emailField.input.value.trim();
      const password = passwordField.input.value;
      error.replaceChildren();
      if (!email) {
        error.appendChild(note('bad', null, 'Enter the email address you use for this account.'));
        emailField.input.focus();
        return;
      }
      submit.disabled = true;
      submit.textContent = 'Signing in…';
      void options.onSubmit({ email, password })
        .catch((err: unknown) => {
          error.replaceChildren(note('bad', null, err instanceof Error ? err.message : String(err)));
          // Focus moves to the message so it is not merely announced and lost.
          const first = error.querySelector('p');
          if (first) { first.setAttribute('tabindex', '-1'); (first as HTMLElement).focus(); }
        })
        .finally(() => {
          submit.disabled = false;
          submit.textContent = 'Sign in';
        });
    },
  },
  emailField.root,
  passwordField.root,
  error,
  el('div', { style: 'margin-top:12px' }, submit),
  );

  return el('div', { style: 'max-width:760px;margin:0 auto;padding:64px 24px' },
    el('h1', { style: 'font-size:22px;margin:0 0 4px' }, 'M3XI World Viewer'),
    el('p', { style: 'color:var(--ink-dim);margin:0 0 24px' },
      'The operator console. Sign in with the account your organisation gave you.'),
    options.isFixture ? note('warn', 'Demonstration build', FIXTURE_PASSWORD_NOTE) : null,
    form,
    el('hr', {}),
    el('p', { style: 'color:var(--ink-dim);font-size:13px;max-width:60ch' },
      'Accounts are created by an owner or admin inside an organisation. If you have not been invited yet, ask whoever set up your agency’s account.'),
  );
}
