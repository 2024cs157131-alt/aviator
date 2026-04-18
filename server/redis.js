const logger = require('./logger');
require('dotenv').config();

// ── IN-MEMORY FALLBACK (used when Redis is not configured) ──
const memStore = new Map();
const fallback = {
  get:     async (k)       => memStore.get(k) ?? null,
  set:     async (k, v)    => { memStore.set(k, v); return 'OK'; },
  setEx:   async (k, t, v) => { memStore.set(k, v); return 'OK'; },
  del:     async (k)       => { memStore.delete(k); return 1; },
  incr:    async (k)       => { const v = (parseInt(memStore.get(k)) || 0) + 1; memStore.set(k, String(v)); return v; },
  expire:  async ()        => 1,
  hSet:    async (k, f, v) => { if (!memStore.has(k)) memStore.set(k, {}); memStore.get(k)[f] = v; return 1; },
  hGet:    async (k, f)    => memStore.get(k)?.[f] ?? null,
  hGetAll: async (k)       => memStore.get(k) || {},
};

let store = fallback;

async function init() {
  const host = process.env.REDIS_HOST;

  // If no REDIS_HOST is set, skip Redis entirely — use in-memory
  if (!host || host === '127.0.0.1' || host === 'localhost') {
    logger.info('Redis not configured — using in-memory store (game works normally)');
    store = fallback;
    return;
  }

  // Redis IS configured — try to connect with limited retries
  try {
    const { createClient } = require('redis');

    const client = createClient({
      socket: {
        host,
        port:            parseInt(process.env.REDIS_PORT) || 6379,
        reconnectStrategy: (retries) => {
          // Stop retrying after 5 attempts
          if (retries >= 5) {
            logger.warn('Redis gave up after 5 retries — switching to in-memory');
            store = fallback;
            return false; // stop reconnecting
          }
          return Math.min(retries * 500, 3000);
        },
        connectTimeout: 5000,
      },
      password: process.env.REDIS_PASSWORD || undefined,
    });

    client.on('error', err => {
      // Only log once, not every 500ms
      if (!client._loggedError) {
        logger.warn('Redis unavailable — using in-memory fallback');
        client._loggedError = true;
        store = fallback;
      }
    });

    client.on('connect', () => {
      logger.info('✅ Redis connected');
      client._loggedError = false;
      store = client;
    });

    await client.connect();
    store = client;
    logger.info('✅ Redis store active');

  } catch (e) {
    logger.warn('Redis connection failed — using in-memory fallback:', e.message);
    store = fallback;
  }
}

// Proxy — works regardless of whether Redis or memory is active
const proxy = {
  get:     (k)       => store.get(k),
  set:     (k, v)    => store.set(k, v),
  setEx:   (k, t, v) => store.setEx(k, t, v),
  del:     (k)       => store.del(k),
  incr:    (k)       => store.incr(k),
  expire:  (k, t)    => store.expire(k, t),
  hSet:    (k, f, v) => store.hSet(k, f, v),
  hGet:    (k, f)    => store.hGet(k, f),
  hGetAll: (k)       => store.hGetAll(k),
  init,
};

module.exports = proxy;
