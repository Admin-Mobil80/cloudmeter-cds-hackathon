// CloudMeter — sign in / sign up: email + OTP via real Cognito custom auth.

if (window.CM_Session.isValid()) {
  window.location.replace('dashboard.html');
}

// "Back to CloudMeter home" now leaves the portal entirely — the marketing
// page lives on its own site, not here — so the target comes from config
// rather than being a same-site relative link.
document.getElementById('brand-home-link').href = window.CM_CONFIG.marketingUrl;

let authMode = 'signup'; // 'signup' | 'signin'
let pendingEmail = '';
let pendingSession = '';
// The CloudMeter account is created by a Cognito trigger during sign-up, which
// has no way to see this form — so the organization name is applied on the
// first authenticated request instead.
let pendingCompany = '';

const authTabs = document.getElementById('auth-tabs');
const authBadge = document.getElementById('auth-badge');

const stepSignup = document.getElementById('step-signup');
const signupName = document.getElementById('signup-name');
const signupCompany = document.getElementById('signup-company');
const signupEmail = document.getElementById('signup-email');
const signupError = document.getElementById('signup-error');
const signupBtn = document.getElementById('signup-btn');

const emailInput = document.getElementById('email-input');
const emailError = document.getElementById('email-error');
const sendOtpBtn = document.getElementById('send-otp-btn');
const stepEmail = document.getElementById('step-email');

const stepOtp = document.getElementById('step-otp');
const otpTitle = document.getElementById('otp-title');
const otpSub = document.getElementById('otp-sub');
const otpBoxes = Array.from(document.querySelectorAll('.otp-box'));
const otpError = document.getElementById('otp-error');
const verifyBtn = document.getElementById('verify-btn');
const backBtn = document.getElementById('back-btn');
const resendBtn = document.getElementById('resend-btn');
const resendToast = document.getElementById('resend-toast');

function isValidEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
}

/**
 * HTML-escape before innerHTML. Local to this file, matching the convention
 * used elsewhere in this frontend — each page loads its own script set.
 */
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function setActiveStep(step) {
  [stepSignup, stepEmail, stepOtp].forEach(s => s.classList.remove('active'));
  step.classList.add('active');
}

function switchTab(mode) {
  authMode = mode;
  authTabs.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  if (mode === 'signup') {
    authBadge.textContent = '🎉 7-day free trial · No credit card required';
    setActiveStep(stepSignup);
  } else {
    authBadge.textContent = '🔒 Welcome back';
    setActiveStep(stepEmail);
  }
}

const params = new URLSearchParams(window.location.search);
const requestedMode = params.get('mode');
if (requestedMode === 'signin' || requestedMode === 'signup') {
  switchTab(requestedMode);
}

// Invite links carry the invited address, so an invitee lands on sign-in with
// it already filled and only has to press Send code.
const prefillEmail = params.get('email');
if (prefillEmail && isValidEmail(prefillEmail)) {
  emailInput.value = prefillEmail;
  if (requestedMode !== 'signup') switchTab('signin');
}

authTabs.querySelectorAll('button').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.mode));
});

function friendlyAuthError(err) {
  switch (err.code) {
    case 'UsernameExistsException':
      return 'An account with this email already exists — sign in instead. '
        + 'To start a second CloudMeter account, sign in and use "Create a new CloudMeter account" in the account menu, top left.';
    case 'UserNotFoundException':
      return "We couldn't find an account with this email — try signing up instead.";
    case 'NotAuthorizedException':
      return 'Too many incorrect attempts. Please start again.';
    case 'LimitExceededException':
    case 'TooManyRequestsException':
      return 'Too many attempts — please wait a moment and try again.';
    default:
      return err.message || 'Something went wrong. Please try again.';
  }
}

