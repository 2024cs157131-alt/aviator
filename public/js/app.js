/**
 * app.js — Crown Pesa Aviator Client
 * Handles: WebSocket, Auth, Betting, Wallet, UI
 * Does NOT draw (canvas.js owns all drawing)
 */

// ── GLOBAL STATE ─────────────────────────────────────────────
let socket        = null;
let currentUser   = null;
let gameStatus    = 'idle';
let currentRoundId = null;
let betState      = { 1: null, 2: null };
let PAYSTACK_PUBLIC_KEY = '';

// ── SOCKET ───────────────────────────────────────────────────
function connectSocket() {
  if (socket) { socket.removeAllListeners(); socket.disconnect(); }

  socket = io({ transports: ['websocket', 'polling'] });

  socket.on('connect', () => console.log('✅ WS connected:', socket.id));
  socket.on('disconnect', () => console.warn('WS disconnected'));

  socket.on('game:state', (snap) => {
    currentRoundId = snap.roundId || null;
    const lbl = document.getElementById('round-label');
    if (lbl) lbl.textContent = snap.roundId ? `ROUND #${snap.roundId}` : 'ROUND #—';

    if (snap.status === 'waiting') {
      gameStatus = 'waiting';
      Canvas.showWaiting(snap.waitUntil);
      updateBetButtons('waiting');
    } else if (snap.status === 'in_progress') {
      gameStatus = 'flying';
      const drift = snap.serverNow ? (Date.now() - snap.serverNow) : 0;
      Canvas.showFlying(snap.startedAt + drift);
      updateBetButtons('flying');
    } else if (snap.status === 'crashed') {
      gameStatus = 'crashed';
      Canvas.showCrash(snap.crashPoint);
      updateBetButtons('idle');
    } else {
      Canvas.showIdle();
    }
  });

  socket.on('round:waiting', (data) => {
    currentRoundId = data.roundId;
    gameStatus     = 'waiting';
    const lbl = document.getElementById('round-label');
    if (lbl) lbl.textContent = `ROUND #${data.roundId}`;
    [1,2].forEach(s => { if (betState[s] !== 'placed') betState[s] = null; });
    Canvas.showWaiting(data.waitUntil);
    updateBetButtons('waiting');
  });

  socket.on('round:start', (data) => {
    gameStatus = 'flying';
    Canvas.showFlying(data.startedAt);
    updateBetButtons('flying');
  });

  socket.on('round:crash', (data) => {
    gameStatus = 'crashed';
    Canvas.showCrash(data.crashPoint);
    updateBetButtons('idle');
    addHistoryChip(data.crashPoint);
    [1,2].forEach(s => {
      if (betState[s] === 'placed') {
        betState[s] = null;
        setBetBtn(s, 'idle', 'BET');
        toast(`💥 Crashed at ${parseFloat(data.crashPoint).toFixed(2)}x! Bet ${s} lost.`, 'err');
      }
    });
    if (currentUser) fetchMe();
  });

  socket.on('bet:placed',  (d) => addLiveBetRow(d.username, d.amount));
  socket.on('bet:cashout', (d) => updateLiveBetRow(d.username, d.cashout_at, false));

  socket.on('bet:confirm', (d) => {
    if (currentUser) { currentUser.balance = d.newBalance; updateBalanceUI(); }
  });

  socket.on('cashout:confirm', (d) => {
    [1,2].forEach(s => {
      if (betState[s] === 'placed') {
        betState[s] = null;
        setBetBtn(s, 'idle', 'BET');
        const sym = currentUser?.currency?.sym || '';
        toast(`🎉 Cashed out at ${parseFloat(d.cashout_at).toFixed(2)}x! Won ${sym}${parseFloat(d.win).toFixed(2)}`, 'win');
        if (currentUser) { currentUser.balance = d.newBalance; updateBalanceUI(); }
      }
    });
  });

  socket.on('error', (d) => {
    toast(d.msg || 'Server error', 'err');
    [1,2].forEach(s => { if (betState[s] === null) setBetBtn(s, 'idle', 'BET'); });
  });

  socket.on('game:history', (rounds) => renderHistoryBar(rounds));
}

