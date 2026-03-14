/**
 * REST API Routes
 * Auth, Wallet, Admin, Provably Fair verification
 */

const express     = require('express');
const bcrypt      = require('bcryptjs');
const jwt         = require('jsonwebtoken');
const axios       = require('axios');
const rateLimit   = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const crypto      = require('crypto');

const db          = require('../db');
const logger      = require('../logger');
const riskMonitor = require('../fraud/riskMonitor');
const botDetector = require('../fraud/botDetector');
const pf          = require('../game/provableFair');
const engine      = require('../game/engine');

const router = express.Router();

// ── RATE LIMITERS ────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { ok: false, msg: 'Too many attempts. Try again in 15 minutes.' },
});

const apiLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000,
  max:      parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  message:  { ok: false, msg: 'Rate limit exceeded' },
});

// ── CURRENCY / BANK DATA ─────────────────────────────────────
const CURRENCIES = {
  KE: { code:'KES', sym:'KSh', name:'Kenyan Shilling',    minDep:100,  minWit:500   },
  NG: { code:'NGN', sym:'₦',   name:'Nigerian Naira',     minDep:500,  minWit:1000  },
  GH: { code:'GHS', sym:'GH₵', name:'Ghanaian Cedi',      minDep:10,   minWit:50    },
  ZA: { code:'ZAR', sym:'R',   name:'South African Rand', minDep:50,   minWit:200   },
  UG: { code:'UGX', sym:'USh', name:'Ugandan Shilling',   minDep:5000, minWit:10000 },
  TZ: { code:'TZS', sym:'TSh', name:'Tanzanian Shilling', minDep:5000, minWit:10000 },
  US: { code:'USD', sym:'$',   name:'US Dollar',          minDep:5,    minWit:20    },
  GB: { code:'GBP', sym:'£',   name:'British Pound',      minDep:5,    minWit:20    },
};

const BANKS = {
  KE: ['M-Pesa','Equity Bank','KCB Bank','Co-op Bank','Absa Kenya','NCBA Bank'],
  NG: ['Access Bank','GTBank','First Bank','Zenith Bank','UBA','Opay'],
  GH: ['MTN Mobile Money','Vodafone Cash','GCB Bank','Ecobank'],
  ZA: ['Standard Bank','Absa','FNB','Nedbank'],
};

function getCur(cc) { return CURRENCIES[cc] || CURRENCIES.US; }
function getBanks(cc) { return BANKS[cc] || ['Wire Transfer']; }
function genRef() { return 'CP' + crypto.randomBytes(8).toString('hex').toUpperCase(); }

// ── AUTH ─────────────────────────────────────────────────────

router.post('/register', authLimiter, async (req, res) => {
  try {
    const { username, email, password, country = 'KE' } = req.body;

    if (!username || !email || !password)
      return res.json({ ok: false, msg: 'All fields required' });
    if (username.length < 3 || username.length > 30)
      return res.json({ ok: false, msg: 'Username must be 3–30 characters' });
    if (!/^[a-zA-Z0-9_]+$/.test(username))
      return res.json({ ok: false, msg: 'Username: letters, numbers, underscores only' });
    if (password.length < 8)
      return res.json({ ok: false, msg: 'Password must be at least 8 characters' });

    const existing = await db.one(
      'SELECT id FROM users WHERE email=? OR username=?', [email, username]
    );
    if (existing) return res.json({ ok: false, msg: 'Email or username already taken' });

    const cur    = getCur(country);
    const hash   = await bcrypt.hash(password, parseInt(process.env.BCRYPT_ROUNDS) || 12);
    const uuid   = uuidv4();

    const userId = await db.insert(
      'INSERT INTO users (uuid,username,email,password,country_code,currency_code) VALUES (?,?,?,?,?,?)',
      [uuid, username, email, hash, country, cur.code]
    );

    // Create responsible gaming record
    await db.query(
      'INSERT INTO responsible_gaming (user_id) VALUES (?)',
      [userId]
    );

    const token = jwt.sign({ id: userId, username }, process.env.JWT_SECRET, { expiresIn: '7d' });
    req.session.userId   = userId;
    req.session.username = username;

    logger.info(`New user registered: ${username} (${country})`);

    res.json({ ok: true, token, user: { id: userId, username, currency: cur, balance: 0, isAdmin: false } });

  } catch (e) {
    logger.error('Register error:', e);
    res.json({ ok: false, msg: 'Registration failed' });
  }
});