// Asks the server whether this address can actually sign in — i.e. whether it
// has both a Cognito login and a CloudMeter account behind it. Also settles any
// pending invite as a side effect. Failures return null so callers can fall
// back to letting Cognito decide rather than blocking a legitimate user.
async function prepareSignIn(email) {
  try {
    const res = await fetch(`${window.CM_CONFIG.apiUrl}/auth/prepare-signin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) return null;
    return (await res.json()).canSignIn !== false;
  } catch (e) {
    console.warn('prepare-signin unavailable', e);
    return null;
  }
}

function setBusy(btn, busyText) {
  btn.dataset.originalText = btn.textContent;
  btn.textContent = busyText;
  btn.disabled = true;
}

function clearBusy(btn) {
  btn.textContent = btn.dataset.originalText || btn.textContent;
  btn.disabled = false;
}

async function goToOtpFromSignup() {
  const name = signupName.value.trim();
  const company = signupCompany.value.trim();
  const email = signupEmail.value.trim();
  if (!name || !company || !isValidEmail(email)) {
    signupError.textContent = 'Enter your name, your company name and a valid work email.';
    signupError.classList.add('show');
    (!name ? signupName : !company ? signupCompany : signupEmail).focus();
    return;
  }
  signupError.classList.remove('show');
  setBusy(signupBtn, 'Creating account…');

  try {
    try {
      await window.CM_Cognito.signUp(email, name);
    } catch (err) {
      // A Cognito login can outlive the CloudMeter account it was created for:
      // removing someone from a team deletes their membership, not their login.
      // Refusing sign-up in that case trapped them — sign-up said "sign in
      // instead" while sign-in said "no access", so their own address could
      // never start an account. Only a login that still has access is a real
      // duplicate; otherwise carry on and give them one.
      const hasAccess = err.code === 'UsernameExistsException'
        ? await prepareSignIn(email)
        : null;
      if (err.code !== 'UsernameExistsException' || hasAccess !== false) throw err;
    }
    pendingCompany = company;
    const authResult = await window.CM_Cognito.initiateAuth(email);
    pendingEmail = email;
    pendingSession = authResult.Session;

    otpTitle.textContent = 'Verify your email';
    otpSub.innerHTML = `We sent a 6-digit code to <strong id="otp-email-target">${esc(email)}</strong> to activate your trial`;
    otpBoxes.forEach(b => (b.value = ''));
    setActiveStep(stepOtp);
    otpBoxes[0].focus();
  } catch (err) {
    signupError.textContent = friendlyAuthError(err);
    signupError.classList.add('show');
  } finally {
    clearBusy(signupBtn);
  }
}

async function goToOtpFromSignin() {
  const email = emailInput.value.trim();
  if (!isValidEmail(email)) {
    emailError.textContent = 'Enter a valid email address.';
    emailError.classList.add('show');
    emailInput.focus();
    return;
  }
  emailError.classList.remove('show');
  setBusy(sendOtpBtn, 'Sending code…');

  try {
    // Settles any pending invite for this address before authenticating:
    // creates the Cognito login if it's missing, and the account membership
    // if that's missing (the two can exist independently — a removed-and-
    // re-invited teammate keeps their login but loses their membership).
    // A null answer means the check itself failed; let Cognito decide then.
    const canSignIn = (await prepareSignIn(email)) !== false;

    // Nobody has invited this address, so there is no CloudMeter account to
    // sign in to. Stay on this step rather than emailing a code and stranding
    // them on an OTP screen that can never let them through.
    if (!canSignIn) {
      emailError.textContent = 'No CloudMeter access for this email. Ask your CloudMeter account owner to invite you, or create a new CloudMeter account with Sign up.';
      emailError.classList.add('show');
      return;
    }

    const authResult = await window.CM_Cognito.initiateAuth(email);
    pendingEmail = email;
    pendingSession = authResult.Session;

    otpTitle.textContent = 'Enter your code';
    otpSub.innerHTML = `We sent a 6-digit code to <strong id="otp-email-target">${esc(email)}</strong>`;
    otpBoxes.forEach(b => (b.value = ''));
    setActiveStep(stepOtp);
    otpBoxes[0].focus();
  } catch (err) {
    emailError.textContent = friendlyAuthError(err);
    emailError.classList.add('show');
  } finally {
    clearBusy(sendOtpBtn);
  }
}

signupBtn.addEventListener('click', goToOtpFromSignup);
signupEmail.addEventListener('keydown', e => { if (e.key === 'Enter') goToOtpFromSignup(); });
signupName.addEventListener('input', () => signupError.classList.remove('show'));
signupEmail.addEventListener('input', () => signupError.classList.remove('show'));

sendOtpBtn.addEventListener('click', goToOtpFromSignin);
emailInput.addEventListener('keydown', e => { if (e.key === 'Enter') goToOtpFromSignin(); });
emailInput.addEventListener('input', () => emailError.classList.remove('show'));

otpBoxes.forEach((box, i) => {
  box.addEventListener('input', () => {
    box.value = box.value.replace(/[^0-9]/g, '').slice(0, 1);
    otpError.classList.remove('show');
    if (box.value && i < otpBoxes.length - 1) otpBoxes[i + 1].focus();
  });
  box.addEventListener('keydown', e => {
    if (e.key === 'Backspace' && !box.value && i > 0) otpBoxes[i - 1].focus();
  });
  box.addEventListener('paste', e => {
    const text = (e.clipboardData || window.clipboardData).getData('text').replace(/[^0-9]/g, '');
    if (!text) return;
    e.preventDefault();
    text.slice(0, 6).split('').forEach((digit, idx) => { if (otpBoxes[idx]) otpBoxes[idx].value = digit; });
    otpBoxes[Math.min(text.length, 6) - 1].focus();
  });
});

// Makes sure a CloudMeter account exists and carries the organization name
// from the form. Runs once, right after the first token is issued. Handles both
// sign-up shapes: a brand-new login (the Cognito trigger already made the
// account, so this just names it) and a login that outlived its old account
// (no membership at all, so this creates one). A failure here means the
// placeholder name sticks until Settings is used — it must never block landing
// on the dashboard.
async function bootstrapAccount() {
  if (!pendingCompany) return;
  try {
    await fetch(`${window.CM_CONFIG.apiUrl}/tenant/bootstrap`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${window.CM_Session.getIdToken()}`,
      },
      body: JSON.stringify({
        name: pendingCompany,
        // The browser already knows this, so it isn't worth a field on the
        // form. It decides when daily digests are sent, and is changeable
        // under Settings.
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    });
  } catch (e) {
    console.warn('Could not finish setting up the CloudMeter account', e);
  }
  pendingCompany = '';
}