// ── BET BUTTONS ──────────────────────────────────────────────
function updateBetButtons(phase) {
  [1,2].forEach(s => {
    const bs = betState[s];
    if (phase === 'waiting') {
      if (!bs)             setBetBtn(s, 'idle',    'BET');
      if (bs === 'placed') setBetBtn(s, 'placed',  '✓ PLACED');
    } else if (phase === 'flying') {
      if (bs === 'placed') setBetBtn(s, 'cashout', 'CASH OUT');
      if (!bs)             setBetBtn(s, 'idle',    'BET');
    } else {
      if (!bs) setBetBtn(s, 'idle', 'BET');
    }
  });
}

function setBetBtn(s, cls, html) {
  const btn = document.getElementById(`bet-btn-${s}`);
  if (!btn) return;
  btn.className = `bet-btn ${cls}`;
  btn.innerHTML = html;
}

// ── BET PANEL ────────────────────────────────────────────────
const BetPanel = {
  adj(s, d) {
    const el = document.getElementById(`bet-amt-${s}`);
    el.value = Math.max(1, parseFloat(el.value || 0) + d);
  },
  set(s, v) { document.getElementById(`bet-amt-${s}`).value = v; },
  dbl(s) {
    const el = document.getElementById(`bet-amt-${s}`);
    el.value = parseFloat(el.value || 1) * 2;
  },
  togAc(s) {
    const checked = document.getElementById(`ac-${s}`).checked;
    document.getElementById(`ao-${s}`).disabled = !checked;
  },
  act(s) {
    if (!currentUser) { App.openModal('modal-login'); return; }
    if (betState[s] === null) {
      if (gameStatus !== 'waiting') { toast('Wait for next round!', 'err'); return; }
      const amount      = parseFloat(document.getElementById(`bet-amt-${s}`).value) || 0;
      const acChecked   = document.getElementById(`ac-${s}`).checked;
      const autoCashout = acChecked ? parseFloat(document.getElementById(`ao-${s}`).value) : 0;
      if (amount <= 0) { toast('Enter a valid amount', 'err'); return; }
      betState[s] = 'placed';
      setBetBtn(s, 'placed', '✓ PLACED');
      socket.emit('bet:place', { amount, autoCashout });
    } else if (betState[s] === 'placed' && gameStatus === 'flying') {
      setBetBtn(s, 'loading', '...');
      socket.emit('bet:cashout', { roundId: currentRoundId });
    }
  },
};

// ── AUTH ─────────────────────────────────────────────────────
const Auth = {
  async login() {
    const email = document.getElementById('li-email').value.trim();
    const pass  = document.getElementById('li-pass').value;
    if (!email || !pass) { showAlert('login-alert', 'Email and password required', 'error'); return; }

    const btn = document.getElementById('li-btn');
    btn.disabled = true; btn.textContent = 'Logging in…';

    const data = await post('/api/login', { email, password: pass });
    btn.disabled = false; btn.textContent = 'LOGIN';

    if (data.ok) {
      currentUser = data.user;
      App.closeModal('modal-login');
      onUserLogin();
    } else {
      showAlert('login-alert', data.msg || 'Login failed', 'error');
    }
  },

  async register() {
    const u = document.getElementById('reg-user').value.trim();
    const e = document.getElementById('reg-email').value.trim();
    const p = document.getElementById('reg-pass').value;
    const c = document.getElementById('reg-country').value;

    // Clear previous alert
    hideAlert('reg-alert');

    if (!u || !e || !p) { showAlert('reg-alert', 'All fields are required', 'error'); return; }
    if (u.length < 3)   { showAlert('reg-alert', 'Username must be at least 3 characters', 'error'); return; }
    if (p.length < 8)   { showAlert('reg-alert', 'Password must be at least 8 characters', 'error'); return; }
    if (!e.includes('@')){ showAlert('reg-alert', 'Enter a valid email address', 'error'); return; }

    const btn = document.getElementById('reg-btn');
    btn.disabled = true; btn.textContent = 'Creating account…';

    const data = await post('/api/register', { username: u, email: e, password: p, country: c });
    btn.disabled = false; btn.textContent = 'CREATE ACCOUNT';

    if (data.ok) {
      currentUser = data.user;
      App.closeModal('modal-register');
      onUserLogin();
      toast(`Welcome, ${data.user.username}! 🎉`, 'ok');
    } else {
      showAlert('reg-alert', data.msg || 'Registration failed — try a different username or email', 'error');
    }
  },

  async logout() {
    await post('/api/logout', {});
    currentUser = null;
    betState    = { 1: null, 2: null };
    document.getElementById('nav-user').classList.add('hidden');
    document.getElementById('nav-guest').classList.remove('hidden');
    setModeBar('fun');
    setBetBtn(1, 'idle', 'BET');
    setBetBtn(2, 'idle', 'BET');
    connectSocket(); // reconnect as guest
  },
};

