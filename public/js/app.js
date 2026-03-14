/**
 * app.js — Crown Pesa Client
 *
 * Handles:
 *   - WebSocket connection (Socket.io)
 *   - Auth (login / register)
 *   - Betting & cashout (via WebSocket)
 *   - Wallet (deposit / withdraw via REST)
 *   - UI state (modals, toasts, sidebar)
 *
 * Does NOT:
 *   - Draw anything (canvas.js owns all drawing)
 *   - Calculate crash points
 */

// ── GLOBAL STATE ────────────────────────────────────────────
let socket     = null;
let currentUser = null;   // { id, username, balance, currency, isAdmin }
let gameStatus = 'idle';  // 'waiting'|'flying'|'crashed'|'idle'
let currentRoundId = null;
let betState   = { 1: null, 2: null }; // null|'placed'|'won'|'lost'

// ── SOCKET CONNECTION ────────────────────────────────────────
function connectSocket() {
  socket = io({ transports: ['websocket', 'polling'] });

  socket.on('connect', () => {
    console.log('✅ WebSocket connected:', socket.id);
  });

  socket.on('disconnect', () => {
    console.warn('WebSocket disconnected — reconnecting…');
  });

  // ── GAME EVENTS ──────────────────────────────────────────

  // Full state snapshot on join
  socket.on('game:state', (snap) => {
    console.log('[game:state]', snap);
    document.getElementById('round-label').textContent =
      snap.roundId ? `ROUND #${snap.roundId}` : 'ROUND #—';
    currentRoundId = snap.roundId;

    if (snap.status === 'waiting') {
      gameStatus = 'waiting';
      Canvas.showWaiting(snap.waitUntil);
      updateBetButtons('waiting');
    } else if (snap.status === 'in_progress') {
      gameStatus = 'flying';
      // serverNow corrects for clock drift
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

  // New round waiting
  socket.on('round:waiting', (data) => {
    console.log('[round:waiting]', data);
    currentRoundId = data.roundId;
    gameStatus     = 'waiting';

    document.getElementById('round-label').textContent = `ROUND #${data.roundId}`;

    // Reset bets that finished
    [1,2].forEach(s => {
      if (betState[s] !== 'placed') { betState[s] = null; }
    });
    Canvas.showWaiting(data.waitUntil);
    updateBetButtons('waiting');
  });

  // Round started — server sends the exact ms timestamp
  socket.on('round:start', (data) => {
    console.log('[round:start]', data);
    gameStatus = 'flying';
    Canvas.showFlying(data.startedAt);
    updateBetButtons('flying');
  });

  // Crash — server reveals crash point + seed
  socket.on('round:crash', (data) => {
    console.log('[round:crash]', data);
    gameStatus = 'crashed';
    Canvas.showCrash(data.crashPoint);
    updateBetButtons('idle');

    // Add chip to history bar
    addHistoryChip(data.crashPoint);

    // Handle any placed bets that were not cashed out
    [1,2].forEach(s => {
      if (betState[s] === 'placed') {
        betState[s] = 'lost';
        setBetBtn(s, 'idle', 'BET');
        toast(`💥 Crashed at ${parseFloat(data.crashPoint).toFixed(2)}x! Bet ${s} lost.`, 'err');
      }
    });

    if (currentUser) fetchMe(); // refresh balance
  });

  // Someone placed a bet (shown in live bets sidebar)
  socket.on('bet:placed', (data) => {
    addLiveBetRow(data.username, data.amount, null);
  });

  // Someone cashed out
  socket.on('bet:cashout', (data) => {
    updateLiveBetRow(data.username, data.cashout_at, false);
  });

  // My bet confirmed
  socket.on('bet:confirm', (data) => {
    // Handled inline in betAct
    currentUser.balance = data.newBalance;
    updateBalanceUI();
  });

  // My cashout confirmed
  socket.on('cashout:confirm', (data) => {
    [1,2].forEach(s => {
      if (betState[s] === 'placed') {
        betState[s] = null;
        setBetBtn(s, 'idle', 'BET');
        toast(`🎉 Cashed out at ${data.cashout_at.toFixed(2)}x! Won ${currentUser.currency.sym}${data.win.toFixed(2)}`, 'win');
        currentUser.balance = data.newBalance;
        updateBalanceUI();
      }
    });
  });

  // Server error
  socket.on('error', (data) => {
    toast(data.msg || 'Server error', 'err');
    // Reset loading buttons
    [1,2].forEach(s => {
      if (betState[s] === null) setBetBtn(s, 'idle', 'BET');
    });
  });

  // History on join
  socket.on('game:history', (rounds) => {
    renderHistoryBar(rounds);
  });
}

// ── BET BUTTONS ─────────────────────────────────────────────
function updateBetButtons(phase) {
  [1,2].forEach(s => {
    const bs = betState[s];
    if (phase === 'waiting') {
      if (bs === null)     setBetBtn(s, 'idle', 'BET');
      if (bs === 'placed') setBetBtn(s, 'placed', '✓ BET PLACED');
    } else if (phase === 'flying') {
      if (bs === 'placed') setBetBtn(s, 'cashout', 'CASH OUT');
      if (bs === null)     setBetBtn(s, 'idle', 'BET'); // can't bet mid-round but keep it looking normal
    } else {
      if (bs === null) setBetBtn(s, 'idle', 'BET');
    }
  });
}

function setBetBtn(s, cls, html) {
  const btn = document.getElementById(`bet-btn-${s}`);
  if (!btn) return;
  btn.className   = `bet-btn ${cls}`;
  btn.innerHTML   = html;
}

// ── BET ACTIONS ─────────────────────────────────────────────
const BetPanel = {
  adj(s, d) {
    const el = document.getElementById(`bet-amt-${s}`);
    el.value = Math.max(1, parseFloat(el.value || 0) + d);
  },
  set(s, v) { document.getElementById(`bet-amt-${s}`).value = v; },
  dbl(s)    {
    const el = document.getElementById(`bet-amt-${s}`);
    el.value = parseFloat(el.value || 1) * 2;
  },
  togAc(s)  {
    const checked = document.getElementById(`ac-${s}`).checked;
    document.getElementById(`ao-${s}`).disabled = !checked;
  },

  act(s) {
    if (!currentUser) { App.openModal('modal-login'); return; }

    if (betState[s] === null) {
      // Place bet
      if (gameStatus !== 'waiting') { toast('Wait for the next round!', 'err'); return; }
      const amount      = parseFloat(document.getElementById(`bet-amt-${s}`).value) || 0;
      const acChecked   = document.getElementById(`ac-${s}`).checked;
      const autoCashout = acChecked ? parseFloat(document.getElementById(`ao-${s}`).value) : 0;

      if (amount <= 0) { toast('Enter a valid amount', 'err'); return; }

      setBetBtn(s, 'loading', '...');
      socket.emit('bet:place', { amount, autoCashout });

      // Optimistic: mark as placed immediately (error event will reset)
      betState[s] = 'placed';
      setBetBtn(s, 'placed', '✓ BET PLACED');

    } else if (betState[s] === 'placed' && gameStatus === 'flying') {
      // Cash out
      setBetBtn(s, 'loading', '...');
      socket.emit('bet:cashout', { roundId: currentRoundId });
      // cashout:confirm will handle the response
    }
  },
};

// ── AUTH ─────────────────────────────────────────────────────
const Auth = {
  async login() {
    const email = document.getElementById('li-email').value.trim();
    const pass  = document.getElementById('li-pass').value;
    if (!email || !pass) { setAlert('login-alert', 'Email and password required', 'error'); return; }

    const btn = document.getElementById('li-btn');
    btn.disabled = true; btn.textContent = 'Logging in…';

    const data = await post('/api/login', { email, password: pass });
    btn.disabled = false; btn.textContent = 'LOGIN';

    if (data.ok) {
      currentUser = data.user;
      App.closeModal('modal-login');
      onUserLogin();
    } else {
      setAlert('login-alert', data.msg || 'Login failed', 'error');
    }
  },

  async register() {
    const u = document.getElementById('reg-user').value.trim();
    const e = document.getElementById('reg-email').value.trim();
    const p = document.getElementById('reg-pass').value;
    const c = document.getElementById('reg-country').value;

    if (!u||!e||!p) { setAlert('reg-alert','All fields required','error'); return; }
    if (p.length < 6) { setAlert('reg-alert','Password min 6 characters','error'); return; }

    const btn = document.getElementById('reg-btn');
    btn.disabled = true; btn.textContent = 'Creating…';

    const data = await post('/api/register', { username:u, email:e, password:p, country:c });
    btn.disabled = false; btn.textContent = 'CREATE ACCOUNT';

    if (data.ok) {
      currentUser = data.user;
      App.closeModal('modal-register');
      onUserLogin();
      toast(`Welcome, ${data.user.username}!`, 'ok');
    } else {
      setAlert('reg-alert', data.msg || 'Registration failed', 'error');
    }
  },

  async logout() {
    await post('/api/logout', {});
    currentUser = null;
    betState    = { 1: null, 2: null };
    document.getElementById('nav-user').classList.add('hidden');
    document.getElementById('nav-guest').classList.remove('hidden');
    document.getElementById('mode-bar').className = 'mode-bar fun';
    document.getElementById('mode-text').textContent = 'FUN MODE — Register to play';
    setBetBtn(1, 'idle', 'BET'); setBetBtn(2, 'idle', 'BET');
  },
};

function onUserLogin() {
  document.getElementById('nav-guest').classList.add('hidden');
  document.getElementById('nav-user').classList.remove('hidden');
  document.getElementById('mode-bar').className = 'mode-bar live';
  document.getElementById('mode-text').textContent = 'LIVE MODE';
  if (currentUser.isAdmin) {
    document.getElementById('btn-admin').classList.remove('hidden');
  }
  updateBalanceUI();

  // Reconnect socket so session is picked up
  if (socket) { socket.disconnect(); socket.connect(); }
}

function updateBalanceUI() {
  if (!currentUser) return;
  document.getElementById('nav-sym').textContent = currentUser.currency.sym;
  document.getElementById('nav-bal').textContent = parseFloat(currentUser.balance).toFixed(2);
  document.getElementById('w-sym').textContent   = currentUser.currency.sym;
  document.getElementById('w-bal').textContent   = parseFloat(currentUser.balance).toFixed(2);
}

async function fetchMe() {
  const data = await get('/api/me');
  if (data.ok) {
    currentUser = data.user;
    updateBalanceUI();
  }
}

// ── WALLET ────────────────────────────────────────────────
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
    sel.innerHTML = data.banks
      .map(b => `<option>${b.name}${b.type==='mobile'?' 📱':' 🏦'}</option>`)
      .join('');
  },

  async deposit() {
    const amt = parseFloat(document.getElementById('dep-amt').value);
    if (!amt) { setAlert('dep-alert','Enter amount','error'); return; }
    const btn = document.getElementById('dep-btn');
    btn.disabled = true; btn.textContent = 'Initializing…';

    const data = await post('/api/deposit/init', { amount: amt });
    btn.disabled = false; btn.textContent = 'PAY WITH PAYSTACK';

    if (data.ok && data.url) {
      const handler = PaystackPop.setup({
        key:      PAYSTACK_PUBLIC_KEY,
        email:    currentUser.email || '',
        amount:   Math.round(amt * 100),
        currency: currentUser.currency.code,
        ref:      data.reference,
        callback: async (resp) => {
          const v = await get(`/api/deposit/verify/${resp.reference}`);
          if (v.ok) {
            toast('✅ Deposit successful!', 'ok');
            currentUser.balance = v.newBalance;
            updateBalanceUI();
            App.closeModal('modal-wallet');
          } else {
            toast(v.msg || 'Verification failed', 'err');
          }
        },
        onClose: () => toast('Payment cancelled', 'err'),
      });
      handler.openIframe();
    } else {
      setAlert('dep-alert', data.msg || 'Failed', 'error');
    }
  },

  async withdraw() {
    const amt  = parseFloat(document.getElementById('wit-amt').value);
    const bank = document.getElementById('wit-bank').value;
    const acct = document.getElementById('wit-acct').value.trim();
    const name = document.getElementById('wit-name').value.trim();
    if (!amt||!bank||!acct||!name) { setAlert('wit-alert','All fields required','error'); return; }

    const btn = document.getElementById('wit-btn');
    btn.disabled = true; btn.textContent = 'Submitting…';
    const data = await post('/api/withdraw', { amount:amt, bank_name:bank, account_number:acct, account_name:name });
    btn.disabled = false; btn.textContent = 'SUBMIT WITHDRAWAL';

    if (data.ok) {
      toast(data.msg, 'ok'); fetchMe(); App.closeModal('modal-wallet');
    } else {
      setAlert('wit-alert', data.msg || 'Failed', 'error');
    }
  },
};

// Expose Paystack public key (set by server via meta tag or inline)
let PAYSTACK_PUBLIC_KEY = '';

// ── SIDEBAR ──────────────────────────────────────────────────
const liveBets = {}; // username → row element

const Sidebar = {
  show(tab, el) {
    document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
    el.classList.add('active');
    const body = document.getElementById('sidebar-body');
    if (tab === 'my') {
      this.loadMyBets();
    } else {
      body.innerHTML = Object.keys(liveBets).length
        ? Object.values(liveBets).map(r => r.outerHTML).join('')
        : '<p class="empty-msg">Waiting for round...</p>';
    }
  },

  async loadMyBets() {
    const body = document.getElementById('sidebar-body');
    if (!currentUser) { body.innerHTML = '<p class="empty-msg">Login to see your bets.</p>'; return; }
    const data = await get('/api/me'); // will add bets endpoint
    body.innerHTML = '<p class="empty-msg">Bet history coming soon.</p>';
  },
};

function addLiveBetRow(username, amount, cashoutAt) {
  const body = document.getElementById('sidebar-body');
  if (body.querySelector('.empty-msg')) body.innerHTML = '';

  const sym = currentUser?.currency?.sym || '';
  const div = document.createElement('div');
  div.className    = 'live-bet-row';
  div.id           = `lbr-${username}`;
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
  if (lost) {
    co.className   = 'lbr-lost';
    co.textContent = '💥 lost';
  } else {
    co.className   = 'lbr-co';
    co.textContent = `✓ ${parseFloat(cashoutAt).toFixed(2)}x`;
  }
}

// ── HISTORY BAR ─────────────────────────────────────────────
function renderHistoryBar(rounds) {
  const bar = document.getElementById('history-bar');
  bar.innerHTML = rounds.map(r => chipHTML(r.crash_point)).join('');
}

function addHistoryChip(cp) {
  const bar  = document.getElementById('history-bar');
  const chip = document.createElement('span');
  chip.className = chipClass(cp);
  chip.textContent = parseFloat(cp).toFixed(2) + 'x';
  bar.insertBefore(chip, bar.firstChild);
  while (bar.children.length > 20) bar.removeChild(bar.lastChild);
}

function chipClass(cp) {
  cp = parseFloat(cp);
  const base = 'h-chip ';
  return base + (cp >= 10 ? 'h-moon' : cp >= 3 ? 'h-high' : cp >= 2 ? 'h-mid' : 'h-low');
}

function chipHTML(cp) {
  return `<span class="${chipClass(cp)}">${parseFloat(cp).toFixed(2)}x</span>`;
}

// ── APP (modals, utils) ──────────────────────────────────────
const App = {
  openModal(id)        { document.getElementById(id)?.classList.add('open'); },
  closeModal(id)       { document.getElementById(id)?.classList.remove('open'); },
  swapModal(from, to)  { this.closeModal(from); this.openModal(to); },
};

// Close modal on backdrop click
document.querySelectorAll('.modal-backdrop').forEach(m => {
  m.addEventListener('click', e => { if (e.target === m) App.closeModal(m.id); });
});

// Logout
document.getElementById('btn-logout').addEventListener('click', e => {
  e.preventDefault(); Auth.logout();
});

// Admin panel
async function loadAdminPanel() {
  const data = await get('/api/admin/stats');
  if (!data.ok) return;

  const el = document.getElementById('admin-content');
  el.innerHTML = `
    <div class="admin-stat-grid">
      <div class="admin-stat"><div class="val">${data.users}</div><div class="lbl">Users</div></div>
      <div class="admin-stat"><div class="val">${parseFloat(data.deposits).toFixed(0)}</div><div class="lbl">Deposits</div></div>
      <div class="admin-stat"><div class="val">${data.rounds}</div><div class="lbl">Rounds</div></div>
    </div>
    <div class="admin-crash-ctrl">
      <div style="flex:1"><strong style="color:#f44">⚠ Override Next Crash Point</strong><br>
        <small style="color:#888">Applies to next round only, then resets.</small></div>
      <input type="number" id="admin-cp" value="2.00" min="1" max="100" step="0.01" style="width:90px;background:#111;border:1px solid #444;color:#fff;padding:6px;border-radius:5px">
      <button class="btn btn-red" onclick="adminSetCrash()">Set Crash</button>
    </div>
    <div class="admin-section">
      <h3>Pending Withdrawals (${data.pendingWithdrawals.length})</h3>
      ${data.pendingWithdrawals.length === 0 ? '<p style="color:#555">None pending.</p>' : `
      <table class="admin-table">
        <thead><tr><th>User</th><th>Amount</th><th>Bank</th><th>Account</th><th>Actions</th></tr></thead>
        <tbody>${data.pendingWithdrawals.map(t => `
          <tr>
            <td>${t.username}</td>
            <td>${t.amount} ${t.currency_code}</td>
            <td>${t.bank_name||'-'}</td>
            <td>${t.account_number||'-'} / ${t.account_name||'-'}</td>
            <td>
              <button class="btn btn-green btn-sm" onclick="adminWithdrawal(${t.id},'completed')">✓</button>
              <button class="btn btn-red btn-sm"   onclick="adminWithdrawal(${t.id},'failed')">✗</button>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>`}
    </div>`;
}

async function adminSetCrash() {
  const pt = parseFloat(document.getElementById('admin-cp').value);
  const r  = await post('/api/admin/set-crash', { point: pt });
  toast(r.ok ? r.msg : (r.msg||'Error'), r.ok ? 'ok' : 'err');
}

async function adminWithdrawal(id, status) {
  // Simple inline endpoint — add to auth.js if needed
  toast('Processed #'+id, 'ok');
}

document.getElementById('btn-admin').addEventListener('click', () => {
  App.openModal('modal-admin');
  loadAdminPanel();
});

// ── HTTP HELPERS ─────────────────────────────────────────────
async function get(url) {
  try {
    const r = await fetch(url);
    return await r.json();
  } catch(e) { return { ok: false, msg: e.message }; }
}

async function post(url, data) {
  try {
    const r = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(data),
    });
    return await r.json();
  } catch(e) { return { ok: false, msg: e.message }; }
}

// ── TOAST ─────────────────────────────────────────────────
function toast(msg, type = 'ok') {
  const c  = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className   = `toast ${type}`;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

function setAlert(id, msg, type) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = `form-alert ${type}`;
  el.textContent = msg;
  el.classList.remove('hidden');
}

// ── EXPOSE GLOBALS IMMEDIATELY so onclick handlers work ────────
// Must be at top level — NOT inside async function
window.App      = App;
window.Auth     = Auth;
window.BetPanel = BetPanel;
window.Wallet   = Wallet;
window.Sidebar  = Sidebar;

// ── BOOT ─────────────────────────────────────────────────────
(async () => {
  // Check if already logged in
  const me = await get('/api/me');
  if (me.ok) {
    currentUser = me.user;
    onUserLogin();

    // Get paystack key from server
    const config = await get('/api/config');
    if (config?.paystackKey) PAYSTACK_PUBLIC_KEY = config.paystackKey;
  }

  connectSocket();
})();