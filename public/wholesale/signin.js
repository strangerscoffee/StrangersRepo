(() => {
  const $ = selector => document.querySelector(selector);
  const home = location.pathname.startsWith('/wholesale/') ? '/wholesale/' : '/';
  const params = new URLSearchParams(location.search);
  let invite = params.get('invite'), reset = params.get('reset');
  let mode = 'login', busy = false, checkingLink = false, generation = 0;
  let linkBusiness = '', resetUsername = '';
  const say = (selector, message) => { $(selector).textContent = message; $(selector).hidden = !message; };
  const connection = error => error.message === 'Failed to fetch' ? 'Check your connection and try again.' : error.message;
  const toggles = [...document.querySelectorAll('[data-password-toggle]')];
  for (const button of toggles) button.dataset.passwordLabel = button.getAttribute('aria-label').replace(/^Show /, '');
  function hidePasswords(clear = false) {
    for (const button of toggles) {
      const input = document.getElementById(button.dataset.passwordToggle);
      input.type = 'password';
      if (clear) input.value = '';
      button.textContent = 'Show';
      button.setAttribute('aria-label', 'Show ' + button.dataset.passwordLabel);
      button.setAttribute('aria-pressed', 'false');
    }
  }
  for (const button of toggles) button.addEventListener('click', () => {
    const input = document.getElementById(button.dataset.passwordToggle), visible = input.type === 'password';
    input.type = visible ? 'text' : 'password';
    button.textContent = visible ? 'Hide' : 'Show';
    button.setAttribute('aria-label', (visible ? 'Hide ' : 'Show ') + button.dataset.passwordLabel);
    button.setAttribute('aria-pressed', String(visible));
  });
  function updateBusy() {
    for (const button of document.querySelectorAll('.login-panel button[type="submit"]')) button.disabled = busy || checkingLink;
    for (const button of document.querySelectorAll('[data-auth-nav]')) button.disabled = busy;
    for (const form of document.querySelectorAll('.login-panel form')) form.setAttribute('aria-busy', String((busy || checkingLink) && !form.hidden));
  }
  function render(next) {
    mode = next;
    document.body.dataset.authView = next;
    hidePasswords();
    const loginForm = ['login', 'register', 'changing', 'invite'].includes(next);
    $('#wholesale-login').hidden = !loginForm;
    $('#registration-fields').hidden = next !== 'register';
    for (const name of ['business', 'contact', 'email']) $('#wholesale-login').elements[name].required = next === 'register';
    $('#password-change').hidden = next !== 'changing';
    $('#new-password').required = $('#confirm-password').required = next === 'changing';
    $('#invite-confirm').hidden = next !== 'invite';
    $('#invite-password2').required = next === 'invite';
    $('#password').autocomplete = ['register', 'invite'].includes(next) ? 'new-password' : 'current-password';
    $('#forgot-toggle').hidden = next !== 'login';
    $('#registration-complete').hidden = next !== 'registered';
    $('#forgot-form').hidden = next !== 'forgot';
    $('#forgot-complete').hidden = next !== 'sent';
    $('#reset-form').hidden = next !== 'reset';
    $('#login-new').hidden = !['login', 'register', 'registered'].includes(next);
    $('#login-new-label').hidden = next !== 'login';
    $('#login-new').classList.toggle('is-return', next !== 'login');
    $('#registration-toggle').textContent = next === 'register' ? 'Already have an account? Sign in' : next === 'registered' ? 'Back to sign-in' : 'Request a wholesale account';
    $('#auth-back').hidden = ['login', 'register', 'registered'].includes(next);
    $('#auth-back').className = next === 'sent' ? 'button button-dark login-back' : 'text-button login-back';
    $('#forgot-again').hidden = next !== 'sent';
    const titles = { login: 'Welcome back.', register: 'Join us.', registered: 'Request received.', changing: 'Choose your own password.', invite: 'Set up your account.', forgot: 'Reset your password.', sent: 'Check your inbox.', reset: 'Choose a new password.' };
    $('#login-title').textContent = titles[next];
    const intros = {
      login: 'Sign in to your wholesale account.',
      register: 'Request a wholesale account. Strangers will review your business before you can access ordering.',
      registered: '', changing: 'Finish setting up your wholesale account.',
      invite: checkingLink ? 'Checking your invitation…' : `Set up your account to order coffee for ${linkBusiness}. Choose a username and password you'll use to sign in.`,
      forgot: "We'll email a reset link and your username to the address saved on your account.", sent: '',
      reset: checkingLink ? 'Checking your reset link…' : `Choose a new password for ${linkBusiness || 'your business'}.`,
    };
    say('#login-intro', intros[next]);
    if (next === 'reset' && !checkingLink) $('#reset-intro').textContent = `Your username is ${resetUsername}. Your new password works straight away, and you'll be signed out everywhere else.`;
    $('#login-submit').textContent = next === 'register' ? 'Request account' : next === 'invite' ? 'Set up account' : next === 'changing' ? 'Set password and sign in' : 'Sign in';
    updateBusy();
  }
  function navigate(next) {
    if (busy) return;
    generation++;
    invite = reset = null;
    checkingLink = false;
    hidePasswords(true);
    for (const selector of ['#login-error', '#forgot-error', '#reset-error']) say(selector, '');
    render(next);
    const focus = next === 'forgot' ? '#forgot-identifier' : next === 'register' ? '#registration-fields [name=business]' : '#username';
    $(focus).focus({ preventScroll: true });
  }
  $('#forgot-toggle').addEventListener('click', () => {
    if (!$('#forgot-identifier').value) $('#forgot-identifier').value = $('#username').value;
    navigate('forgot');
  });
  $('#auth-back').addEventListener('click', () => navigate('login'));
  $('#forgot-again').addEventListener('click', () => navigate('forgot'));
  $('#registration-toggle').addEventListener('click', () => navigate(mode === 'login' ? 'register' : 'login'));
  fetch('/api/wholesale/auth/contact', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(result => {
    if (result && /^[^\s@]+@[^\s@]+$/.test(result.email || '')) $('#contact-link').href = 'mailto:' + result.email;
  }).catch(() => {});
  async function resultOf(response, fallback) {
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.message || fallback);
    return result;
  }
  $('#forgot-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || mode !== 'forgot') return;
    say('#forgot-error', ''); busy = true; updateBusy();
    try {
      const response = await fetch('/api/wholesale/auth/forgot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: $('#forgot-identifier').value }) });
      await resultOf(response, 'Could not send a reset link. Try again.');
      // Keep confirmation independent of whether any account matched, as on the API.
      $('#forgot-sent').textContent = "If those details match an account, we'll email a reset link and your username.";
      busy = false; render('sent');
      $('#auth-back').focus({ preventScroll: true });
    } catch (error) { say('#forgot-error', connection(error)); }
    finally { busy = false; updateBusy(); }
  });
  $('#wholesale-login').addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || checkingLink || !['login', 'register', 'changing', 'invite'].includes(mode)) return;
    const submittedMode = mode;
    say('#login-error', '');
    if (mode === 'invite' && $('#password').value !== $('#invite-password2').value) { say('#login-error', 'The passwords do not match.'); return; }
    if (mode === 'changing' && $('#new-password').value !== $('#confirm-password').value) { say('#login-error', 'The new passwords do not match.'); return; }
    const form = $('#wholesale-login');
    const payload = { username: $('#username').value, password: $('#password').value,
      ...(mode === 'invite' ? { token: invite } : {}), ...(mode === 'changing' ? { newPassword: $('#new-password').value } : {}),
      ...(mode === 'register' ? Object.fromEntries(['business', 'contact', 'email', 'accountsEmail', 'phone'].map(name => [name, form.elements[name].value])) : {}),
    };
    const route = mode === 'invite' ? 'invite' : mode === 'register' ? 'register' : mode === 'changing' ? 'change-password' : 'login';
    busy = true; updateBusy();
    try {
      const response = await fetch('/api/wholesale/auth/' + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      const result = await response.json().catch(() => ({}));
      if (submittedMode === 'login' && result.code === 'password_change_required') {
        render('changing'); $('#new-password').focus(); return;
      }
      if (!response.ok) throw new Error(result.message || 'Could not sign in. Try again.');
      if (submittedMode === 'register') { busy = false; form.reset(); hidePasswords(true); render('registered'); $('#registration-toggle').focus({ preventScroll: true }); return; }
      location.replace(home);
    } catch (error) { say('#login-error', connection(error)); }
    finally { busy = false; updateBusy(); }
  });
  $('#reset-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || checkingLink || mode !== 'reset' || !reset) return;
    say('#reset-error', '');
    if ($('#reset-password').value !== $('#reset-password2').value) { say('#reset-error', 'The passwords do not match.'); return; }
    busy = true; updateBusy();
    try {
      const response = await fetch('/api/wholesale/auth/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: reset, password: $('#reset-password').value }) });
      await resultOf(response, 'Could not save your new password. Try again.');
      location.replace(home);
    } catch (error) { say('#reset-error', connection(error)); }
    finally { busy = false; updateBusy(); }
  });
  async function checkLink(kind, token) {
    const started = ++generation;
    checkingLink = true; render(kind);
    try {
      const result = await resultOf(await fetch('/api/wholesale/auth/' + kind + '?token=' + encodeURIComponent(token), { cache: 'no-store' }), 'This link could not be opened. Ask for a new one.');
      if (generation !== started) return;
      linkBusiness = result.business || 'your business'; resetUsername = result.username || '';
      checkingLink = false; render(kind);
      $(kind === 'reset' ? '#reset-password' : '#username').focus();
    } catch (error) {
      if (generation !== started) return;
      invite = reset = null; checkingLink = false; render('login'); say('#login-intro', connection(error));
    }
  }
  window.addEventListener('pagehide', () => hidePasswords());
  window.addEventListener('pageshow', () => hidePasswords());
  render('login');
  if (invite || reset) {
    history.replaceState(null, '', location.pathname);
    if (invite) { reset = null; checkLink('invite', invite); }
    else checkLink('reset', reset);
  }
})();