// ── ON LOGIN — switches UI to LIVE MODE ──────────────────────
function onUserLogin() {
  document.getElementById('nav-guest').classList.add('hidden');
  document.getElementById('nav-user').classList.remove('hidden');
  setModeBar('live');
  updateBalanceUI();
  if (currentUser.isAdmin) {
    document.getElementById('btn-admin').classList.remove('hidden');
  }
  // Reconnect socket so server picks up the new session cookie
  // connectSocket() re-registers ALL handlers so game events keep working
  connectSocket();
}

function setModeBar(mode) {
  const bar  = document.getElementById('mode-bar');
  const dot  = document.getElementById('mode-dot');
  const text = document.getElementById('mode-text');
  if (mode === 'live') {
    bar.className  = 'mode-bar live';
    dot.style.color = '#00cc44';
    text.textContent = 'LIVE MODE';
  } else {
    bar.className  = 'mode-bar fun';
    dot.style.color = '#ff8800';
    text.textContent = 'FUN MODE — Register to play';
  }
}

function updateBalanceUI() {
  if (!currentUser) return;
  const sym = currentUser.currency?.sym || 'KSh';
  const bal = parseFloat(currentUser.balance || 0).toFixed(2);
  document.getElementById('nav-sym').textContent = sym;
  document.getElementById('nav-bal').textContent = bal;
  document.getElementById('w-sym').textContent   = sym;
  document.getElementById('w-bal').textContent   = bal;
}

async function fetchMe() {
  const data = await get('/api/me');
  if (data.ok) { currentUser = data.user; updateBalanceUI(); }
}

// ── WALLET ───────────────────────────────────────────────────
const Wallet = {
  showTab(t) {
    document.getElementById('w-dep').classList.toggle('hidden', t !== 'dep');
    document.getElementById('w-wit').classList.toggle('hidden', t !== 'wit');
    if (t === 'wit') this.loadBanks();
  },
  async loadBanks() {
    const data = await get('/api/banks');
    if (!data.ok) return;
    const sel = document.getElementById('wit-bank');
    sel.innerHTML = data.banks.map(b => `<option>${b}</option>`).join('');
  },
  async deposit() {
    const amt = parseFloat(document.getElementById('dep-amt').value);
    if (!amt || amt <= 0) { showAlert('dep-alert', 'Enter a valid amount', 'error'); return; }
    const btn = document.getElementById('dep-btn');
    btn.disabled = true; btn.textContent = 'Initializing…';
    const data = await post('/api/deposit/init', { amount: amt });
    btn.disabled = false; btn.textContent = 'PAY WITH PAYSTACK';
    if (data.ok && data.url) {
      const handler = PaystackPop.setup({
        key:      PAYSTACK_PUBLIC_KEY,
        email:    currentUser?.email || '',
        amount:   Math.round(amt * 100),
        currency: currentUser?.currency?.code || 'KES',
        ref:      data.reference,
        callback: async (resp) => {
          const v = await get(`/api/deposit/verify/${resp.reference}`);
          if (v.ok) {
            toast(`✅ Deposit of ${currentUser.currency.sym}${amt} successful!`, 'ok');
            currentUser.balance = v.newBalance;
            updateBalanceUI();
            App.closeModal('modal-wallet');
          } else {
            toast(v.msg || 'Verification failed', 'err');
          }
        },
        onClose: () => {},
      });
      handler.openIframe();
    } else {
      showAlert('dep-alert', data.msg || 'Payment failed', 'error');
    }
  },
  async withdraw() {
    const amt  = parseFloat(document.getElementById('wit-amt').value);
    const bank = document.getElementById('wit-bank').value;
    const acct = document.getElementById('wit-acct').value.trim();
    const name = document.getElementById('wit-name').value.trim();
    if (!amt || !bank || !acct || !name) { showAlert('wit-alert', 'All fields required', 'error'); return; }
    const btn = document.getElementById('wit-btn');
    btn.disabled = true; btn.textContent = 'Submitting…';
    const data = await post('/api/withdraw', { amount: amt, bank_name: bank, account_number: acct, account_name: name });
    btn.disabled = false; btn.textContent = 'SUBMIT WITHDRAWAL';
    if (data.ok) { toast(data.msg, 'ok'); fetchMe(); App.closeModal('modal-wallet'); }
    else         { showAlert('wit-alert', data.msg || 'Failed', 'error'); }
  },
};

