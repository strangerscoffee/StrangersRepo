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
  $('#registration-toggle').addEventListener('click', () => {
    registering = $('#registration-complete').hidden ? !registering : false;
    changing = false;
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
