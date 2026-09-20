/**
 * Sign in.
 *
 * One form, one heading, real labels, autocomplete tokens so a password
 * manager fills it — an operator signs in on a phone, outside, often in the
 * rain. Errors say what to do rather than what went wrong internally, and a
 * wrong password and an unknown address read identically.
 *
 * Deliberately no magic link, which the console does offer. A magic link
 * arrives in a mail app, and on iOS opening it navigates AWAY from this tab —
 * which is survivable before a walk and catastrophic in the middle of one, so
 * having the control here at all would be teaching a habit that later costs a
 * capture. Email and password every time is the boring, safe answer.
 */

import { button, el, field, focusHeading, note } from '../ui/dom.js';

export interface SignInScreen {
  readonly root: HTMLElement;
  focus(): void;
}

export function renderSignIn(options: {
  readonly onSubmit: (email: string, password: string) => Promise<void>;
  readonly initialProblem: string | null;
}): SignInScreen {
  const heading = el('h1', {}, 'Sign in to capture');
  const errorRegion = el('div', { id: 'signin-error' });
  if (options.initialProblem) {
    errorRegion.appendChild(note('act', options.initialProblem, 'Not signed in'));
  }

  const email = field({
    label: 'Email address',
    type: 'email',
    required: true,
    autocomplete: 'username',
    inputmode: 'email',
  });
  const password = field({
    label: 'Password',
    type: 'password',
    required: true,
    autocomplete: 'current-password',
  });
  const submit = button({ label: 'Sign in', emphasis: 'primary', type: 'submit' });

  const form = el('form', {
    novalidate: true,
    onsubmit: (event: Event) => {
      event.preventDefault();
      errorRegion.replaceChildren();
      const address = email.input.value.trim();
      if (address.length === 0) {
        errorRegion.appendChild(note('act', 'Enter the email address you use for this account.'));
        email.input.focus();
        return;
      }
      submit.disabled = true;
      submit.replaceChildren(el('span', { class: 'c-btn-label' }, 'Signing in'));
      void options.onSubmit(address, password.input.value)
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          const block = note('act', message, 'Could not sign in');
          errorRegion.replaceChildren(block);
          // Focus moves to the message, so it is not merely announced and lost
          // behind whatever the operator is looking at.
          const first = block.querySelector('p');
          if (first) { first.setAttribute('tabindex', '-1'); (first as HTMLElement).focus(); }
        })
        .finally(() => {
          submit.disabled = false;
          submit.replaceChildren(el('span', { class: 'c-btn-label' }, 'Sign in'));
        });
    },
  }, email.root, password.root, errorRegion, el('div', { class: 'c-actions' }, submit));

  const root = el('div', {},
    heading,
    el('p', { class: 'c-muted' },
      'Use the account your agency gave you. A walkthrough is filed against a property in your '
      + 'own organisation and nothing else is visible from this phone.'),
    form,
  );

  return { root, focus: () => focusHeading(heading) };
}