// ── SIDEBAR ──────────────────────────────────────────────────
const liveBets = {};

const Sidebar = {
  show(tab, el) {
    document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
    el.classList.add('active');
    const body = document.getElementById('sidebar-body');
    if (tab === 'my') {
      body.innerHTML = currentUser
        ? '<p class="empty-msg">Bet history coming soon.</p>'
        : '<p class="empty-msg">Login to see your bets.</p>';
    } else {
      body.innerHTML = Object.keys(liveBets).length
        ? Object.values(liveBets).map(r => r.outerHTML).join('')
        : '<p class="empty-msg">Waiting for round...</p>';
    }
  },
};

function addLiveBetRow(username, amount) {
  const body = document.getElementById('sidebar-body');
  if (body.querySelector('.empty-msg')) body.innerHTML = '';
  const sym = currentUser?.currency?.sym || '';
  const div = document.createElement('div');
  div.className = 'live-bet-row';
  div.id        = `lbr-${username}`;
  div.innerHTML = `
    <div class="lbr-user">${username}</div>
    <div>
      <div class="lbr-amt">${sym}${parseFloat(amount).toFixed(2)}</div>
      <div class="lbr-co" id="lbr-co-${username}"></div>
    </div>`;
  body.insertBefore(div, body.firstChild);
  liveBets[username] = div;
}

function updateLiveBetRow(username, cashoutAt, lost) {
  const co = document.getElementById(`lbr-co-${username}`);
  if (!co) return;
  co.className   = lost ? 'lbr-lost' : 'lbr-co';
  co.textContent = lost ? '💥 lost' : `✓ ${parseFloat(cashoutAt).toFixed(2)}x`;
}

// ── HISTORY BAR ──────────────────────────────────────────────
function renderHistoryBar(rounds) {
  const bar = document.getElementById('history-bar');
  if (!bar) return;
  bar.innerHTML = (rounds || []).map(r => chipHTML(r.crash_point)).join('');
}

function addHistoryChip(cp) {
  const bar = document.getElementById('history-bar');
  if (!bar) return;
  const chip = document.createElement('span');
  chip.className   = chipClass(cp);
  chip.textContent = parseFloat(cp).toFixed(2) + 'x';
  bar.insertBefore(chip, bar.firstChild);
  while (bar.children.length > 20) bar.removeChild(bar.lastChild);
}

function chipClass(cp) {
  cp = parseFloat(cp);
  return 'h-chip ' + (cp >= 10 ? 'h-moon' : cp >= 3 ? 'h-high' : cp >= 2 ? 'h-mid' : 'h-low');
}

function chipHTML(cp) {
  return `<span class="${chipClass(cp)}">${parseFloat(cp).toFixed(2)}x</span>`;
}

// ── APP (modals) ──────────────────────────────────────────────
const App = {
  openModal(id)       { document.getElementById(id)?.classList.add('open'); },
  closeModal(id)      { document.getElementById(id)?.classList.remove('open'); },
  swapModal(a, b)     { this.closeModal(a); this.openModal(b); },
};

// Close on backdrop click
document.querySelectorAll('.modal-backdrop').forEach(m => {
  m.addEventListener('click', e => { if (e.target === m) App.closeModal(m.id); });
});

document.getElementById('btn-logout')?.addEventListener('click', e => {
  e.preventDefault(); Auth.logout();
});

document.getElementById('btn-admin')?.addEventListener('click', () => {
  App.openModal('modal-admin'); loadAdminPanel();
});

