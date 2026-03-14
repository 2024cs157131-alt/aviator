/**
 * app.js — Crown Pesa Aviator
 *
 * This file loads with defer. By the time it runs:
 * - DOM is fully ready
 * - Stub globals (App, Auth, BetPanel etc.) already exist from <head>
 * - socket.io is loaded
 *
 * We REPLACE the stubs with real implementations here.
 */

(function() {

  // ── STATE ───────────────────────────────────────────────────
  var socket         = null;
  var currentUser    = null;
  var gameStatus     = 'idle';
  var currentRoundId = null;
  var betState       = { 1: null, 2: null };
  var PAYSTACK_KEY   = '';
  var liveBets       = {};

  // ── TINY UTILS ──────────────────────────────────────────────
  function g(id) { return document.getElementById(id); }

  function httpPost(url, data, cb) {
    fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(data)
    })
    .then(function(r){ return r.json(); })
    .then(cb)
    .catch(function(e){ cb({ ok: false, msg: 'Network error: ' + e.message }); });
  }

  function httpGet(url, cb) {
    fetch(url)
    .then(function(r){ return r.json(); })
    .then(cb)
    .catch(function(e){ cb({ ok: false, msg: 'Network error: ' + e.message }); });
  }

  function toast(msg, type) {
    var c = g('toasts'); if (!c) return;
    var d = document.createElement('div');
    d.className   = 'toast ' + (type || 'ok');
    d.textContent = msg;
    c.appendChild(d);
    setTimeout(function(){ if(d.parentNode) d.parentNode.removeChild(d); }, 4500);
  }

  function showAlert(id, msg) {
    var e = g(id); if (!e) return;
    e.textContent    = msg;
    e.className      = 'form-alert error';
    e.style.display  = 'block';
  }

  function hideAlert(id) {
    var e = g(id); if (!e) return;
    e.style.display = 'none';
  }

  function setText(id, txt) {
    var e = g(id); if (e) e.textContent = txt;
  }

  // ── MODE BAR ────────────────────────────────────────────────
  function setModeBar(mode) {
    var bar = g('mode-bar'), dot = g('mode-dot'), txt = g('mode-text');
    if (mode === 'live') {
      if (bar) bar.className   = 'mode-bar live';
      if (dot) dot.style.color = '#00cc44';
      if (txt) txt.textContent = '● LIVE MODE';
    } else {
      if (bar) bar.className   = 'mode-bar fun';
      if (dot) dot.style.color = '#ff8800';
      if (txt) txt.textContent = '● FUN MODE — Register to play';
    }
  }

  // ── BALANCE UI ──────────────────────────────────────────────
  function updateBalanceUI() {
    if (!currentUser) return;
    var sym = (currentUser.currency && currentUser.currency.sym) || 'KSh';
    var bal = parseFloat(currentUser.balance || 0).toFixed(2);
    setText('nav-sym', sym); setText('nav-bal', bal);
    setText('w-sym',   sym); setText('w-bal',   bal);
  }

  function fetchMe() {
    httpGet('/api/me', function(d) {
      if (d.ok && d.user) { currentUser = d.user; updateBalanceUI(); }
    });
  }

  // ── SHOW/HIDE nav sections ───────────────────────────────────
  function onUserLogin() {
    var ng = g('nav-guest'), nu = g('nav-user');
    if (ng) ng.style.display = 'none';
    if (nu) nu.style.display = 'flex';
    setModeBar('live');
    updateBalanceUI();
    if (currentUser && currentUser.isAdmin) {
      var ab = g('btn-admin'); if (ab) ab.style.display = 'inline-block';
    }
    connectSocket();
  }

  // ── BET BUTTONS ─────────────────────────────────────────────
  function setBetBtn(s, cls, html) {
    var btn = g('bet-btn-' + s); if (!btn) return;
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

  // ── HISTORY BAR ─────────────────────────────────────────────
  function chipClass(cp) {
    cp = parseFloat(cp);
    return 'h-chip ' + (cp >= 10 ? 'h-moon' : cp >= 3 ? 'h-high' : cp >= 2 ? 'h-mid' : 'h-low');
  }

  function renderHistoryBar(rounds) {
    var bar = g('history-bar'); if (!bar || !rounds) return;
    bar.innerHTML = rounds.map(function(r) {
      return '<span class="' + chipClass(r.crash_point) + '">' + parseFloat(r.crash_point).toFixed(2) + 'x</span>';
    }).join('');
  }

  function addHistoryChip(cp) {
    var bar = g('history-bar'); if (!bar) return;
    var s   = document.createElement('span');
    s.className   = chipClass(cp);
    s.textContent = parseFloat(cp).toFixed(2) + 'x';
    bar.insertBefore(s, bar.firstChild);
    while (bar.children.length > 20) bar.removeChild(bar.lastChild);
  }

  // ── LIVE BETS SIDEBAR ───────────────────────────────────────
  function addLiveBetRow(username, amount) {
    var body = g('sidebar-body'); if (!body) return;
    var emp  = body.querySelector('.empty-msg');
    if (emp) body.innerHTML = '';
    var sym = currentUser && currentUser.currency ? currentUser.currency.sym : '';
    var d   = document.createElement('div');
    d.className = 'live-bet-row';
    d.id        = 'lbr-' + username;
    d.innerHTML = '<div class="lbr-user">' + username + '</div>'
      + '<div><div class="lbr-amt">' + sym + parseFloat(amount).toFixed(2)
      + '</div><div class="lbr-co" id="lbr-co-' + username + '"></div></div>';
    body.insertBefore(d, body.firstChild);
    liveBets[username] = d;
  }

  function updateLiveBetRow(username, cashoutAt, lost) {
    var co = g('lbr-co-' + username); if (!co) return;
    co.className   = lost ? 'lbr-lost' : 'lbr-co';
    co.textContent = lost ? '💥 lost' : '✓ ' + parseFloat(cashoutAt).toFixed(2) + 'x';
  }

  // ── SOCKET ──────────────────────────────────────────────────
  function connectSocket() {
    if (typeof io === 'undefined') {
      setTimeout(connectSocket, 500); // wait for socket.io to load
      return;
    }
    if (socket) { socket.removeAllListeners(); socket.disconnect(); socket = null; }

    socket = io({ transports: ['websocket', 'polling'] });

    socket.on('connect',    function() { console.log('✅ WS connected'); });
    socket.on('disconnect', function() { console.warn('WS disconnected'); });

    socket.on('game:state', function(snap) {
      currentRoundId = snap.roundId || null;
      var lbl = g('round-label');
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

    socket.on('round:waiting', function(d) {
      currentRoundId = d.roundId; gameStatus = 'waiting';
      var lbl = g('round-label');
      if (lbl) lbl.textContent = 'ROUND #' + d.roundId;
      [1,2].forEach(function(s){ if (betState[s] !== 'placed') betState[s] = null; });
      if (window.Canvas) Canvas.showWaiting(d.waitUntil);
      updateBetButtons('waiting');
    });

    socket.on('round:start', function(d) {
      gameStatus = 'flying';
      if (window.Canvas) Canvas.showFlying(d.startedAt);
      updateBetButtons('flying');
    });

    socket.on('round:crash', function(d) {
      gameStatus = 'crashed';
      if (window.Canvas) Canvas.showCrash(d.crashPoint);
      updateBetButtons('idle');
      addHistoryChip(d.crashPoint);
      [1,2].forEach(function(s) {
        if (betState[s] === 'placed') {
          betState[s] = null; setBetBtn(s, 'idle', 'BET');
          toast('💥 Crashed at ' + parseFloat(d.crashPoint).toFixed(2) + 'x — Bet ' + s + ' lost', 'err');
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
          var sym = currentUser && currentUser.currency ? currentUser.currency.sym : '';
          toast('🎉 Cashed out ' + parseFloat(d.cashout_at).toFixed(2) + 'x — Won ' + sym + parseFloat(d.win).toFixed(2), 'win');
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

  // ── REAL IMPLEMENTATIONS — replace head stubs ────────────────

  window.App = {
    openModal:  function(id){ var m=g(id); if(m) m.classList.add('open'); },
    closeModal: function(id){ var m=g(id); if(m) m.classList.remove('open'); },
    swapModal:  function(a,b){ window.App.closeModal(a); window.App.openModal(b); }
  };

  window.Auth = {
    login: function() {
      var email = g('li-email') ? g('li-email').value.trim() : '';
      var pass  = g('li-pass')  ? g('li-pass').value         : '';
      hideAlert('login-alert');
      if (!email || !pass) { showAlert('login-alert', 'Email and password are required'); return; }
      var btn = g('li-btn');
      if (btn) { btn.disabled = true; btn.textContent = 'Logging in…'; }
      httpPost('/api/login', { email: email, password: pass }, function(d) {
        if (btn) { btn.disabled = false; btn.textContent = 'LOGIN'; }
        if (d.ok) {
          currentUser = d.user;
          window.App.closeModal('modal-login');
          onUserLogin();
          toast('Welcome back, ' + d.user.username + '!', 'ok');
        } else {
          showAlert('login-alert', d.msg || 'Incorrect email or password');
        }
      });
    },

    register: function() {
      var u = g('reg-user')    ? g('reg-user').value.trim()    : '';
      var e = g('reg-email')   ? g('reg-email').value.trim()   : '';
      var p = g('reg-pass')    ? g('reg-pass').value           : '';
      var c = g('reg-country') ? g('reg-country').value        : 'KE';
      hideAlert('reg-alert');
      if (!u || !e || !p)     { showAlert('reg-alert', 'Please fill in all fields'); return; }
      if (u.length < 3)       { showAlert('reg-alert', 'Username must be at least 3 characters'); return; }
      if (p.length < 8)       { showAlert('reg-alert', 'Password must be at least 8 characters'); return; }
      if (e.indexOf('@') < 1) { showAlert('reg-alert', 'Please enter a valid email address'); return; }
      var btn = g('reg-btn');
      if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }
      httpPost('/api/register', { username: u, email: e, password: p, country: c }, function(d) {
        if (btn) { btn.disabled = false; btn.textContent = 'CREATE ACCOUNT'; }
        if (d.ok) {
          currentUser = d.user;
          window.App.closeModal('modal-register');
          onUserLogin();
          toast('Welcome, ' + d.user.username + '! 🎉', 'ok');
        } else {
          showAlert('reg-alert', d.msg || 'Username or email already taken — please try different ones');
        }
      });
    },

    logout: function() {
      httpPost('/api/logout', {}, function(){});
      currentUser = null; betState = {1:null,2:null};
      var ng = g('nav-guest'), nu = g('nav-user');
      if (ng) ng.style.display = 'flex';
      if (nu) nu.style.display = 'none';
      setModeBar('fun');
      setBetBtn(1,'idle','BET'); setBetBtn(2,'idle','BET');
      connectSocket();
    }
  };

  window.BetPanel = {
    adj: function(s, d) {
      var e = g('bet-amt-'+s);
      if (e) e.value = Math.max(1, parseFloat(e.value||0) + d);
    },
    set: function(s, v) { var e = g('bet-amt-'+s); if (e) e.value = v; },
    dbl: function(s)    {
      var e = g('bet-amt-'+s);
      if (e) e.value = parseFloat(e.value||1) * 2;
    },
    togAc: function(s) {
      var c = g('ac-'+s), i = g('ao-'+s);
      if (c && i) i.disabled = !c.checked;
    },
    act: function(s) {
      if (!currentUser) { window.App.openModal('modal-login'); return; }
      if (betState[s] === null) {
        if (gameStatus !== 'waiting') { toast('Wait for the next round to start', 'err'); return; }
        var amtEl = g('bet-amt-'+s);
        var amount = amtEl ? parseFloat(amtEl.value) || 0 : 0;
        if (amount <= 0) { toast('Please enter a bet amount', 'err'); return; }
        var acEl = g('ac-'+s), aoEl = g('ao-'+s);
        var auto = (acEl && acEl.checked && aoEl) ? parseFloat(aoEl.value)||0 : 0;
        betState[s] = 'placed';
        setBetBtn(s, 'placed', '✓ PLACED');
        if (socket) socket.emit('bet:place', { amount: amount, autoCashout: auto });
      } else if (betState[s] === 'placed' && gameStatus === 'flying') {
        setBetBtn(s, 'loading', '...');
        if (socket) socket.emit('bet:cashout', { roundId: currentRoundId });
      }
    }
  };

  window.Wallet = {
    showTab: function(t) {
      var dep = g('w-dep'), wit = g('w-wit');
      if (dep) dep.style.display = t === 'dep' ? 'block' : 'none';
      if (wit) wit.style.display = t === 'wit' ? 'block' : 'none';
      if (t === 'wit') this.loadBanks();
    },
    loadBanks: function() {
      httpGet('/api/banks', function(d) {
        var sel = g('wit-bank'); if (!sel || !d.ok) return;
        sel.innerHTML = (d.banks||[]).map(function(b){ return '<option>'+b+'</option>'; }).join('');
      });
    },
    deposit: function() {
      var amt = g('dep-amt') ? parseFloat(g('dep-amt').value) : 0;
      if (!amt || amt <= 0) { showAlert('dep-alert','Enter a valid amount'); return; }
      var btn = g('dep-btn');
      if (btn) { btn.disabled = true; btn.textContent = 'Initializing…'; }
      httpPost('/api/deposit/init', { amount: amt }, function(d) {
        if (btn) { btn.disabled = false; btn.textContent = 'PAY WITH PAYSTACK'; }
        if (d.ok && d.url && typeof PaystackPop !== 'undefined') {
          PaystackPop.setup({
            key:      PAYSTACK_KEY,
            email:    currentUser ? currentUser.email : '',
            amount:   Math.round(amt * 100),
            currency: currentUser && currentUser.currency ? currentUser.currency.code : 'KES',
            ref:      d.reference,
            callback: function(resp) {
              httpGet('/api/deposit/verify/'+resp.reference, function(v) {
                if (v.ok) { toast('Deposit successful!','ok'); currentUser.balance=v.newBalance; updateBalanceUI(); window.App.closeModal('modal-wallet'); }
                else        toast(v.msg||'Verification failed','err');
              });
            },
            onClose: function(){}
          }).openIframe();
        } else {
          showAlert('dep-alert', d.msg || 'Payment initialization failed');
        }
      });
    },
    withdraw: function() {
      var amt  = g('wit-amt')  ? parseFloat(g('wit-amt').value)        : 0;
      var bank = g('wit-bank') ? g('wit-bank').value                   : '';
      var acct = g('wit-acct') ? g('wit-acct').value.trim()            : '';
      var name = g('wit-name') ? g('wit-name').value.trim()            : '';
      if (!amt||!bank||!acct||!name){ showAlert('wit-alert','All fields required'); return; }
      var btn = g('wit-btn');
      if (btn) { btn.disabled=true; btn.textContent='Submitting…'; }
      httpPost('/api/withdraw',{amount:amt,bank_name:bank,account_number:acct,account_name:name},function(d){
        if (btn) { btn.disabled=false; btn.textContent='SUBMIT WITHDRAWAL'; }
        if (d.ok){ toast(d.msg,'ok'); fetchMe(); window.App.closeModal('modal-wallet'); }
        else       showAlert('wit-alert', d.msg||'Withdrawal failed');
      });
    }
  };

  window.Sidebar = {
    show: function(tab, btn) {
      document.querySelectorAll('.sidebar-tab').forEach(function(b){ b.classList.remove('active'); });
      if (btn) btn.classList.add('active');
      var body = g('sidebar-body'); if (!body) return;
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

  // ── ADMIN ────────────────────────────────────────────────────
  window.loadAdminPanel = function() {
    httpGet('/api/admin/stats', function(d) {
      var panel = g('admin-content'); if (!panel) return;
      if (!d.ok) { panel.innerHTML='<p style="color:#f44;padding:12px">Not authorised</p>'; return; }
      var pw = d.pendingWithdrawals||[];
      panel.innerHTML =
        '<div class="admin-stat-grid">'
        +'<div class="admin-stat"><div class="val">'+(d.totalUsers||0)+'</div><div class="lbl">Users</div></div>'
        +'<div class="admin-stat"><div class="val">'+parseFloat(d.totalDeposits||0).toFixed(0)+'</div><div class="lbl">Deposits</div></div>'
        +'<div class="admin-stat"><div class="val">'+(d.totalRounds||0)+'</div><div class="lbl">Rounds</div></div>'
        +'</div>'
        +'<div class="admin-crash-ctrl">'
        +'<div style="flex:1"><strong style="color:#f44">⚠ Force Next Crash Point</strong><br><small style="color:#888">Resets after one round</small></div>'
        +'<input type="number" id="admin-cp" value="2.00" min="1.01" max="100" step="0.01" style="width:80px;background:#111;border:1px solid #444;color:#fff;padding:6px;border-radius:5px">'
        +'<button class="btn btn-red" onclick="adminSetCrash()">Set</button>'
        +'</div>'
        +'<h3 style="color:var(--red);margin:16px 0 8px">Withdrawals ('+pw.length+')</h3>'
        +(pw.length===0?'<p style="color:#555;font-size:13px">None pending.</p>'
          :'<table class="admin-table"><thead><tr><th>User</th><th>Amount</th><th>Bank</th><th></th></tr></thead><tbody>'
          +pw.map(function(t){
            return '<tr><td>'+t.username+'</td><td>'+t.amount+' '+t.currency_code+'</td>'
              +'<td>'+(t.bank_name||'-')+'</td><td>'
              +'<button class="btn btn-green btn-sm" onclick="adminWithdrawal('+t.id+',\'approve\')">✓</button> '
              +'<button class="btn btn-red btn-sm" onclick="adminWithdrawal('+t.id+',\'reject\')">✗</button>'
              +'</td></tr>';
          }).join('')+'</tbody></table>');
    });
  };

  window.adminSetCrash = function() {
    var v = g('admin-cp') ? parseFloat(g('admin-cp').value) : 2;
    httpPost('/api/admin/set-crash',{point:v},function(r){
      toast(r.ok?'Next crash set to '+v+'x':(r.msg||'Error'), r.ok?'ok':'err');
    });
  };

  window.adminWithdrawal = function(id, action) {
    httpPost('/api/admin/withdrawal/'+action,{txId:id},function(r){
      toast(r.ok?'Done':(r.msg||'Error'), r.ok?'ok':'err');
      window.loadAdminPanel();
    });
  };

  // ── BOOT ─────────────────────────────────────────────────────
  // Get Paystack key
  httpGet('/api/config', function(d) {
    if (d && d.paystackKey) PAYSTACK_KEY = d.paystackKey;
  });

  // Check session
  httpGet('/api/me', function(d) {
    if (d.ok && d.user) {
      currentUser = d.user;
      onUserLogin(); // calls connectSocket()
    } else {
      connectSocket();
    }
  });

})(); // end IIFE
