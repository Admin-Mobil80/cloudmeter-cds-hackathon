// CloudMeter BMS — staff access. Adding and removing is the root owner's.

let USERS = [];

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function relative(iso) {
  if (!iso) return 'never signed in';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (Number.isNaN(mins)) return 'never signed in';
  if (mins < 60) return `active ${Math.max(mins, 0)} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `active ${hrs} hr ago`;
  const days = Math.round(hrs / 24);
  return `active ${days === 1 ? 'yesterday' : `${days} days ago`}`;
}

function render() {
  const me = window.BMS_ME || {};
  const isRoot = me.role === 'root';
  document.getElementById('add-user-card').hidden = !isRoot;

  const list = document.getElementById('user-list');
  list.removeAttribute('aria-busy');
  list.innerHTML = USERS.map(u => `
    <div class="member-row">
      <span class="member-avatar">${esc((u.name || u.email).split(/\s+/).filter(Boolean).slice(0,2).map(w => w[0].toUpperCase()).join('') || 'U')}</span>
      <div class="member-info">
        <div class="name">${esc(u.name || u.email)}${u.email === me.email ? ' <span class="member-you-tag">You</span>' : ''}</div>
        <div class="email">${esc(u.email)}</div>
      </div>
      <span class="badge ${u.role === 'root' ? 'badge-good' : 'badge-neutral'}">${u.role === 'root' ? 'Solution owner' : 'Staff'}</span>
      <span class="member-meta">${esc(relative(u.lastActiveAt))}</span>
      ${isRoot && u.role !== 'root' && u.email !== me.email
        ? `<button class="member-remove-btn" data-remove="${esc(u.email)}">Remove</button>`
        : ''}
    </div>`).join('');

  list.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const email = btn.dataset.remove;
      if (!window.confirm(`Remove ${email} from the BMS?\n\nTheir sign-in is deleted too.`)) return;
      btn.disabled = true;
      try {
        await window.CM_Api.delete(`/bms/users/${encodeURIComponent(email)}`);
        USERS = USERS.filter(u => u.email !== email);
        render();
      } catch (err) {
        btn.disabled = false;
        window.alert(err.message || 'Could not remove that user.');
      }
    });
  });
}

async function load() {
  ({ users: USERS } = await window.CM_Api.get('/bms/users'));
  render();
}

document.addEventListener('bms-me-loaded', async () => {
  try {
    await load();
  } catch (err) {
    document.getElementById('user-list').innerHTML =
      `<p class="muted" style="padding:28px;text-align:center">Couldn't load users — ${esc(err.message || '')}</p>`;
    return;
  }

  const btn = document.getElementById('add-user-btn');
  btn?.addEventListener('click', async () => {
    const email = document.getElementById('new-email').value.trim().toLowerCase();
    const name = document.getElementById('new-name').value.trim();
    const err = document.getElementById('add-error');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      err.textContent = 'Enter a valid email address.';
      err.classList.add('show');
      return;
    }
    err.classList.remove('show');
    btn.disabled = true;
    btn.textContent = 'Adding…';
    try {
      await window.CM_Api.post('/bms/users', { email, name });
      document.getElementById('new-email').value = '';
      document.getElementById('new-name').value = '';
      await load();
    } catch (e) {
      err.textContent = e.message || 'Could not add that user.';
      err.classList.add('show');
    }
    btn.disabled = false;
    btn.textContent = 'Add user';
  });
});