// ── ADMIN ─────────────────────────────────────────────────────
async function loadAdminPanel() {
  const data = await get('/api/admin/stats');
  const el   = document.getElementById('admin-content');
  if (!data.ok) { el.innerHTML = '<p style="color:#f44">Not authorised</p>'; return; }
  el.innerHTML = `
    <div class="admin-stat-grid">
      <div class="admin-stat"><div class="val">${data.totalUsers}</div><div class="lbl">Users</div></div>
      <div class="admin-stat"><div class="val">${parseFloat(data.totalDeposits||0).toFixed(0)}</div><div class="lbl">Deposits</div></div>
      <div class="admin-stat"><div class="val">${data.totalRounds}</div><div class="lbl">Rounds</div></div>
    </div>
    <div class="admin-crash-ctrl">
      <div style="flex:1"><strong style="color:#f44">⚠ Force Next Crash</strong><br>
        <small style="color:#888">One round only, then resets.</small></div>
      <input type="number" id="admin-cp" value="2.00" min="1.01" max="100" step="0.01"
             style="width:80px;background:#111;border:1px solid #444;color:#fff;padding:6px;border-radius:5px">
      <button class="btn btn-red" onclick="adminSetCrash()">Set</button>
    </div>
    <div class="admin-section">
      <h3>Pending Withdrawals (${(data.pendingWithdrawals||[]).length})</h3>
      ${!(data.pendingWithdrawals||[]).length ? '<p style="color:#555;font-size:13px">None pending.</p>' :
        `<table class="admin-table"><thead><tr><th>User</th><th>Amount</th><th>Bank</th><th>Actions</th></tr></thead><tbody>
        ${data.pendingWithdrawals.map(t => `<tr>
          <td>${t.username}</td><td>${t.amount} ${t.currency_code}</td>
          <td>${t.bank_name||'-'} / ${t.account_number||'-'}</td>
          <td>
            <button class="btn btn-green btn-sm" onclick="adminWithdrawal(${t.id},'approve')">✓ Approve</button>
            <button class="btn btn-red btn-sm" onclick="adminWithdrawal(${t.id},'reject')">✗ Reject</button>
          </td></tr>`).join('')}
        </tbody></table>`}
    </div>`;
}

async function adminSetCrash() {
  const pt = parseFloat(document.getElementById('admin-cp').value);
  const r  = await post('/api/admin/set-crash', { point: pt });
  toast(r.ok ? `Next crash set to ${pt}x` : (r.msg || 'Error'), r.ok ? 'ok' : 'err');
}

async function adminWithdrawal(id, action) {
  const r = await post(`/api/admin/withdrawal/${action}`, { txId: id });
  toast(r.ok ? `Withdrawal ${action}d` : (r.msg || 'Error'), r.ok ? 'ok' : 'err');
  loadAdminPanel();
}

// ── HELPERS ───────────────────────────────────────────────────
async function get(url) {
  try { const r = await fetch(url); return await r.json(); }
  catch(e) { return { ok: false, msg: e.message }; }
}

async function post(url, data) {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return await r.json();
  } catch(e) { return { ok: false, msg: e.message }; }
}

function toast(msg, type = 'ok') {
  const c  = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className   = `toast ${type}`;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

function showAlert(id, msg, type) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className   = `form-alert ${type}`;
  el.textContent = msg;
  el.style.display = 'block';
  el.classList.remove('hidden');
}

function hideAlert(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.display = 'none';
  el.classList.add('hidden');
}

// ── EXPOSE GLOBALS (must be top-level, before async boot) ────
window.App      = App;
window.Auth     = Auth;
window.BetPanel = BetPanel;
window.Wallet   = Wallet;
window.Sidebar  = Sidebar;

// ── BOOT ─────────────────────────────────────────────────────
(async () => {
  // Fetch config (Paystack key)
  const config = await get('/api/config');
  if (config?.paystackKey) PAYSTACK_PUBLIC_KEY = config.paystackKey;

  // Check existing session
  const me = await get('/api/me');
  if (me.ok && me.user) {
    currentUser = me.user;
    onUserLogin(); // this calls connectSocket() internally
  } else {
    connectSocket(); // connect as guest
  }
})();