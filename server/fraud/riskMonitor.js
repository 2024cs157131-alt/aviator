/**
 * RISK MONITORING SYSTEM
 *
 * Monitors:
 * - Whale activity (high-stakes players)
 * - AML patterns (deposit → bet → withdraw rapidly)
 * - Responsible gaming limit enforcement
 * - Unusual win streaks
 */

const db     = require('../db');
const logger = require('../logger');

const WHALE_DAILY   = parseFloat(process.env.WHALE_DAILY_LIMIT)  || 1000000;
const WHALE_SINGLE  = parseFloat(process.env.WHALE_SINGLE_BET)   || 50000;

/**
 * Check responsible gaming limits before allowing bet
 */
async function checkResponsibleGaming(userId, betAmount) {
  const rg = await db.one(
    'SELECT * FROM responsible_gaming WHERE user_id=?',
    [userId]
  );

  const user = await db.one(
    'SELECT is_self_excluded FROM users WHERE id=?',
    [userId]
  );

  if (user?.is_self_excluded) {
    return { allowed: false, reason: 'SELF_EXCLUDED' };
  }

  if (!rg) return { allowed: true };

  // Check self-exclusion
  if (rg.self_exclusion_until && new Date(rg.self_exclusion_until) > new Date()) {
    return {
      allowed: false,
      reason:  'SELF_EXCLUDED',
      until:   rg.self_exclusion_until,
    };
  }

  // Cool-off period
  if (rg.cool_off_until && new Date(rg.cool_off_until) > new Date()) {
    return {
      allowed: false,
      reason:  'COOL_OFF_ACTIVE',
      until:   rg.cool_off_until,
    };
  }

  // Reset daily limits if new day
  const today = new Date().toISOString().split('T')[0];
  if (rg.limits_reset_at.toISOString().split('T')[0] !== today) {
    await db.query(
      "UPDATE responsible_gaming SET today_deposited=0, today_lost=0, limits_reset_at=CURRENT_DATE WHERE user_id=?",
      [userId]
    );
    rg.today_lost = 0;
  }

  // Check daily loss limit
  if (rg.daily_loss_limit && (parseFloat(rg.today_lost) + betAmount) > parseFloat(rg.daily_loss_limit)) {
    return {
      allowed:    false,
      reason:     'DAILY_LOSS_LIMIT_REACHED',
      limit:      rg.daily_loss_limit,
      used:       rg.today_lost,
      remaining:  Math.max(0, rg.daily_loss_limit - rg.today_lost),
    };
  }

  // Check weekly loss limit
  if (rg.weekly_loss_limit) {
    const weekLoss = await db.one(
      `SELECT COALESCE(SUM(ABS(profit)),0) as total 
       FROM bets WHERE user_id=? AND status='lost' AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`,
      [userId]
    );
    if ((parseFloat(weekLoss?.total) || 0) + betAmount > parseFloat(rg.weekly_loss_limit)) {
      return { allowed: false, reason: 'WEEKLY_LOSS_LIMIT_REACHED' };
    }
  }

  return { allowed: true };
}

/**
 * Record a loss against responsible gaming limits
 */
async function recordLoss(userId, amount) {
  await db.query(
    `INSERT INTO responsible_gaming (user_id, today_lost) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE today_lost = today_lost + ?`,
    [userId, amount, amount]
  );
}

/**
 * Detect whale activity and AML patterns
 */
