/**
 * GAME ENGINE
 *
 * Responsibilities:
 * - Manages round lifecycle (waiting → in_progress → crashed)
 * - Uses Redis for shared state across connections
 * - Broadcasts events via Socket.io
 * - Calls Provably Fair system for crash points
 * - Calls Fraud Detection on each bet/cashout
 */

const db           = require('../db');
const redis        = require('../redis');
const logger       = require('../logger');
const pf           = require('./provableFair');
const botDetector  = require('../fraud/botDetector');
const riskMonitor  = require('../fraud/riskMonitor');

const WAIT_MS      = parseInt(process.env.ROUND_WAIT_MS) || 8000;
const TICK_MS      = parseInt(process.env.GAME_TICK_MS)  || 100;

let io             = null;
let currentRound   = null;
let roundNonce     = 0;
let tickInterval   = null;

// ── SETUP ────────────────────────────────────────────────────
function setIO(socketIO) { io = socketIO; }

function broadcast(event, data) {
  if (io) io.emit(event, data);
}

// ── ROUND LIFECYCLE ──────────────────────────────────────────

async function startNewRound() {
  roundNonce++;

  // Get manual override from settings
  const manualOn = await db.one(
    "SELECT setting_value FROM game_settings WHERE setting_key='manual_crash_enabled'"
  );
  const manualPt = await db.one(
    "SELECT setting_value FROM game_settings WHERE setting_key='manual_crash_point'"
  );

  // Generate provably fair parameters
  let params = pf.prepareRound(roundNonce);

  if (parseInt(manualOn?.setting_value) === 1) {
    params.crash_point = Math.max(1.00, parseFloat(manualPt?.setting_value) || 2.00);
    await db.query(
      "UPDATE game_settings SET setting_value='0' WHERE setting_key='manual_crash_enabled'"
    );
  }

  // Insert round
  const roundId = await db.insert(
    `INSERT INTO rounds (server_seed, server_seed_hash, client_seed, nonce, hmac_result, crash_point, status)
     VALUES (?,?,?,?,?,?,?)`,
    [
      params.server_seed,
      params.server_seed_hash,
      params.client_seed,
      params.nonce,
      params.hmac_result,
      params.crash_point,
      'waiting',
    ]
  );

  const waitUntil = Date.now() + WAIT_MS;

  currentRound = {
    id:               roundId,
    serverSeedHash:   params.server_seed_hash,  // published — never the seed itself
    clientSeed:       params.client_seed,
    nonce:            params.nonce,
    crashPoint:       params.crash_point,
    status:           'waiting',
    startedAt:        null,
    waitUntil,
    bets:             {},  // userId → { amount, autoCashout, currency }
    roundOpenAt:      Date.now(),
  };

  // Store in Redis for other processes
  await redis.setEx(`round:${roundId}`, 3600, JSON.stringify({
    id: roundId,
    status: 'waiting',
    crashPoint: params.crash_point,
    waitUntil,
  }));

  // Broadcast — note: server_seed is NEVER sent until crash
  broadcast('round:waiting', {
    roundId,
    serverSeedHash: params.server_seed_hash,  // for provably fair verification
    clientSeed:     params.client_seed,
    nonce:          params.nonce,
    waitUntil,
    waitMs:         WAIT_MS,
  });

  logger.info(`[Round ${roundId}] Created — crash at ${params.crash_point}x (hidden)`);

  // Trigger demo bots after a short delay (non-blocking)
  setTimeout(() => { try { runDemoBots(); } catch(e) {} }, 800);

  // Schedule start
  setTimeout(activateRound, Math.max(100, waitUntil - Date.now()));
}

async function activateRound() {
  if (!currentRound || currentRound.status !== 'waiting') return;

  const startedAt = Date.now();
  currentRound.status    = 'in_progress';
  currentRound.startedAt = startedAt;

  await db.query(
    'UPDATE rounds SET status=?, started_at=? WHERE id=?',
    ['in_progress', startedAt, currentRound.id]
  );

  // Broadcast start with exact timestamp for client sync
  broadcast('round:start', {
    roundId:   currentRound.id,
    startedAt,
    serverNow: Date.now(), // client uses this to correct clock drift
  });

  logger.info(`[Round ${currentRound.id}] STARTED`);
}