router.post('/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.json({ ok: false, msg: 'Email and password required' });

    const user = await db.one('SELECT * FROM users WHERE email=?', [email]);
    if (!user) return res.json({ ok: false, msg: 'Invalid credentials' });
    if (user.is_suspended) return res.json({ ok: false, msg: 'Account suspended. Contact support.' });
    if (!(await bcrypt.compare(password, user.password)))
      return res.json({ ok: false, msg: 'Invalid credentials' });

    await db.query('UPDATE users SET last_login=NOW() WHERE id=?', [user.id]);
    req.session.userId   = user.id;
    req.session.username = user.username;

    const token = jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET, { expiresIn: '7d' });
    const cur   = getCur(user.country_code);

    res.json({ ok: true, token, user: {
      id:       user.id,
      username: user.username,
      balance:  parseFloat(user.balance),
      currency: cur,
      isAdmin:  !!user.is_admin,
      riskLevel: user.risk_level,
    }});

  } catch (e) {
    logger.error('Login error:', e);
    res.json({ ok: false, msg: 'Login failed' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

router.get('/me', apiLimiter, async (req, res) => {
  if (!req.session.userId) return res.json({ ok: false });
  try {
    const user = await db.one(
      'SELECT id,username,email,country_code,currency_code,balance,is_admin,risk_level,bot_score FROM users WHERE id=?',
      [req.session.userId]
    );
    if (!user) return res.json({ ok: false });
    const cur = getCur(user.country_code);
    res.json({ ok: true, user: {
      id:       user.id,
      username: user.username,
      balance:  parseFloat(user.balance),
      currency: cur,
      isAdmin:  !!user.is_admin,
      riskLevel: user.risk_level,
      botScore:  parseFloat(user.bot_score),
    }});
  } catch (e) {
    res.json({ ok: false });
  }
});

// ── WALLET ─────────────────────────────────────────────────

router.post('/deposit/init', apiLimiter, async (req, res) => {
  if (!req.session.userId) return res.json({ ok: false, msg: 'Login required' });
  try {
    const user   = await db.one('SELECT * FROM users WHERE id=?', [req.session.userId]);
    const cur    = getCur(user.country_code);
    const amount = parseFloat(req.body.amount);

    if (!amount || amount < cur.minDep)
      return res.json({ ok: false, msg: `Minimum deposit is ${cur.sym}${cur.minDep}` });

    const ref = genRef();
    const balBefore = parseFloat(user.balance);

    await db.query(
      `INSERT INTO transactions (user_id,type,amount,balance_before,balance_after,currency_code,reference,status,ip_address)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [user.id, 'deposit', amount, balBefore, balBefore, cur.code, ref, 'pending', req.ip]
    );

    const resp = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      { email: user.email, amount: Math.round(amount * 100), currency: cur.code, reference: ref },
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
    );

    if (resp.data.status) {
      res.json({ ok: true, url: resp.data.data.authorization_url, reference: ref });
    } else {
      res.json({ ok: false, msg: resp.data.message || 'Paystack error' });
    }
  } catch (e) {
    logger.error('Deposit init error:', e.message);
    res.json({ ok: false, msg: 'Payment initialization failed' });
  }
});

router.get('/deposit/verify/:ref', apiLimiter, async (req, res) => {
  if (!req.session.userId) return res.json({ ok: false, msg: 'Login required' });
  try {
    const ref = req.params.ref;
    const tx  = await db.one('SELECT * FROM transactions WHERE reference=? AND user_id=?', [ref, req.session.userId]);
    if (!tx) return res.json({ ok: false, msg: 'Transaction not found' });
    if (tx.status === 'completed') {
      const user = await db.one('SELECT balance FROM users WHERE id=?', [req.session.userId]);
      return res.json({ ok: true, msg: 'Already processed', newBalance: parseFloat(user.balance) });
    }

    const resp = await axios.get(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(ref)}`,
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
    );

    if (resp.data.status && resp.data.data.status === 'success') {
      const newBal = await db.transaction(async (conn) => {
        const [users] = await conn.execute('SELECT balance FROM users WHERE id=? FOR UPDATE', [req.session.userId]);
        const user    = users[0];
        const balBefore = parseFloat(user.balance);
        const balAfter  = balBefore + parseFloat(tx.amount);
        await conn.execute('UPDATE users SET balance=? WHERE id=?', [balAfter, req.session.userId]);
        await conn.execute(
          'UPDATE transactions SET status=?,balance_after=?,paystack_ref=? WHERE reference=?',
          ['completed', balAfter, resp.data.data.id || '', ref]
        );
        return balAfter;
      });

      // Responsible gaming — record deposit
      await db.query(
        `INSERT INTO responsible_gaming (user_id, today_deposited) VALUES (?,?)
         ON DUPLICATE KEY UPDATE today_deposited=today_deposited+?`,
        [req.session.userId, tx.amount, tx.amount]
      );

      res.json({ ok: true, amount: tx.amount, newBalance: newBal });
    } else {
      await db.query("UPDATE transactions SET status='failed' WHERE reference=?", [ref]);
      res.json({ ok: false, msg: 'Payment not completed' });
    }
  } catch (e) {
    logger.error('Deposit verify error:', e.message);
    res.json({ ok: false, msg: 'Verification failed' });
  }
});

router.post('/webhook/paystack', express.raw({ type:'application/json' }), async (req, res) => {
  const sig  = req.headers['x-paystack-signature'];
  const hash = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
    .update(req.body).digest('hex');
  if (sig !== hash) return res.sendStatus(401);

  try {
    const event = JSON.parse(req.body);
    if (event.event === 'charge.success') {
      const ref = event.data.reference;
      const tx  = await db.one("SELECT * FROM transactions WHERE reference=? AND status='pending'", [ref]);
      if (tx) {
        await db.transaction(async (conn) => {
          const [users] = await conn.execute('SELECT balance FROM users WHERE id=? FOR UPDATE', [tx.user_id]);
          const bal     = parseFloat(users[0].balance);
          await conn.execute('UPDATE users SET balance=? WHERE id=?', [bal + parseFloat(tx.amount), tx.user_id]);
          await conn.execute("UPDATE transactions SET status='completed',balance_after=? WHERE reference=?",
            [bal + parseFloat(tx.amount), ref]);
        });
      }
    }
    res.sendStatus(200);
  } catch (e) {
    logger.error('Webhook error:', e);
    res.sendStatus(500);
  }
});

router.post('/withdraw', apiLimiter, async (req, res) => {
  if (!req.session.userId) return res.json({ ok: false, msg: 'Login required' });
  try {
    const user    = await db.one('SELECT * FROM users WHERE id=?', [req.session.userId]);
    const cur     = getCur(user.country_code);
    const { amount, bank_name, account_number, account_name } = req.body;

    if (!amount || !bank_name || !account_number || !account_name)
      return res.json({ ok: false, msg: 'All fields required' });
    if (amount < cur.minWit) return res.json({ ok: false, msg: `Min withdrawal: ${cur.sym}${cur.minWit}` });
    if (parseFloat(user.balance) < amount) return res.json({ ok: false, msg: 'Insufficient balance' });

    await db.transaction(async (conn) => {
      const [users] = await conn.execute('SELECT balance FROM users WHERE id=? FOR UPDATE', [req.session.userId]);
      const bal = parseFloat(users[0].balance);
      await conn.execute('UPDATE users SET balance=? WHERE id=?', [bal - amount, req.session.userId]);
      await conn.execute(
        `INSERT INTO transactions (user_id,type,amount,balance_before,balance_after,currency_code,reference,status,bank_name,account_number,account_name,ip_address)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [user.id,'withdrawal',amount,bal,bal-amount,cur.code,genRef(),'pending',bank_name,account_number,account_name,req.ip]
      );
    });

    res.json({ ok: true, msg: 'Withdrawal submitted. Processing within 24 hours.' });
  } catch (e) {
    logger.error('Withdraw error:', e);
    res.json({ ok: false, msg: 'Withdrawal failed' });
  }
});

router.get('/banks', async (req, res) => {
  if (!req.session.userId) return res.json({ ok: false });
  const user = await db.one('SELECT country_code FROM users WHERE id=?', [req.session.userId]);
  res.json({ ok: true, banks: getBanks(user?.country_code || 'KE') });
});

router.get('/config', (req, res) => {
  res.json({
    ok:            true,
    paystackKey:   process.env.PAYSTACK_PUBLIC_KEY || '',
    siteName:      process.env.SITE_NAME || 'Crown Pesa',
    houseEdge:     parseFloat(process.env.HOUSE_EDGE) || 0.05,
  });
});

// ── PROVABLY FAIR VERIFICATION ──────────────────────────────

router.get('/verify/:roundId', async (req, res) => {
  try {
    const round = await db.one(
      `SELECT id, server_seed, server_seed_hash, client_seed, nonce, crash_point, status
       FROM rounds WHERE id=? AND status='crashed'`,
      [req.params.roundId]
    );
    if (!round) return res.json({ ok: false, msg: 'Round not found or not yet crashed' });

    const result = pf.verifyRound(round);
    res.json({ ok: true, roundId: round.id, ...result });
  } catch (e) {
    res.json({ ok: false, msg: e.message });
  }
});

router.get('/history', async (req, res) => {
  const rows = await engine.getHistory(20);
  res.json({ ok: true, rounds: rows });
});

// ── RESPONSIBLE GAMING ───────────────────────────────────────

router.post('/rg/set-limits', apiLimiter, async (req, res) => {
  if (!req.session.userId) return res.json({ ok: false, msg: 'Login required' });
  const { daily_deposit_limit, daily_loss_limit, weekly_loss_limit, session_limit_minutes } = req.body;
  await db.query(
    `INSERT INTO responsible_gaming (user_id, daily_deposit_limit, daily_loss_limit, weekly_loss_limit, session_limit_minutes)
     VALUES (?,?,?,?,?)
     ON DUPLICATE KEY UPDATE 
       daily_deposit_limit=VALUES(daily_deposit_limit),
       daily_loss_limit=VALUES(daily_loss_limit),
       weekly_loss_limit=VALUES(weekly_loss_limit),
       session_limit_minutes=VALUES(session_limit_minutes)`,
    [req.session.userId, daily_deposit_limit||null, daily_loss_limit||null, weekly_loss_limit||null, session_limit_minutes||null]
  );
  res.json({ ok: true, msg: 'Limits updated' });
});

router.post('/rg/self-exclude', apiLimiter, async (req, res) => {
  if (!req.session.userId) return res.json({ ok: false, msg: 'Login required' });
  const { days = 30 } = req.body;
  const until = new Date(Date.now() + days * 86400000);
  await db.query(
    `UPDATE responsible_gaming SET self_exclusion_until=? WHERE user_id=?`,
    [until, req.session.userId]
  );
  await db.query('UPDATE users SET is_self_excluded=1 WHERE id=?', [req.session.userId]);
  req.session.destroy();
  res.json({ ok: true, msg: `Self-exclusion set for ${days} days.` });
});

// ── ADMIN ────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.json({ ok: false, msg: 'Authentication required' });
  db.one('SELECT is_admin FROM users WHERE id=?', [req.session.userId]).then(u => {
    if (!u?.is_admin) return res.json({ ok: false, msg: 'Admin access required' });
    next();
  }).catch(() => res.json({ ok: false, msg: 'Auth error' }));
}

router.get('/admin/stats', requireAdmin, async (req, res) => {
  try {
    const [users, deposits, bets, rounds, pending, flagged] = await Promise.all([
      db.one('SELECT COUNT(*) c FROM users'),
      db.one("SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE type='deposit' AND status='completed'"),
      db.one("SELECT COALESCE(SUM(amount),0) s FROM bets"),
      db.one("SELECT COUNT(*) c FROM rounds WHERE status='crashed'"),
      db.query("SELECT t.*,u.username,u.country_code FROM transactions t JOIN users u ON t.user_id=u.id WHERE t.type='withdrawal' AND t.status='pending' ORDER BY t.created_at DESC LIMIT 50"),
      db.query("SELECT f.*,u.username FROM fraud_events f JOIN users u ON f.user_id=u.id WHERE f.resolved=0 ORDER BY f.created_at DESC LIMIT 20"),
    ]);

    const snap = engine.getStateSnapshot();

    res.json({
      ok: true,
      totalUsers:    users.c,
      totalDeposits: parseFloat(deposits.s),
      totalBets:     parseFloat(bets.s),
      totalRounds:   rounds.c,
      currentRound:  snap,
      pendingWithdrawals: pending,
      fraudAlerts:   flagged,
    });
  } catch (e) {
    logger.error('Admin stats error:', e);
    res.json({ ok: false, msg: e.message });
  }
});

router.get('/admin/rounds', requireAdmin, async (req, res) => {
  const rounds = await db.query(
    `SELECT id, crash_point, status, player_count, total_wagered, house_profit, created_at, started_at, crashed_at
     FROM rounds ORDER BY id DESC LIMIT 50`
  );
  res.json({ ok: true, rounds });
});

router.get('/admin/users', requireAdmin, async (req, res) => {
  const users = await db.query(
    `SELECT id, username, email, country_code, balance, is_admin, is_suspended, risk_level, bot_score, created_at, last_login
     FROM users ORDER BY id DESC LIMIT 100`
  );
  res.json({ ok: true, users });
});

router.get('/admin/user/:id', requireAdmin, async (req, res) => {
  const [user, analytics, fraud] = await Promise.all([
    db.one('SELECT * FROM users WHERE id=?', [req.params.id]),
    riskMonitor.getPlayerAnalytics(req.params.id),
    db.query('SELECT * FROM fraud_events WHERE user_id=? ORDER BY created_at DESC LIMIT 10', [req.params.id]),
  ]);
  const botScore = await botDetector.computeBotScore(req.params.id);
  res.json({ ok: true, user, analytics, fraud, botScore });
});

router.post('/admin/suspend', requireAdmin, async (req, res) => {
  const { userId, suspend, reason } = req.body;
  await db.query('UPDATE users SET is_suspended=? WHERE id=?', [suspend ? 1 : 0, userId]);
  await db.query(
    'INSERT INTO audit_log (actor_id,target_user_id,action,new_value,ip_address) VALUES (?,?,?,?,?)',
    [req.session.userId, userId, suspend ? 'suspend' : 'unsuspend', JSON.stringify({ reason }), req.ip]
  );
  res.json({ ok: true });
});

router.post('/admin/adjust-balance', requireAdmin, async (req, res) => {
  const { userId, amount, reason } = req.body;
  if (!reason) return res.json({ ok: false, msg: 'Reason required for audit' });
  const user = await db.one('SELECT balance FROM users WHERE id=?', [userId]);
  const newBal = parseFloat(user.balance) + parseFloat(amount);
  if (newBal < 0) return res.json({ ok: false, msg: 'Would result in negative balance' });
  await db.query('UPDATE users SET balance=? WHERE id=?', [newBal, userId]);
  await db.query(
    `INSERT INTO transactions (user_id,type,amount,balance_before,balance_after,currency_code,reference,status,admin_note)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [userId,'adjustment',Math.abs(amount),user.balance,newBal,'KES',genRef(),'completed',reason]
  );
  await db.query(
    'INSERT INTO audit_log (actor_id,target_user_id,action,old_value,new_value,ip_address) VALUES (?,?,?,?,?,?)',
    [req.session.userId, userId, 'balance_adjustment',
     JSON.stringify({ balance: user.balance }), JSON.stringify({ balance: newBal, reason }), req.ip]
  );
  res.json({ ok: true, newBalance: newBal });
});

router.post('/admin/set-crash', requireAdmin, async (req, res) => {
  const point = parseFloat(req.body.point) || 2.00;
  await db.query("UPDATE game_settings SET setting_value=? WHERE setting_key='manual_crash_point'", [point]);
  await db.query("UPDATE game_settings SET setting_value='1' WHERE setting_key='manual_crash_enabled'");
  await db.query('INSERT INTO audit_log (actor_id,action,new_value,ip_address) VALUES (?,?,?,?)',
    [req.session.userId, 'manual_crash_set', JSON.stringify({ point }), req.ip]);
  res.json({ ok: true, msg: `Next crash point set to ${point}x` });
});

router.post('/admin/setting', requireAdmin, async (req, res) => {
  const { key, value } = req.body;
  const ALLOWED = ['min_bet','max_bet','round_wait_ms','maintenance_mode','captcha_enabled'];
  if (!ALLOWED.includes(key)) return res.json({ ok: false, msg: 'Unknown setting key' });
  await db.query(
    'UPDATE game_settings SET setting_value=?,updated_by=? WHERE setting_key=?',
    [value, req.session.userId, key]
  );
  res.json({ ok: true });
});

router.post('/admin/withdrawal/:action', requireAdmin, async (req, res) => {
  const { txId, note } = req.body;
  const action = req.params.action; // 'approve' or 'reject'

  const tx = await db.one('SELECT * FROM transactions WHERE id=?', [txId]);
  if (!tx || tx.type !== 'withdrawal') return res.json({ ok: false, msg: 'Not found' });

  if (action === 'approve') {
    await db.query("UPDATE transactions SET status='completed',admin_note=? WHERE id=?", [note||'', txId]);
  } else {
    // Refund
    await db.transaction(async (conn) => {
      await conn.execute("UPDATE transactions SET status='reversed',admin_note=? WHERE id=?", [note||'', txId]);
      await conn.execute('UPDATE users SET balance=balance+? WHERE id=?', [tx.amount, tx.user_id]);
      await conn.execute(
        `INSERT INTO transactions (user_id,type,amount,balance_before,balance_after,currency_code,reference,status,admin_note)
         SELECT user_id, 'refund', amount, balance-amount, balance, currency_code, ?, 'completed', ?
         FROM users WHERE id=?`,
        [genRef(), `Refund for rejected withdrawal ${txId}`, tx.user_id]
      );
    });
  }

  await db.query(
    'INSERT INTO audit_log (actor_id,target_user_id,action,new_value,ip_address) VALUES (?,?,?,?,?)',
    [req.session.userId, tx.user_id, `withdrawal_${action}`, JSON.stringify({ txId, note }), req.ip]
  );

  res.json({ ok: true });
});

router.get('/admin/fraud', requireAdmin, async (req, res) => {
  const events = await db.query(
    `SELECT f.*, u.username, u.email FROM fraud_events f 
     JOIN users u ON f.user_id=u.id 
     ORDER BY f.created_at DESC LIMIT 100`
  );
  res.json({ ok: true, events });
});

router.post('/admin/resolve-fraud/:id', requireAdmin, async (req, res) => {
  await db.query(
    'UPDATE fraud_events SET resolved=1, resolved_by=? WHERE id=?',
    [req.session.userId, req.params.id]
  );
  res.json({ ok: true });
});

module.exports = router;
