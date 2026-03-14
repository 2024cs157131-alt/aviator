/**
 * app.js — Crown Pesa Aviator
 * All globals assigned immediately. No async code runs until DOM ready.
 */

// ── STATE ─────────────────────────────────────────────────────
var socket         = null;
var currentUser    = null;
var gameStatus     = 'idle';
var currentRoundId = null;
var betState       = { 1: null, 2: null };
var PAYSTACK_KEY   = '';

// ── HELPERS ───────────────────────────────────────────────────
function httpGet(url, cb) {
  fetch(url)
    .then(function(r){ return r.json(); })
    .then(cb)
    .catch(function(){ cb({ ok: false, msg: 'Network error' }); });
}

function httpPost(url, data, cb) {
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  })
    .then(function(r){ return r.json(); })
    .then(cb)
    .catch(function(){ cb({ ok: false, msg: 'Network error' }); });
}

function toast(msg, type) {
  var c = document.getElementById('toasts');
  if (!c) return;
  var el = document.createElement('div');
  el.className   = 'toast ' + (type || 'ok');
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(function(){ el.remove(); }, 4500);
}

function showAlert(id, msg, type) {
  var el = document.getElementById(id);
  if (!el) return;
  el.className     = 'form-alert ' + (type || 'error');
  el.textContent   = msg;
  el.style.display = 'block';
}

function hideAlert(id) {
  var el = document.getElementById(id);
  if (el) el.style.display = 'none';
}

function el(id) { return document.getElementById(id); }

// ── MODAL ────────────────────────────────────────────────────
var App = {
  openModal: function(id) {
    var m = el(id);
    if (m) m.classList.add('open');
  },
  closeModal: function(id) {
    var m = el(id);
    if (m) m.classList.remove('open');
  },
  swapModal: function(a, b) {
    this.closeModal(a);
    this.openModal(b);
  }
};

// ── BET PANEL ────────────────────────────────────────────────
var BetPanel = {
  adj: function(s, d) {
    var inp = el('bet-amt-' + s);
    if (inp) inp.value = Math.max(1, parseFloat(inp.value || 0) + d);
  },
  set: function(s, v) {
    var inp = el('bet-amt-' + s);
    if (inp) inp.value = v;
  },
  dbl: function(s) {
    var inp = el('bet-amt-' + s);
    if (inp) inp.value = parseFloat(inp.value || 1) * 2;
  },
  togAc: function(s) {
    var chk = el('ac-' + s);
    var inp = el('ao-' + s);
    if (chk && inp) inp.disabled = !chk.checked;
  },
  act: function(s) {
    if (!currentUser) { App.openModal('modal-login'); return; }

    if (betState[s] === null) {
      if (gameStatus !== 'waiting') { toast('Wait for the next round!', 'err'); return; }
      var amtEl = el('bet-amt-' + s);
      var amount = parseFloat(amtEl ? amtEl.value : 0) || 0;
      if (amount <= 0) { toast('Enter a valid bet amount', 'err'); return; }
      var acChk = el('ac-' + s);
      var aoEl  = el('ao-' + s);
      var autoCashout = (acChk && acChk.checked && aoEl) ? parseFloat(aoEl.value) || 0 : 0;

      betState[s] = 'placed';
      setBetBtn(s, 'placed', '✓ PLACED');
      if (socket) socket.emit('bet:place', { amount: amount, autoCashout: autoCashout });

    } else if (betState[s] === 'placed' && gameStatus === 'flying') {
      setBetBtn(s, 'loading', '...');
      if (socket) socket.emit('bet:cashout', { roundId: currentRoundId });
    }
  }
};

function setBetBtn(s, cls, html) {
  var btn = el('bet-btn-' + s);
  if (!btn) return;
  btn.className = 'bet-btn ' + cls;
  btn.innerHTML = html;
}

