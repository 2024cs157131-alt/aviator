'use strict';
const logger = require('../logger');

// Minimum time between bet and the round opening (ms)
// Protects against scripted bots that fire instantly
const MIN_BET_DELAY_MS = 400;
const FAST_BET_THRESHOLD = 800;   // suspicious if < 800 ms
const FAST_BET_LIMIT     = 5;     // allow 5 fast bets before flagging

const _fastBetCounts = {};        // userId → count

async function checkBetAllowed(userId, betSpeedMs) {
  // Always allow if bet came after 1 second
  if (betSpeedMs >= 1000) {
    _fastBetCounts[userId] = 0;
    return { allowed: true };
  }

  if (betSpeedMs < MIN_BET_DELAY_MS) {
    return {
      allowed:    false,
      reason:     `Please wait ${MIN_BET_DELAY_MS - betSpeedMs}ms before betting`,
      requiredMs: MIN_BET_DELAY_MS,
    };
  }

  if (betSpeedMs < FAST_BET_THRESHOLD) {
    _fastBetCounts[userId] = (_fastBetCounts[userId] || 0) + 1;
    if (_fastBetCounts[userId] > FAST_BET_LIMIT) {
      logger.warn(`[BotDetector] User ${userId} exceeded fast-bet limit (${_fastBetCounts[userId]})`);
      return { allowed: false, reason: 'Betting too fast. Please slow down.', requiredMs: 1000 };
    }
  }

  return { allowed: true };
}

async function analyzeBet(data) {
  // Async analysis — does not block bet placement
  const { userId, cashoutMult } = data;
  if (cashoutMult && cashoutMult > 50) {
    logger.debug(`[BotDetector] High cashout ${cashoutMult}x by user ${userId}`);
  }
}

module.exports = { checkBetAllowed, analyzeBet };
