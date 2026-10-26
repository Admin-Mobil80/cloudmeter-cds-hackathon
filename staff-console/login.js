// CloudMeter BMS — passwordless sign-in against the staff Cognito pool.
//
// Unlike the portal there is no sign-up path at all: the pool has self sign-up
// disabled, so an address that nobody has been granted access to simply fails
// the challenge. That failure is the intended answer, not an error to smooth
// over.
(function () {
  if (window.CM_Session.isValid()) window.location.replace('tenants.html');

  const el = id => document.getElementById(id);
  let session = null;
  let pendingEmail = '';

  function showStep(name) {
    document.querySelectorAll('.auth-step').forEach(s => s.classList.remove('active'));
    el(`step-${name}`).classList.add('active');
  }

  el('send-otp-btn').addEventListener('click', async () => {
    const email = el('email-input').value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      el('email-error').textContent = 'Enter a valid email address.';
      el('email-error').classList.add('show');
      return;
    }
    el('email-error').classList.remove('show');

    const btn = el('send-otp-btn');
    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
      const res = await window.CM_Cognito.initiateAuth(email);
      session = res.Session;
      pendingEmail = email;
      el('otp-email-target').textContent = email;
      showStep('otp');
      document.querySelector('#step-otp .otp-box').focus();
    } catch (err) {
      // Deliberately the same wording whether the address has access or not:
      // this console's user list is not something an anonymous caller should
      // be able to probe one address at a time.
      el('email-error').textContent = "If that address has BMS access, a code is on its way.";
      el('email-error').classList.add('show');
      console.error('BMS sign-in start failed', err);
    }
    btn.disabled = false;
    btn.textContent = 'Send code';
  });

  const boxes = Array.from(document.querySelectorAll('#step-otp .otp-box'));
  boxes.forEach((box, i) => {
    box.addEventListener('input', () => {
      box.value = box.value.replace(/[^0-9]/g, '').slice(0, 1);
      el('otp-error').classList.remove('show');
      if (box.value && i < boxes.length - 1) boxes[i + 1].focus();
      if (boxes.every(b => b.value)) el('verify-btn').click();
    });
    box.addEventListener('keydown', e => {
      if (e.key === 'Backspace' && !box.value && i > 0) boxes[i - 1].focus();
    });
  });

  el('verify-btn').addEventListener('click', async () => {
    const code = boxes.map(b => b.value).join('');
    if (code.length !== 6) return;

    const btn = el('verify-btn');
    btn.disabled = true;
    btn.textContent = 'Verifying…';
    try {
      const res = await window.CM_Cognito.respondToChallenge(pendingEmail, session, code);
      if (!res.AuthenticationResult) {
        // A wrong code returns a fresh challenge rather than an error.
        session = res.Session;
        throw new Error('Incorrect code');
      }
      window.CM_Session.save({
        idToken: res.AuthenticationResult.IdToken,
        accessToken: res.AuthenticationResult.AccessToken,
        refreshToken: res.AuthenticationResult.RefreshToken,
        email: pendingEmail,
      });
      window.location.href = 'tenants.html';
      return;
    } catch (err) {
      el('otp-error').textContent = 'That code didn\'t work — try again.';
      el('otp-error').classList.add('show');
      boxes.forEach(b => (b.value = ''));
      boxes[0].focus();
    }
    btn.disabled = false;
    btn.textContent = 'Verify & continue';
  });

  el('back-btn').addEventListener('click', () => {
    boxes.forEach(b => (b.value = ''));
    showStep('email');
  });
})();