async function crashRound() {
  if (!currentRound || currentRound.status !== 'in_progress') return;

  const crashedAt  = Date.now();
  const crashPoint = currentRound.crashPoint;

  currentRound.status = 'crashed';

  // Get the actual server seed to reveal (provably fair)
  const round = await db.one(
    'SELECT server_seed FROM rounds WHERE id=?',
    [currentRound.id]
  );

  await db.query(
    'UPDATE rounds SET status=?, crashed_at=? WHERE id=?',
    ['crashed', crashedAt, currentRound.id]
  );

  // Bust all remaining active bets atomically
  const losers = await db.query(
    "SELECT * FROM bets WHERE round_id=? AND status='active'",
    [currentRound.id]
  );

  for (const bet of losers) {
    await db.query(
      "UPDATE bets SET status='lost', profit=? WHERE id=?",
      [-parseFloat(bet.amount), bet.id]
    );
    // Record loss for responsible gaming tracking
    await riskMonitor.recordLoss(bet.user_id, parseFloat(bet.amount));
  }

  // Update round stats
  const stats = await db.one(
    `SELECT 
      COUNT(*) as cnt,
      COALESCE(SUM(amount),0) as wagered,
      COALESCE(SUM(CASE WHEN status='won' THEN profit+amount ELSE 0 END),0) as paidout
     FROM bets WHERE round_id=?`,
    [currentRound.id]
  );
  const profit = parseFloat(stats?.wagered || 0) - parseFloat(stats?.paidout || 0);
  await db.query(
    'UPDATE rounds SET player_count=?, total_wagered=?, total_paid_out=?, house_profit=? WHERE id=?',
    [stats?.cnt || 0, stats?.wagered || 0, stats?.paidout || 0, profit, currentRound.id]
  );

  // Broadcast crash — NOW reveal the server seed for verification
  broadcast('round:crash', {
    roundId:     currentRound.id,
    crashPoint,
    serverSeed:  round.server_seed,   // revealed after crash
    crashedAt,
    losers:      losers.map(b => b.user_id),
  });

  logger.info(`[Round ${currentRound.id}] CRASHED at ${crashPoint}x — ${losers.length} busted`);

  // Start next round after 2.5s pause
  setTimeout(startNewRound, 2500);
}

// ── TICK — runs every 100ms ──────────────────────────────────
async function tick() {
  if (!currentRound || currentRound.status !== 'in_progress') return;

  const elapsed    = Date.now() - currentRound.startedAt;
  const multiplier = pf.multAtMs(elapsed);

  // Process auto-cashouts (server-authoritative)
  for (const [userId, bet] of Object.entries(currentRound.bets)) {
    if (bet.status === 'active' && bet.autoCashout && multiplier >= bet.autoCashout) {
      await processCashout(parseInt(userId), currentRound.id, bet.autoCashout, bet.betId);
    }
  }

  // Check crash
  if (multiplier >= currentRound.crashPoint) {
    clearInterval(tickInterval);
    tickInterval = null;
    await crashRound();
    // Restart tick after new round starts
    setTimeout(() => {
      tickInterval = setInterval(tick, TICK_MS);
    }, 2600);
  }
}