async function verifyOtp() {
  const code = otpBoxes.map(b => b.value).join('');
  if (code.length !== 6) {
    otpError.textContent = 'Enter all 6 digits to continue.';
    otpError.classList.add('show');
    return;
  }

  setBusy(verifyBtn, 'Verifying…');
  otpError.classList.remove('show');

  try {
    const result = await window.CM_Cognito.respondToChallenge(pendingEmail, pendingSession, code);

    if (result.AuthenticationResult) {
      window.CM_Session.save({
        idToken: result.AuthenticationResult.IdToken,
        accessToken: result.AuthenticationResult.AccessToken,
        refreshToken: result.AuthenticationResult.RefreshToken,
        email: pendingEmail,
      });
      await bootstrapAccount();
      window.location.href = 'dashboard.html';
      return;
    }

    // Wrong code — Cognito's challenge flow issues a fresh code+session on
    // every retry, so a new email has already been sent.
    pendingSession = result.Session;
    otpError.textContent = "That code didn't work — we've sent you a new one, check your email.";
    otpError.classList.add('show');
    otpBoxes.forEach(b => (b.value = ''));
    otpBoxes[0].focus();
  } catch (err) {
    otpError.textContent = friendlyAuthError(err);
    otpError.classList.add('show');
    if (err.code === 'NotAuthorizedException') {
      setTimeout(() => setActiveStep(authMode === 'signup' ? stepSignup : stepEmail), 1800);
    }
  } finally {
    clearBusy(verifyBtn);
  }
}

verifyBtn.addEventListener('click', verifyOtp);

backBtn.addEventListener('click', () => {
  otpError.classList.remove('show');
  setActiveStep(authMode === 'signup' ? stepSignup : stepEmail);
});

resendBtn.addEventListener('click', async () => {
  resendBtn.disabled = true;
  otpBoxes.forEach(b => (b.value = ''));
  otpError.classList.remove('show');

  try {
    const authResult = await window.CM_Cognito.initiateAuth(pendingEmail);
    pendingSession = authResult.Session;
    resendToast.classList.add('show');
    otpBoxes[0].focus();
  } catch (err) {
    otpError.textContent = friendlyAuthError(err);
    otpError.classList.add('show');
  }

  let seconds = 20;
  const original = 'Resend code';
  resendBtn.textContent = `Resend in ${seconds}s`;
  const tick = setInterval(() => {
    seconds -= 1;
    resendBtn.textContent = seconds > 0 ? `Resend in ${seconds}s` : original;
    if (seconds <= 0) {
      clearInterval(tick);
      resendBtn.disabled = false;
      resendToast.classList.remove('show');
    }
  }, 1000);
});
