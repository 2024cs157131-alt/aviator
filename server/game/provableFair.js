/**
 * PROVABLY FAIR ENGINE
 *
 * Algorithm:
 *   1. Server generates server_seed (secret until round ends)
 *   2. SHA256(server_seed) is published BEFORE the round starts
 *   3. Players see the hash — they know it can't be changed
 *   4. crash = HMAC_SHA256(server_seed, client_seed + ":" + nonce)
 *   5. After crash, server_seed is revealed — anyone can verify
 *
 * Players verify: SHA256(revealed_seed) === published_hash
 * Then compute:   HMAC_SHA256(seed, client_seed+nonce) → same crash point
 */

const crypto = require('crypto');

const HOUSE_EDGE = parseFloat(process.env.HOUSE_EDGE) || 0.05;

/**
 * Generate a cryptographically random server seed
 */
function generateServerSeed() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Hash the server seed for pre-commitment
 * Published to players BEFORE the round — proves seed isn't changed
 */
function hashServerSeed(serverSeed) {
  return crypto.createHash('sha256').update(serverSeed).digest('hex');
}

/**
 * Generate client seed from multiple sources
 */
function generateClientSeed() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * THE CRASH POINT ALGORITHM
 * Deterministic from inputs — anyone can reproduce after seed reveal
 *
 * @param {string} serverSeed  - Secret until crash
 * @param {string} clientSeed  - Published before round
 * @param {number} nonce       - Round number (sequential)
 * @returns {number}           - Crash multiplier (≥ 1.00)
 */
function calcCrashPoint(serverSeed, clientSeed, nonce) {
  // Step 1: HMAC-SHA256
  const hmac = crypto
    .createHmac('sha256', serverSeed)
    .update(`${clientSeed}:${nonce}`)
    .digest('hex');

  // Step 2: Take first 8 hex chars → unsigned 32-bit int
  const h    = parseInt(hmac.slice(0, 8), 16);
  const MAX  = 0xFFFFFFFF;

  // Step 3: Apply house edge
  // If random falls within house edge → instant crash (1.00x)
  if (h % Math.floor(1 / HOUSE_EDGE) === 0) {
    return 1.00;
  }

  // Step 4: Calculate crash multiplier
  // Formula: (1 - house_edge) / (1 - h/MAX)
  const crash = Math.floor((1 - HOUSE_EDGE) / (1 - h / MAX) * 100) / 100;
  return Math.max(1.00, crash);
}

/**
 * Verify a round — anyone can call this
 * @param {object} round - { server_seed, server_seed_hash, client_seed, nonce, crash_point }
 * @returns {{ valid: boolean, computed_crash: number, message: string }}
 */
function verifyRound(round) {
  const { server_seed, server_seed_hash, client_seed, nonce, crash_point } = round;

  // Step 1: Verify seed hash
  const computedHash = hashServerSeed(server_seed);
  if (computedHash !== server_seed_hash) {
    return { valid: false, message: 'Server seed hash mismatch — seed was changed!' };
  }

  // Step 2: Compute crash point
  const computedCrash = calcCrashPoint(server_seed, client_seed, nonce);

  // Step 3: Compare
  const matches = Math.abs(computedCrash - parseFloat(crash_point)) < 0.01;
  return {
    valid:          matches,
    computed_crash: computedCrash,
    published_hash: server_seed_hash,
    actual_seed:    server_seed,
    message:        matches ? '✅ Provably fair — verified!' : '❌ Crash point does not match',
  };
}

/**
 * Prepare a new round's provably fair parameters
 */
function prepareRound(nonce) {
  const serverSeed = generateServerSeed();
  const clientSeed = generateClientSeed();
  const hash       = hashServerSeed(serverSeed);
  const crashPoint = calcCrashPoint(serverSeed, clientSeed, nonce);

  return {
    server_seed:      serverSeed,    // SECRET until crash
    server_seed_hash: hash,          // Published immediately
    client_seed:      clientSeed,    // Published immediately
    nonce,
    hmac_result:      crypto.createHmac('sha256', serverSeed).update(`${clientSeed}:${nonce}`).digest('hex'),
    crash_point:      crashPoint,
  };
}

/**
 * Multiplier at elapsed milliseconds
 * Client mirrors this exactly for smooth animation
 * Formula: e^(0.00006 * elapsedMs)
 */
function multAtMs(elapsedMs) {
  return Math.max(1.00, Math.exp(0.00006 * elapsedMs));
}

/**
 * How many ms until a given multiplier is reached
 */
function msAtMult(mult) {
  return Math.log(mult) / 0.00006;
}

module.exports = {
  generateServerSeed,
  hashServerSeed,
  generateClientSeed,
  calcCrashPoint,
  verifyRound,
  prepareRound,
  multAtMs,
  msAtMult,
};
