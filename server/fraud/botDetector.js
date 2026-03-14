/**
 * AI ANTI-BOT DETECTION ENGINE
 *
 * Analyzes player behavior across multiple dimensions:
 * - Bet timing patterns
 * - Cashout precision
 * - Bet size variance
 * - Session entropy
 * - Reaction time distributions
 * - Sequence repetition
 *
 * Outputs a Bot Risk Score 0–100
 */

const db     = require('../db');
const logger = require('../logger');

// ── SCORING WEIGHTS ──────────────────────────────────────────
const WEIGHTS = {
  bet_speed_too_fast:    25,   // bet placed < 200ms after round opens
  cashout_precision:     20,   // cashout always same ms window
  identical_sequences:   20,   // same bet/cashout pattern repeated
  zero_variance_bets:    15,   // exactly same bet amount always
  inhuman_reaction:      10,   // reaction time < 100ms consistently
  session_entropy_low:    5,   // very predictable timing
  multi_account_signals:  5,   // same IP, device fingerprint
};

const THRESHOLDS = {
  suspicious: parseInt(process.env.BOT_SCORE_SUSPICIOUS) || 30,
  likely_bot:  parseInt(process.env.BOT_SCORE_LIKELY)    || 60,
  ban:         parseInt(process.env.BOT_SCORE_BAN)        || 85,
};

/**
 * Analyze a single bet event and update bot score
 * @param {object} params
 * @param {number} params.userId
 * @param {number} params.roundId
 * @param {number} params.betAmount
 * @param {number} params.betSpeedMs    - ms from round open to bet
 * @param {number} params.cashoutMs     - ms from round start to cashout (null if lost)
 * @param {number} params.cashoutMult   - cashout multiplier (null if lost)
 * @param {string} params.ipAddress
 * @param {string} params.sessionId
 */
async function analyzeBet(params) {
  const { userId, roundId, betAmount, betSpeedMs, cashoutMs, cashoutMult, ipAddress, sessionId } = params;

  try {
    // Store sample
    await db.query(
      `INSERT INTO bot_samples 
       (user_id, round_id, bet_speed_ms, cashout_speed_ms, bet_amount, cashout_mult, ip_address, session_id)
       VALUES (?,?,?,?,?,?,?,?)`,
      [userId, roundId, betSpeedMs, cashoutMs, betAmount, cashoutMult, ipAddress, sessionId]
    );

    // Compute new bot score
    const score  = await computeBotScore(userId);
    const action = await applyBotAction(userId, score);

    return { score, action };

  } catch (err) {
    logger.error('BotDetector.analyzeBet error:', err);
    return { score: 0, action: 'none' };
  }
}

/**
 * Compute bot risk score from recent samples
 */
