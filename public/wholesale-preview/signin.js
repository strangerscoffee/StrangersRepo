(() => {
  const $ = (selector) => document.querySelector(selector);
  const local = location.pathname.startsWith('/wholesale-preview/');
  const home = local ? '/wholesale-preview/' : '/';
  let changing = false;
  let registering = false;
  // An invite from Strangers (…/signin?invite=…): choose a username and password to set up the business's account.
  let invite = new URLSearchParams(location.search).get('invite');
  if (invite) {
    history.replaceState(null, '', location.pathname);
    const showError = (message) => { $('#login-error').textContent = message; $('#login-error').hidden = false; };
    fetch('/api/wholesale/auth/invite?token=' + encodeURIComponent(invite), { cache: 'no-store' }).then(async (response) => {
      const result = await response.json().catch(() => ({}));
      if (!response.ok) { invite = null; showError(result.message || 'This invite link could not be opened. Ask Strangers for a new one.'); return; }
      $('#login-title').textContent = 'Set up your account.';
      $('#login-intro').textContent = `Set up your account to order coffee for ${result.business}. Choose a username and password you'll use to sign in.`;
      $('#login-submit').textContent = 'Set up account';
      $('#password').autocomplete = 'new-password';
      $('#invite-confirm').hidden = false; $('#invite-password2').required = true;
      $('#registration-toggle').hidden = true;
      $('#username').focus();
    }).catch(() => { invite = null; showError('Check your connection, then open the invite link again.'); });
  }
  // Forgotten password or username: a one-time link emailed to the business (src/wholesaleReset.ts). The answer is
  // the same whether or not anything matched. A link from that email (…/signin?reset=…) opens the new-password form.
  const views = ['#wholesale-login', '#forgot-form', '#reset-form', '#registration-complete'];
  const only = (shown) => { for (const v of views) $(v).hidden = v !== shown; $('#registration-toggle').hidden = shown !== '#wholesale-login' && shown !== '#registration-complete'; };
  const say = (box, message) => { $(box).textContent = message; $(box).hidden = !message; };
  const connection = (error) => (error.message === 'Failed to fetch' ? 'Check your connection and try again.' : error.message);
  fetch('/api/wholesale/auth/contact', { cache: 'no-store' }).then((r) => r.ok ? r.json() : null).then((r) => { if (r && /^[^\s@]+@[^\s@]+$/.test(r.email || '')) $('#contact-link').href = 'mailto:' + r.email; }).catch(() => {});
  let forgetting = false;
  $('#forgot-toggle').addEventListener('click', () => {
    forgetting = !forgetting;
    if (registering) $('#registration-toggle').click();
    only(forgetting ? '#forgot-form' : '#wholesale-login');
    $('#login-title').textContent = forgetting ? 'Reset your password.' : 'Welcome back.';
    $('#login-intro').textContent = forgetting ? 'Forgotten your password or username?' : 'Sign in to order coffee for your business.';
    $('#forgot-toggle').textContent = forgetting ? 'Back to sign-in' : 'Forgotten your password or username?';
    say('#forgot-error', ''); say('#forgot-sent', '');
    $('#forgot-submit').hidden = false;
    if (forgetting) { $('#forgot-identifier').value = $('#username').value; $('#forgot-identifier').focus(); }
  });
  $('#forgot-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    say('#forgot-error', ''); say('#forgot-sent', '');
    $('#forgot-submit').disabled = true;
    try {
      const response = await fetch('/api/wholesale/auth/forgot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: $('#forgot-identifier').value }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || 'Could not send a reset link. Try again.');
      say('#forgot-sent', result.message);
      $('#forgot-submit').hidden = true;
    } catch (error) { say('#forgot-error', connection(error)); }
    finally { $('#forgot-submit').disabled = false; }
  });
  let reset = new URLSearchParams(location.search).get('reset');
  if (reset) {
    history.replaceState(null, '', location.pathname);
    only('#reset-form');
    $('#forgot-toggle').hidden = true;
    $('#login-title').textContent = 'Choose a new password.';
    $('#login-intro').textContent = 'Checking your reset link…';
    $('#reset-submit').disabled = true;
    fetch('/api/wholesale/auth/reset?token=' + encodeURIComponent(reset), { cache: 'no-store' }).then(async (response) => {
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || 'This reset link could not be opened. Ask for a new one.');
      $('#login-intro').textContent = `Choose a new password for ${result.business || 'your business'}.`;
      $('#reset-intro').textContent = `Your username is ${result.username}. Your new password works straight away, and you'll be signed out everywhere else.`;
      $('#reset-submit').disabled = false;
      $('#reset-password').focus();
    }).catch((error) => {
      reset = null;
      $('#login-intro').textContent = connection(error);
      only('#wholesale-login'); $('#forgot-toggle').hidden = false;
    });
  }
  $('#reset-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    say('#reset-error', '');
    if ($('#reset-password').value !== $('#reset-password2').value) { say('#reset-error', 'The passwords do not match.'); return; }
    $('#reset-submit').disabled = true;
    try {
      const response = await fetch('/api/wholesale/auth/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: reset, password: $('#reset-password').value }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || 'Could not save your new password. Try again.');
      location.replace(home);
    } catch (error) { say('#reset-error', connection(error)); $('#reset-submit').disabled = false; }
  });
  $('#registration-toggle').addEventListener('click', () => {
    registering = $('#registration-complete').hidden ? !registering : false;
    changing = false;
    if (forgetting) { forgetting = false; $('#forgot-form').hidden = true; $('#forgot-toggle').textContent = 'Forgotten your password or username?'; }
    $('#forgot-toggle').hidden = registering;
    $('#wholesale-login').hidden = false;
    $('#registration-complete').hidden = true;
    $('#password-change').hidden = true;
    $('#new-password').required = $('#confirm-password').required = false;
    $('#registration-fields').hidden = !registering;
    for (const name of ['business', 'contact', 'email']) $('#wholesale-login').elements[name].required = registering;
    $('#login-title').textContent = registering ? 'Join us.' : 'Welcome back.';
    $('#login-intro').textContent = registering ? 'Request a wholesale account. Strangers will review your business before you can access ordering.' : 'Sign in to order coffee for your business.';
    $('#login-submit').textContent = registering ? 'Request account' : 'Sign in';
    $('#registration-toggle').textContent = registering ? 'Already have an account? Sign in' : 'Request a wholesale account';
    $('#password').autocomplete = registering ? 'new-password' : 'current-password';
    $('#password').value = '';
    $('#login-error').hidden = true;
  });
  $('#wholesale-login').addEventListener('submit', async (event) => {
    event.preventDefault();
    $('#login-error').hidden = true;
    if (invite) {
      if ($('#password').value !== $('#invite-password2').value) { $('#login-error').textContent = 'The passwords do not match.'; $('#login-error').hidden = false; return; }
      $('#login-submit').disabled = true;
      try {
        const response = await fetch('/api/wholesale/auth/invite', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: invite, username: $('#username').value, password: $('#password').value }) });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.message || 'Could not set up your account. Try again.');
        location.replace(home);
      } catch (error) {
        $('#login-error').textContent = error.message === 'Failed to fetch' ? 'Check your connection and try again.' : error.message;
        $('#login-error').hidden = false;
      } finally { $('#login-submit').disabled = false; }
      return;
    }
    if (changing && $('#new-password').value !== $('#confirm-password').value) {
      $('#login-error').textContent = 'The new passwords do not match.';
      $('#login-error').hidden = false;
      return;
    }
    $('#login-submit').disabled = true;
    try {
      const form = $('#wholesale-login');
      const response = await fetch('/api/wholesale/auth/' + (registering ? 'register' : changing ? 'change-password' : 'login'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: $('#username').value, password: $('#password').value, ...(changing ? { newPassword: $('#new-password').value } : {}), ...(registering ? Object.fromEntries(['business', 'contact', 'email', 'accountsEmail', 'phone'].map(name => [name, form.elements[name].value])) : {}) }),
      });
      const result = await response.json();
      if (result.code === 'password_change_required') {
        changing = true;
        $('#password-change').hidden = false;
        $('#new-password').required = $('#confirm-password').required = true;
        $('#login-submit').textContent = 'Set password and sign in';
        $('#new-password').focus();
        return;
      }
      if (!response.ok) throw new Error(result.message || 'Could not sign in. Try again.');
      if (registering) {
        form.reset();
        form.hidden = true;
        $('#registration-complete').hidden = false;
        $('#registration-toggle').textContent = 'Back to sign-in';
        return;
      }
      location.replace(home);
    } catch (error) {
      $('#login-error').textContent = error.message === 'Failed to fetch' ? 'Check your connection and try again.' : error.message;
      $('#login-error').hidden = false;
    } finally { $('#login-submit').disabled = false; }
  });
})();