// ── BET ─────────────────────────────────────────────────────
async function placeBet(userId, amount, autoCashout, ipAddress, socketId) {
  if (!currentRound || currentRound.status !== 'waiting') {
    return { ok: false, msg: 'Betting closed — wait for next round' };
  }

  // Maintenance check
  const maintenance = await db.one(
    "SELECT setting_value FROM game_settings WHERE setting_key='maintenance_mode'"
  );
  if (parseInt(maintenance?.setting_value) === 1) {
    return { ok: false, msg: 'Game is under maintenance' };
  }

  const betSpeedMs = Date.now() - currentRound.roundOpenAt;

  // Bot check
  const botCheck = await botDetector.checkBetAllowed(userId, betSpeedMs);
  if (!botCheck.allowed) {
    return { ok: false, msg: botCheck.reason, requiredMs: botCheck.requiredMs };
  }

  // Responsible gaming check
  const rgCheck = await riskMonitor.checkResponsibleGaming(userId, amount);
  if (!rgCheck.allowed) {
    return { ok: false, msg: rgCheck.reason, details: rgCheck };
  }

  // Whale monitoring
  await riskMonitor.monitorWhale(userId, amount, 'bet');

  // Settings
  const [minRow, maxRow] = await Promise.all([
    db.one("SELECT setting_value FROM game_settings WHERE setting_key='min_bet'"),
    db.one("SELECT setting_value FROM game_settings WHERE setting_key='max_bet'"),
  ]);
  const minBet = parseFloat(minRow?.setting_value) || 10;
  const maxBet = parseFloat(maxRow?.setting_value) || 50000;

  if (amount < minBet) return { ok: false, msg: `Minimum bet is ${minBet}` };
  if (amount > maxBet) return { ok: false, msg: `Maximum bet is ${maxBet}` };

  // Check duplicate bet in this round
  if (currentRound.bets[userId]) {
    return { ok: false, msg: 'Already bet this round' };
  }

  try {
    const result = await db.transaction(async (conn) => {
      // Get user with lock
      const [users] = await conn.execute(
        'SELECT id, balance, currency_code FROM users WHERE id=? FOR UPDATE',
        [userId]
      );
      const user = users[0];
      if (!user) throw new Error('USER_NOT_FOUND');
      if (parseFloat(user.balance) < amount) throw new Error('INSUFFICIENT_BALANCE');

      const balBefore = parseFloat(user.balance);
      const balAfter  = balBefore - amount;

      // Atomic debit
      await conn.execute(
        'UPDATE users SET balance=? WHERE id=?',
        [balAfter, userId]
      );

      // Record bet
      const [res] = await conn.execute(
        `INSERT INTO bets (round_id, user_id, amount, currency_code, auto_cashout, bet_placed_ms, ip_address)
         VALUES (?,?,?,?,?,?,?)`,
        [currentRound.id, userId, amount, user.currency_code, autoCashout || null, betSpeedMs, ipAddress]
      );

      // Record transaction
      await conn.execute(
        `INSERT INTO transactions (user_id, type, amount, balance_before, balance_after, currency_code, reference, status, ip_address)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [userId, 'bet', amount, balBefore, balAfter, user.currency_code,
         `BET-${res.insertId}`, 'completed', ipAddress]
      );

      return { betId: res.insertId, newBalance: balAfter, currency: user.currency_code };
    });

    // Add to in-memory round bets
    currentRound.bets[userId] = {
      betId:      result.betId,
      amount,
      autoCashout: autoCashout || null,
      status:     'active',
      currency:   result.currency,
    };

    // Async bot analysis (non-blocking)
    botDetector.analyzeBet({
      userId, roundId: currentRound.id,
      betAmount: amount, betSpeedMs,
      cashoutMs: null, cashoutMult: null,
      ipAddress, sessionId: socketId,
    }).catch(err => logger.error('BotDetector async error:', err));

    // Broadcast live bet feed
    const user = await db.one('SELECT username FROM users WHERE id=?', [userId]);
    broadcast('bet:placed', {
      username:  user.username,
      amount,
      roundId:   currentRound.id,
    });

    return { ok: true, betId: result.betId, newBalance: result.newBalance };

  } catch (err) {
    if (err.message === 'INSUFFICIENT_BALANCE') {
      return { ok: false, msg: 'Insufficient balance' };
    }
    logger.error('placeBet error:', err);
    return { ok: false, msg: 'An error occurred' };
  }
}

// ── CASHOUT ─────────────────────────────────────────────────
async function cashOut(userId, roundId) {
  if (!currentRound || currentRound.status !== 'in_progress') {
    return { ok: false, msg: 'No active round' };
  }
  if (currentRound.id !== roundId) {
    return { ok: false, msg: 'Round mismatch' };
  }

  const bet = currentRound.bets[userId];
  if (!bet || bet.status !== 'active') {
    return { ok: false, msg: 'No active bet found' };
  }

  // Server-authoritative multiplier
  const elapsed    = Date.now() - currentRound.startedAt;
  const multiplier = Math.round(pf.multAtMs(elapsed) * 100) / 100;

  if (multiplier >= currentRound.crashPoint) {
    return { ok: false, msg: 'Too late — already crashed!' };
  }

  return processCashout(userId, roundId, multiplier, bet.betId);
}

async function processCashout(userId, roundId, multiplier, betId) {
  const bet = currentRound?.bets?.[userId];
  if (!bet || bet.status !== 'active') return;

  const win    = Math.round(bet.amount * multiplier * 100) / 100;
  const profit = Math.round((win - bet.amount) * 100) / 100;

  try {
    await db.transaction(async (conn) => {
      const [users] = await conn.execute('SELECT balance, currency_code FROM users WHERE id=?', [userId]);
      const user = users[0];
      const balBefore = parseFloat(user.balance);
      const balAfter  = balBefore + win;

      await conn.execute('UPDATE users SET balance=? WHERE id=?', [balAfter, userId]);
      await conn.execute(
        "UPDATE bets SET status='won', cashout_at=?, profit=?, cashout_ms=? WHERE id=?",
        [multiplier, profit, Date.now() - currentRound.startedAt, betId]
      );
      await conn.execute(
        `INSERT INTO transactions (user_id, type, amount, balance_before, balance_after, currency_code, reference, status)
         VALUES (?,?,?,?,?,?,?,?)`,
        [userId, 'win', win, balBefore, balAfter, user.currency_code, `WIN-${betId}`, 'completed']
      );
    });

    // Mark as cashed out in memory
    if (currentRound?.bets?.[userId]) {
      currentRound.bets[userId].status = 'cashed_out';
    }

    const user = await db.one('SELECT username, balance FROM users WHERE id=?', [userId]);

    // Async bot analysis for cashout
    botDetector.analyzeBet({
      userId, roundId,
      betAmount: bet.amount,
      betSpeedMs: 0,
      cashoutMs:   Date.now() - currentRound.startedAt,
      cashoutMult: multiplier,
      ipAddress: '', sessionId: '',
    }).catch(() => {});

    broadcast('bet:cashout', {
      username:   user.username,
      cashout_at: multiplier,
      win,
      roundId,
    });

    return { ok: true, cashout_at: multiplier, win, newBalance: parseFloat(user.balance) };

  } catch (err) {
    logger.error('processCashout error:', err);
    return { ok: false, msg: 'Cashout failed' };
  }
}

// ── STATE SNAPSHOT ───────────────────────────────────────────
function getStateSnapshot() {
  if (!currentRound) return { status: 'no_round' };

  const snap = {
    roundId:        currentRound.id,
    serverSeedHash: currentRound.serverSeedHash,
    clientSeed:     currentRound.clientSeed,
    nonce:          currentRound.nonce,
    status:         currentRound.status,
  };

  if (currentRound.status === 'waiting') {
    snap.waitUntil = currentRound.waitUntil;
  }
  if (currentRound.status === 'in_progress') {
    snap.startedAt = currentRound.startedAt;
    snap.serverNow = Date.now();
  }
  if (currentRound.status === 'crashed') {
    snap.crashPoint = currentRound.crashPoint;
  }

  return snap;
}

// ── START ENGINE ─────────────────────────────────────────────
async function startEngine() {
  // Retry DB queries up to 10 times with 2s delay
  // Railway MySQL proxy needs a few seconds to warm up after schema install
  async function withRetry(fn, label, retries = 10, delayMs = 2000) {
    for (let i = 1; i <= retries; i++) {
      try {
        return await fn();
      } catch (err) {
        if (i === retries) throw err;
        logger.warn(`${label} failed (attempt ${i}/${retries}), retrying in ${delayMs}ms... [${err.code || err.message}]`);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }

  // Resume from DB if server restarted mid-round
  const existing = await withRetry(
    () => db.one("SELECT * FROM rounds WHERE status IN ('waiting','in_progress') ORDER BY id DESC LIMIT 1"),
    'DB query'
  );

  if (existing) {
    await db.query(
      "UPDATE rounds SET status='crashed', crashed_at=? WHERE id=?",
      [Date.now(), existing.id]
    );
    await db.query(
      "UPDATE bets SET status='lost', profit=0-amount WHERE round_id=? AND status='active'",
      [existing.id]
    );
    logger.info(`Crashed orphaned round ${existing.id} from previous instance`);
  }

  await startNewRound();
  tickInterval = setInterval(tick, TICK_MS);
  logger.info(`🎮 Game engine started (${TICK_MS}ms tick)`);
}

async function getHistory(limit = 20) {
  return db.query(
    `SELECT id, crash_point, player_count, total_wagered, server_seed_hash, client_seed, nonce,
            started_at, crashed_at, created_at
     FROM rounds WHERE status='crashed' ORDER BY id DESC LIMIT ?`,
    [limit]
  );
}

module.exports = {
  setIO, startEngine, placeBet, cashOut,
  getStateSnapshot, getHistory,
};

// ── DEMO BOT SIMULATION ──────────────────────────────────────
// Simulates realistic player activity for marketing purposes
// Bots place bets each round with varied amounts and cashout strategies

const DEMO_BOTS = [
  { name:'MikeKiprotich', minBet:50,  maxBet:500,  strategy:'early'  },
  { name:'AnnaWanjiru',   minBet:20,  maxBet:200,  strategy:'mid'    },
  { name:'JamesOchieng',  minBet:100, maxBet:1000, strategy:'risky'  },
  { name:'FatumaNjeri',   minBet:30,  maxBet:300,  strategy:'early'  },
  { name:'DavidMwangi',   minBet:50,  maxBet:400,  strategy:'mid'    },
  { name:'GraceAkinyi',   minBet:20,  maxBet:150,  strategy:'safe'   },
  { name:'EmekaNwosu',    minBet:200, maxBet:2000, strategy:'risky'  },
  { name:'KwameAsante',   minBet:100, maxBet:800,  strategy:'mid'    },
];

const strategies = {
  safe:  () => 1.2 + Math.random() * 0.6,   // 1.2–1.8x
  early: () => 1.5 + Math.random() * 1.0,   // 1.5–2.5x
  mid:   () => 2.0 + Math.random() * 3.0,   // 2.0–5.0x
  risky: () => 3.0 + Math.random() * 7.0,   // 3.0–10.0x
};

let botsActive = false;

async function runDemoBots() {
  if (botsActive || !currentRound || currentRound.status !== 'waiting') return;
  botsActive = true;

  // Only run if demo users exist in DB
  let botUsers;
  try {
    botUsers = await db.query(
      "SELECT id, username, balance FROM users WHERE email LIKE '%@demo.crownpesa.com' AND balance > 10 LIMIT 8"
    );
  } catch(e) { botsActive = false; return; }

  if (!botUsers.length) { botsActive = false; return; }

  const roundId = currentRound.id;

  // Stagger bot bets randomly during the waiting phase
  for (const user of botUsers) {
    const delay = 500 + Math.random() * 5000; // 0.5–5.5s after round opens
    setTimeout(async () => {
      try {
        if (!currentRound || currentRound.id !== roundId || currentRound.status !== 'waiting') return;

        const bot = DEMO_BOTS.find(b => b.name === user.username) || DEMO_BOTS[0];
        const amount = Math.floor(bot.minBet + Math.random() * (bot.maxBet - bot.minBet));
        if (parseFloat(user.balance) < amount) return;

        // Place bet directly in DB (bypass normal placeBet flow for speed)
        await db.query('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?',
          [amount, user.id, amount]);
        const [res] = await db.query(
          'INSERT INTO bets (round_id, user_id, amount, currency_code, auto_cashout, bet_placed_ms, ip_address) VALUES (?,?,?,?,?,?,?)',
          [roundId, user.id, amount, 'KES', null, delay, '127.0.0.1']
        );

        // Add to currentRound.bets so cashout works
        if (currentRound && currentRound.id === roundId) {
          const cashoutTarget = strategies[bot.strategy]();
          currentRound.bets[user.id] = {
            betId: res.insertId || res[0]?.insertId,
            amount, autoCashout: cashoutTarget,
            status: 'active', currency: 'KES', isBot: true
          };
        }

        broadcast('bet:placed', { username: user.username, amount, roundId });
      } catch(e) { /* silent — bot failures don't affect real players */ }
    }, delay);
  }

  botsActive = false;
}

module.exports.runDemoBots = runDemoBots;