async function computeBotScore(userId) {
  // Get last 50 samples
  const samples = await db.query(
    `SELECT * FROM bot_samples WHERE user_id=? ORDER BY created_at DESC LIMIT 50`,
    [userId]
  );

  if (samples.length < 3) return 0; // Not enough data

  let score = 0;
  const signals = {};

  // ── SIGNAL 1: Bet speed too fast ────────────────────────
  const fastBets = samples.filter(s => s.bet_speed_ms < 200);
  const fastPct  = fastBets.length / samples.length;
  if (fastPct > 0.7) {
    const contribution = Math.min(WEIGHTS.bet_speed_too_fast, WEIGHTS.bet_speed_too_fast * fastPct);
    score += contribution;
    signals.bet_speed = { pct: fastPct, contribution };
  }

  // ── SIGNAL 2: Superhuman speed (< 100ms) ────────────────
  const inhumanBets = samples.filter(s => s.bet_speed_ms < 100);
  if (inhumanBets.length >= 3) {
    score += WEIGHTS.inhuman_reaction;
    signals.inhuman = { count: inhumanBets.length };
  }

  // ── SIGNAL 3: Cashout precision (always same ms window) ─
  const cashouts = samples.filter(s => s.cashout_speed_ms !== null);
  if (cashouts.length >= 5) {
    const times    = cashouts.map(c => c.cashout_speed_ms);
    const mean     = times.reduce((a,b) => a+b, 0) / times.length;
    const variance = times.reduce((sum, t) => sum + Math.pow(t - mean, 2), 0) / times.length;
    const stdDev   = Math.sqrt(variance);

    // Low std deviation = robotic precision
    if (stdDev < 50) {
      const contribution = WEIGHTS.cashout_precision * (1 - stdDev / 50);
      score += contribution;
      signals.cashout_precision = { stdDev, contribution };
    }
  }

  // ── SIGNAL 4: Zero variance bet sizes ───────────────────
  const amounts   = samples.map(s => parseFloat(s.bet_amount));
  const uniqueAmt = new Set(amounts.map(a => a.toFixed(2))).size;
  if (uniqueAmt === 1 && samples.length >= 10) {
    score += WEIGHTS.zero_variance_bets;
    signals.zero_variance = true;
  }

  // ── SIGNAL 5: Identical sequences ───────────────────────
  if (samples.length >= 10) {
    const seq   = samples.slice(0, 5).map(s => `${s.bet_amount}-${s.cashout_mult||'X'}`).join('|');
    const seq2  = samples.slice(5, 10).map(s => `${s.bet_amount}-${s.cashout_mult||'X'}`).join('|');
    if (seq === seq2) {
      score += WEIGHTS.identical_sequences;
      signals.identical_sequence = true;
    }
  }

  // ── SIGNAL 6: Session entropy (bet timing regularity) ───
  const betSpeeds = samples.map(s => s.bet_speed_ms);
  if (betSpeeds.length >= 10) {
    const bMean = betSpeeds.reduce((a,b) => a+b, 0) / betSpeeds.length;
    const bVar  = betSpeeds.reduce((sum, t) => sum + Math.pow(t - bMean, 2), 0) / betSpeeds.length;
    const bStd  = Math.sqrt(bVar);
    if (bStd < 20) {
      score += WEIGHTS.session_entropy_low;
      signals.low_entropy = { stdDev: bStd };
    }
  }

  score = Math.min(100, Math.round(score));

  // Update user bot score
  await db.query(
    'UPDATE users SET bot_score=? WHERE id=?',
    [score, userId]
  );

  logger.debug(`BotDetector: user ${userId} score=${score}`, signals);
  return score;
}

/**
 * Apply action based on bot score
 */
async function applyBotAction(userId, score) {
  let action = 'none';
  let severity = 'low';

  if (score >= THRESHOLDS.ban) {
    action   = 'suspend';
    severity = 'critical';
    await db.query(
      "UPDATE users SET is_suspended=1, risk_level='banned' WHERE id=?",
      [userId]
    );

  } else if (score >= THRESHOLDS.likely_bot) {
    action   = 'captcha_required';
    severity = 'high';
    await db.query(
      "UPDATE users SET risk_level='high' WHERE id=?",
      [userId]
    );

  } else if (score >= THRESHOLDS.suspicious) {
    action   = 'speed_limit';
    severity = 'medium';
    await db.query(
      "UPDATE users SET risk_level='suspicious' WHERE id=?",
      [userId]
    );
  }

  if (action !== 'none') {
    await db.query(
      `INSERT INTO fraud_events (user_id, event_type, severity, bot_score, details, action_taken)
       VALUES (?,?,?,?,?,?)`,
      [
        userId,
        'bot_detection',
        severity,
        score,
        JSON.stringify({ score, action }),
        action,
      ]
    );
    logger.warn(`BotDetector: user ${userId} flagged — score=${score} action=${action}`);
  }

  return action;
}

/**
 * Check if user is allowed to bet (considering bot score)
 */
async function checkBetAllowed(userId, betSpeedMs) {
  const user = await db.one(
    'SELECT bot_score, risk_level, is_suspended FROM users WHERE id=?',
    [userId]
  );

  if (!user) return { allowed: false, reason: 'USER_NOT_FOUND' };
  if (user.is_suspended) return { allowed: false, reason: 'ACCOUNT_SUSPENDED' };

  // Enforce minimum bet speed for suspicious users
  const minSpeed = parseInt(process.env.MAX_BET_SPEED_MS) || 500;
  if (user.risk_level === 'suspicious' && betSpeedMs < minSpeed) {
    return { allowed: false, reason: 'BET_TOO_FAST', requiredMs: minSpeed };
  }

  if (user.risk_level === 'high' && betSpeedMs < minSpeed * 2) {
    return { allowed: false, reason: 'BET_TOO_FAST_HIGH_RISK', requiredMs: minSpeed * 2 };
  }

  return { allowed: true };
}

module.exports = { analyzeBet, computeBotScore, checkBetAllowed, THRESHOLDS };