function updateBetButtons(phase) {
  [1, 2].forEach(function(s) {
    var bs = betState[s];
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

// ── AUTH ─────────────────────────────────────────────────────
var Auth = {
  login: function() {
    var emailEl = el('li-email');
    var passEl  = el('li-pass');
    var email   = emailEl ? emailEl.value.trim() : '';
    var pass    = passEl  ? passEl.value : '';

    hideAlert('login-alert');
    if (!email || !pass) { showAlert('login-alert', 'Email and password required'); return; }

    var btn = el('li-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Logging in…'; }

    httpPost('/api/login', { email: email, password: pass }, function(data) {
      if (btn) { btn.disabled = false; btn.textContent = 'LOGIN'; }
      if (data.ok) {
        currentUser = data.user;
        App.closeModal('modal-login');
        onUserLogin();
      } else {
        showAlert('login-alert', data.msg || 'Login failed');
      }
    });
  },

  register: function() {
    var u = el('reg-user')  ? el('reg-user').value.trim()  : '';
    var e = el('reg-email') ? el('reg-email').value.trim() : '';
    var p = el('reg-pass')  ? el('reg-pass').value         : '';
    var c = el('reg-country') ? el('reg-country').value    : 'KE';

    hideAlert('reg-alert');

    if (!u || !e || !p) { showAlert('reg-alert', 'All fields are required'); return; }
    if (u.length < 3)   { showAlert('reg-alert', 'Username: at least 3 characters'); return; }
    if (p.length < 8)   { showAlert('reg-alert', 'Password: at least 8 characters'); return; }
    if (e.indexOf('@') < 0) { showAlert('reg-alert', 'Enter a valid email'); return; }

    var btn = el('reg-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }

    httpPost('/api/register', { username: u, email: e, password: p, country: c }, function(data) {
      if (btn) { btn.disabled = false; btn.textContent = 'CREATE ACCOUNT'; }
      if (data.ok) {
        currentUser = data.user;
        App.closeModal('modal-register');
        onUserLogin();
        toast('Welcome, ' + data.user.username + '! 🎉', 'ok');
      } else {
        showAlert('reg-alert', data.msg || 'Registration failed — username or email already taken');
      }
    });
  },

  logout: function() {
    httpPost('/api/logout', {}, function() {});
    currentUser = null;
    betState    = { 1: null, 2: null };
    var nu = el('nav-user');  if (nu) nu.classList.add('hidden');
    var ng = el('nav-guest'); if (ng) ng.classList.remove('hidden');
    setModeBar('fun');
    setBetBtn(1, 'idle', 'BET');
    setBetBtn(2, 'idle', 'BET');
    connectSocket();
  }
};

// ── LOGIN STATE ──────────────────────────────────────────────
function onUserLogin() {
  var ng = el('nav-guest'); if (ng) ng.classList.add('hidden');
  var nu = el('nav-user');  if (nu) nu.classList.remove('hidden');
  setModeBar('live');
  updateBalanceUI();
  if (currentUser && currentUser.isAdmin) {
    var ab = el('btn-admin'); if (ab) ab.classList.remove('hidden');
  }
  connectSocket();
}

function setModeBar(mode) {
  var bar  = el('mode-bar');
  var dot  = el('mode-dot');
  var text = el('mode-text');
  if (mode === 'live') {
    if (bar)  bar.className = 'mode-bar live';
    if (dot)  dot.style.color = '#00cc44';
    if (text) text.textContent = '● LIVE MODE';
  } else {
    if (bar)  bar.className = 'mode-bar fun';
    if (dot)  dot.style.color = '#ff8800';
    if (text) text.textContent = '● FUN MODE — Register to play';
  }
}

function updateBalanceUI() {
  if (!currentUser) return;
  var sym = (currentUser.currency && currentUser.currency.sym) || 'KSh';
  var bal = parseFloat(currentUser.balance || 0).toFixed(2);
  ['nav-sym','w-sym'].forEach(function(id){ var e=el(id); if(e) e.textContent=sym; });
  ['nav-bal','w-bal'].forEach(function(id){ var e=el(id); if(e) e.textContent=bal; });
}

function fetchMe() {
  httpGet('/api/me', function(data) {
    if (data.ok && data.user) { currentUser = data.user; updateBalanceUI(); }
  });
}

// ── WALLET ───────────────────────────────────────────────────
var Wallet = {
  showTab: function(t) {
    var dep = el('w-dep'); var wit = el('w-wit');
    if (dep) dep.style.display = (t === 'dep') ? 'block' : 'none';
    if (wit) wit.style.display = (t === 'wit') ? 'block' : 'none';
    if (t === 'wit') this.loadBanks();
  },
  loadBanks: function() {
    httpGet('/api/banks', function(data) {
      if (!data.ok) return;
      var sel = el('wit-bank');
      if (!sel) return;
      sel.innerHTML = (data.banks || []).map(function(b) {
        return '<option>' + b + '</option>';
      }).join('');
    });
  },
  deposit: function() {
    var amtEl = el('dep-amt');
    var amt   = amtEl ? parseFloat(amtEl.value) : 0;
    if (!amt || amt <= 0) { showAlert('dep-alert', 'Enter a valid amount'); return; }
    var btn = el('dep-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Initializing…'; }
    httpPost('/api/deposit/init', { amount: amt }, function(data) {
      if (btn) { btn.disabled = false; btn.textContent = 'PAY WITH PAYSTACK'; }
      if (data.ok && data.url && typeof PaystackPop !== 'undefined') {
        var handler = PaystackPop.setup({
          key:      PAYSTACK_KEY,
          email:    currentUser ? currentUser.email : '',
          amount:   Math.round(amt * 100),
          currency: (currentUser && currentUser.currency) ? currentUser.currency.code : 'KES',
          ref:      data.reference,
          callback: function(resp) {
            httpGet('/api/deposit/verify/' + resp.reference, function(v) {
              if (v.ok) {
                toast('Deposit successful!', 'ok');
                if (currentUser) currentUser.balance = v.newBalance;
                updateBalanceUI();
                App.closeModal('modal-wallet');
              } else {
                toast(v.msg || 'Verification failed', 'err');
              }
            });
          },
          onClose: function() {}
        });
        handler.openIframe();
      } else {
        showAlert('dep-alert', data.msg || 'Payment failed');
      }
    });
  },
  withdraw: function() {
    var amt  = el('wit-amt')  ? parseFloat(el('wit-amt').value)  : 0;
    var bank = el('wit-bank') ? el('wit-bank').value              : '';
    var acct = el('wit-acct') ? el('wit-acct').value.trim()       : '';
    var name = el('wit-name') ? el('wit-name').value.trim()       : '';
    if (!amt || !bank || !acct || !name) { showAlert('wit-alert', 'All fields required'); return; }
    var btn = el('wit-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Submitting…'; }
    httpPost('/api/withdraw', { amount: amt, bank_name: bank, account_number: acct, account_name: name }, function(data) {
      if (btn) { btn.disabled = false; btn.textContent = 'SUBMIT WITHDRAWAL'; }
      if (data.ok) { toast(data.msg, 'ok'); fetchMe(); App.closeModal('modal-wallet'); }
      else         { showAlert('wit-alert', data.msg || 'Failed'); }
    });
  }
};

// ── SIDEBAR ──────────────────────────────────────────────────
var liveBets = {};

var Sidebar = {
  show: function(tab, btnEl) {
    document.querySelectorAll('.sidebar-tab').forEach(function(t) { t.classList.remove('active'); });
    if (btnEl) btnEl.classList.add('active');
    var body = el('sidebar-body');
    if (!body) return;
    if (tab === 'my') {
      body.innerHTML = currentUser
        ? '<p class="empty-msg">Bet history coming soon.</p>'
        : '<p class="empty-msg">Login to see your bets.</p>';
    } else {
      var keys = Object.keys(liveBets);
      body.innerHTML = keys.length
        ? keys.map(function(k){ return liveBets[k].outerHTML; }).join('')
        : '<p class="empty-msg">Waiting for round...</p>';
    }
  }
};

function addLiveBetRow(username, amount) {
  var body = el('sidebar-body');
  if (!body) return;
  var emp = body.querySelector('.empty-msg');
  if (emp) body.innerHTML = '';
  var sym = (currentUser && currentUser.currency) ? currentUser.currency.sym : '';
  var div = document.createElement('div');
  div.className = 'live-bet-row';
  div.id = 'lbr-' + username;
  div.innerHTML = '<div class="lbr-user">' + username + '</div>'
    + '<div><div class="lbr-amt">' + sym + parseFloat(amount).toFixed(2)
    + '</div><div class="lbr-co" id="lbr-co-' + username + '"></div></div>';
  body.insertBefore(div, body.firstChild);
  liveBets[username] = div;
}

function updateLiveBetRow(username, cashoutAt, lost) {
  var co = el('lbr-co-' + username);
  if (!co) return;
  co.className   = lost ? 'lbr-lost' : 'lbr-co';
  co.textContent = lost ? '💥 lost' : '✓ ' + parseFloat(cashoutAt).toFixed(2) + 'x';
}

// ── HISTORY ───────────────────────────────────────────────────
function renderHistoryBar(rounds) {
  var bar = el('history-bar');
  if (!bar || !rounds) return;
  bar.innerHTML = rounds.map(function(r) { return chipHTML(r.crash_point); }).join('');
}

function addHistoryChip(cp) {
  var bar = el('history-bar');
  if (!bar) return;
  var chip = document.createElement('span');
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
  return '<span class="' + chipClass(cp) + '">' + parseFloat(cp).toFixed(2) + 'x</span>';
}

// ── SOCKET ───────────────────────────────────────────────────
function connectSocket() {
  if (socket) { socket.removeAllListeners(); socket.disconnect(); socket = null; }
  if (typeof io === 'undefined') { console.error('socket.io not loaded'); return; }

  socket = io({ transports: ['websocket', 'polling'] });

  socket.on('connect',    function() { console.log('✅ WS connected'); });
  socket.on('disconnect', function() { console.warn('WS disconnected'); });

  socket.on('game:state', function(snap) {
    currentRoundId = snap.roundId || null;
    var lbl = el('round-label');
    if (lbl) lbl.textContent = snap.roundId ? 'ROUND #' + snap.roundId : 'ROUND #—';

    if (snap.status === 'waiting') {
      gameStatus = 'waiting';
      if (window.Canvas) Canvas.showWaiting(snap.waitUntil);
      updateBetButtons('waiting');
    } else if (snap.status === 'in_progress') {
      gameStatus = 'flying';
      var drift = snap.serverNow ? (Date.now() - snap.serverNow) : 0;
      if (window.Canvas) Canvas.showFlying(snap.startedAt + drift);
      updateBetButtons('flying');
    } else if (snap.status === 'crashed') {
      gameStatus = 'crashed';
      if (window.Canvas) Canvas.showCrash(snap.crashPoint);
      updateBetButtons('idle');
    } else {
      if (window.Canvas) Canvas.showIdle();
    }
  });

  socket.on('round:waiting', function(data) {
    currentRoundId = data.roundId; gameStatus = 'waiting';
    var lbl = el('round-label');
    if (lbl) lbl.textContent = 'ROUND #' + data.roundId;
    [1,2].forEach(function(s){ if (betState[s] !== 'placed') betState[s] = null; });
    if (window.Canvas) Canvas.showWaiting(data.waitUntil);
    updateBetButtons('waiting');
  });

  socket.on('round:start', function(data) {
    gameStatus = 'flying';
    if (window.Canvas) Canvas.showFlying(data.startedAt);
    updateBetButtons('flying');
  });

  socket.on('round:crash', function(data) {
    gameStatus = 'crashed';
    if (window.Canvas) Canvas.showCrash(data.crashPoint);
    updateBetButtons('idle');
    addHistoryChip(data.crashPoint);
    [1,2].forEach(function(s) {
      if (betState[s] === 'placed') {
        betState[s] = null;
        setBetBtn(s, 'idle', 'BET');
        toast('💥 Crashed at ' + parseFloat(data.crashPoint).toFixed(2) + 'x! Bet ' + s + ' lost.', 'err');
      }
    });
    if (currentUser) fetchMe();
  });

  socket.on('bet:placed',  function(d) { addLiveBetRow(d.username, d.amount); });
  socket.on('bet:cashout', function(d) { updateLiveBetRow(d.username, d.cashout_at, false); });

  socket.on('bet:confirm', function(d) {
    if (currentUser) { currentUser.balance = d.newBalance; updateBalanceUI(); }
  });

  socket.on('cashout:confirm', function(d) {
    [1,2].forEach(function(s) {
      if (betState[s] === 'placed') {
        betState[s] = null; setBetBtn(s, 'idle', 'BET');
        var sym = (currentUser && currentUser.currency) ? currentUser.currency.sym : '';
        toast('🎉 Cashed out at ' + parseFloat(d.cashout_at).toFixed(2) + 'x! Won ' + sym + parseFloat(d.win).toFixed(2), 'win');
        if (currentUser) { currentUser.balance = d.newBalance; updateBalanceUI(); }
      }
    });
  });

  socket.on('error', function(d) {
    toast(d.msg || 'Server error', 'err');
    [1,2].forEach(function(s){ if (!betState[s]) setBetBtn(s, 'idle', 'BET'); });
  });

  socket.on('game:history', function(rounds) { renderHistoryBar(rounds); });
}

// ── ADMIN ─────────────────────────────────────────────────────
function loadAdminPanel() {
  httpGet('/api/admin/stats', function(data) {
    var panel = el('admin-content');
    if (!panel) return;
    if (!data.ok) { panel.innerHTML = '<p style="color:#f44;padding:12px">Not authorised</p>'; return; }
    var pw = data.pendingWithdrawals || [];
    panel.innerHTML =
      '<div class="admin-stat-grid">'
      + '<div class="admin-stat"><div class="val">' + (data.totalUsers||0) + '</div><div class="lbl">Users</div></div>'
      + '<div class="admin-stat"><div class="val">' + parseFloat(data.totalDeposits||0).toFixed(0) + '</div><div class="lbl">Deposits</div></div>'
      + '<div class="admin-stat"><div class="val">' + (data.totalRounds||0) + '</div><div class="lbl">Rounds</div></div>'
      + '</div>'
      + '<div class="admin-crash-ctrl">'
      + '<div style="flex:1"><strong style="color:#f44">⚠ Force Next Crash</strong><br><small style="color:#888">One round only then resets</small></div>'
      + '<input type="number" id="admin-cp" value="2.00" min="1.01" max="100" step="0.01" style="width:80px;background:#111;border:1px solid #444;color:#fff;padding:6px;border-radius:5px">'
      + '<button class="btn btn-red" onclick="adminSetCrash()">Set</button>'
      + '</div>'
      + '<div class="admin-section"><h3>Pending Withdrawals (' + pw.length + ')</h3>'
      + (pw.length === 0 ? '<p style="color:#555;font-size:13px">None pending.</p>'
        : '<table class="admin-table"><thead><tr><th>User</th><th>Amount</th><th>Bank</th><th>Actions</th></tr></thead><tbody>'
        + pw.map(function(t) {
            return '<tr><td>' + t.username + '</td><td>' + t.amount + ' ' + t.currency_code + '</td>'
              + '<td>' + (t.bank_name||'-') + '</td>'
              + '<td><button class="btn btn-green btn-sm" onclick="adminWithdrawal(' + t.id + ',\'approve\')">✓</button> '
              + '<button class="btn btn-red btn-sm" onclick="adminWithdrawal(' + t.id + ',\'reject\')">✗</button></td></tr>';
          }).join('') + '</tbody></table>')
      + '</div>';
  });
}

function adminSetCrash() {
  var inp = el('admin-cp');
  var pt  = inp ? parseFloat(inp.value) : 2;
  httpPost('/api/admin/set-crash', { point: pt }, function(r) {
    toast(r.ok ? 'Next crash set to ' + pt + 'x' : (r.msg || 'Error'), r.ok ? 'ok' : 'err');
  });
}

function adminWithdrawal(id, action) {
  httpPost('/api/admin/withdrawal/' + action, { txId: id }, function(r) {
    toast(r.ok ? 'Done' : (r.msg || 'Error'), r.ok ? 'ok' : 'err');
    loadAdminPanel();
  });
}

// ── WIRE UP EVERYTHING when DOM is ready ────────────────────
function domReady() {

  // Modal backdrop close
  document.querySelectorAll('.modal-backdrop').forEach(function(m) {
    m.addEventListener('click', function(e) {
      if (e.target === m) App.closeModal(m.id);
    });
  });

  // Logout
  var logoutBtn = el('btn-logout');
  if (logoutBtn) logoutBtn.addEventListener('click', function(e) {
    e.preventDefault(); Auth.logout();
  });

  // Admin
  var adminBtn = el('btn-admin');
  if (adminBtn) adminBtn.addEventListener('click', function() {
    App.openModal('modal-admin'); loadAdminPanel();
  });

  // Wallet tab hidden by default
  var dep = el('w-dep'); if (dep) dep.style.display = 'none';
  var wit = el('w-wit'); if (wit) wit.style.display = 'none';

  // Boot
  httpGet('/api/config', function(cfg) {
    if (cfg && cfg.paystackKey) PAYSTACK_KEY = cfg.paystackKey;
  });

  httpGet('/api/me', function(me) {
    if (me.ok && me.user) {
      currentUser = me.user;
      onUserLogin();
    } else {
      connectSocket();
    }
  });
}

// ── EXPOSE GLOBALS ────────────────────────────────────────────
window.App      = App;
window.Auth     = Auth;
window.BetPanel = BetPanel;
window.Wallet   = Wallet;
window.Sidebar  = Sidebar;
window.adminSetCrash    = adminSetCrash;
window.adminWithdrawal  = adminWithdrawal;
window.loadAdminPanel   = loadAdminPanel;

// Run domReady
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', domReady);
} else {
  domReady();
}