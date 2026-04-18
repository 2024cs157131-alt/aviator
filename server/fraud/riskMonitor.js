'use strict';
const logger = require('../logger');

// Daily bet limits per risk level
const LIMITS = {
  low:      { dailyBet: 50000,  singleBet: 10000 },
  medium:   { dailyBet: 100000, singleBet: 25000 },
  high:     { dailyBet: 500000, singleBet: 100000 },
};

async function checkResponsibleGaming(userId, amount) {
  // TODO: integrate with DB for real daily limits
  // For now, cap single bets at 50,000
  if (amount > 50000) {
    return { allowed: false, reason: 'Single bet exceeds maximum allowed (50,000)' };
  }
  return { allowed: true };
}

async function monitorWhale(userId, amount, type) {
  if (amount >= 10000) {
    logger.warn(`[RiskMonitor] Large ${type}: user=${userId} amount=${amount}`);
  }
}

module.exports = { checkResponsibleGaming, monitorWhale };