async function monitorWhale(userId, betAmount, transactionType = 'bet') {
  const alerts = [];

  // Single large bet
  if (betAmount >= WHALE_SINGLE) {
    alerts.push({
      type:     'LARGE_SINGLE_BET',
      severity: 'high',
      details:  { betAmount, threshold: WHALE_SINGLE },
    });
  }

  // Daily wagering total
  const dailyTotal = await db.one(
    `SELECT COALESCE(SUM(amount),0) as total
     FROM bets WHERE user_id=? AND created_at >= CURRENT_DATE`,
    [userId]
  );
  if ((parseFloat(dailyTotal?.total) || 0) + betAmount >= WHALE_DAILY) {
    alerts.push({
      type:     'WHALE_DAILY_LIMIT',
      severity: 'critical',
      details:  { daily: dailyTotal.total, threshold: WHALE_DAILY },
    });
  }

  // AML: rapid deposit → bet → withdraw pattern
  const recentDeposit = await db.one(
    `SELECT created_at FROM transactions 
     WHERE user_id=? AND type='deposit' AND status='completed'
     ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  if (recentDeposit) {
    const msSinceDeposit = Date.now() - new Date(recentDeposit.created_at).getTime();
    if (msSinceDeposit < 300000) { // deposited within 5 mins
      // Check pending withdrawal
      const pendingWit = await db.one(
        "SELECT id FROM transactions WHERE user_id=? AND type='withdrawal' AND status='pending'",
        [userId]
      );
      if (pendingWit) {
        alerts.push({
          type:     'AML_RAPID_CYCLE',
          severity: 'critical',
          details:  { msSinceDeposit, hasPendingWithdrawal: true },
        });
      }
    }
  }

  // Store alerts
  for (const alert of alerts) {
    await db.query(
      `INSERT INTO fraud_events (user_id, event_type, severity, bot_score, details, action_taken)
       VALUES (?,?,?,?,?,?)`,
      [
        userId, alert.type, alert.severity,
        0, JSON.stringify(alert.details), 'flagged_for_review'
      ]
    );
    logger.warn(`RiskMonitor ALERT [${alert.severity}] user=${userId} type=${alert.type}`);
  }

  return alerts;
}

/**
 * Get player analytics — used by admin and risk system
 */
async function getPlayerAnalytics(userId) {
  const [bets, transactions] = await Promise.all([
    db.query(
      `SELECT 
        COUNT(*) as total_bets,
        AVG(amount) as avg_bet,
        MAX(amount) as max_bet,
        AVG(CASE WHEN cashout_at IS NOT NULL THEN cashout_at END) as avg_cashout_mult,
        SUM(CASE WHEN status='won'  THEN profit  ELSE 0 END) as total_won,
        SUM(CASE WHEN status='lost' THEN ABS(profit) ELSE 0 END) as total_lost,
        COUNT(CASE WHEN status='won'  THEN 1 END) as wins,
        COUNT(CASE WHEN status='lost' THEN 1 END) as losses
       FROM bets WHERE user_id=?`,
      [userId]
    ),
    db.query(
      `SELECT 
        SUM(CASE WHEN type='deposit'    THEN amount ELSE 0 END) as total_deposits,
        SUM(CASE WHEN type='withdrawal' THEN amount ELSE 0 END) as total_withdrawals,
        COUNT(CASE WHEN type='deposit' THEN 1 END) as deposit_count
       FROM transactions WHERE user_id=? AND status='completed'`,
      [userId]
    ),
  ]);

  const b = bets[0] || {};
  const t = transactions[0] || {};

  return {
    total_bets:         b.total_bets || 0,
    avg_bet:            parseFloat(b.avg_bet) || 0,
    max_bet:            parseFloat(b.max_bet) || 0,
    avg_cashout_mult:   parseFloat(b.avg_cashout_mult) || 0,
    total_won:          parseFloat(b.total_won) || 0,
    total_lost:         parseFloat(b.total_lost) || 0,
    net_profit:         (parseFloat(b.total_won) || 0) - (parseFloat(b.total_lost) || 0),
    win_rate:           b.total_bets ? (b.wins / b.total_bets * 100).toFixed(1) : 0,
    total_deposits:     parseFloat(t.total_deposits) || 0,
    total_withdrawals:  parseFloat(t.total_withdrawals) || 0,
    deposit_count:      t.deposit_count || 0,
  };
}

module.exports = { checkResponsibleGaming, recordLoss, monitorWhale, getPlayerAnalytics };
