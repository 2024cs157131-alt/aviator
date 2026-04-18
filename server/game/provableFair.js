'use strict';
const crypto = require('crypto');

/**
 * Provably-fair crash point generation.
 * Algorithm: HMAC-SHA256(serverSeed, clientSeed + ':' + nonce)
 * Maps to crash point using the same formula as well-known crash games.
 */

function generateSeeds() {
  const serverSeed = crypto.randomBytes(32).toString('hex');
  const clientSeed = crypto.randomBytes(8).toString('hex');
  const nonce      = Math.floor(Math.random() * 1e9);
  const hash       = crypto.createHash('sha256').update(serverSeed).digest('hex');
  return { server_seed: serverSeed, server_seed_hash: hash, client_seed: clientSeed, nonce };
}

function generateCrashPoint(serverSeed, clientSeed, nonce) {
  const hmac = crypto
    .createHmac('sha256', serverSeed)
    .update(`${clientSeed}:${nonce}`)
    .digest('hex');

  // Use first 8 hex chars → 32-bit number
  const r = parseInt(hmac.slice(0, 8), 16);

  // House edge 4 %. Formula: 99 / (1 - r/2^32)
  // Clamp to reasonable range
  const e = 2 ** 32;
  if (r % 33 === 0) return 1.00;          // ~3 % instant crash

  const crash = Math.floor((99 * e) / (e - r)) / 100;
  return Math.max(1.00, Math.min(crash, 100000));
}

function multAtMs(ms) {
  return Math.max(1, Math.exp(0.00006 * ms));
}

function verifyRound(round) {
  const cp = generateCrashPoint(round.server_seed, round.client_seed, round.nonce);
  return {
    verified:    Math.abs(cp - parseFloat(round.crash_point)) < 0.01,
    expected:    cp,
    serverSeed:  round.server_seed,
    clientSeed:  round.client_seed,
    nonce:       round.nonce,
  };
}

module.exports = { generateSeeds, generateCrashPoint, multAtMs, verifyRound };
