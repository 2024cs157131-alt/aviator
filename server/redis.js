const { createClient } = require('redis');
const logger = require('./logger');
require('dotenv').config();

const client = createClient({
  socket: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT) || 6379,
  },
  password: process.env.REDIS_PASSWORD || undefined,
  database: parseInt(process.env.REDIS_DB) || 0,
});

client.on('error', err => logger.error('Redis error:', err.message));
client.on('connect', () => logger.info('✅ Redis connected'));
client.on('reconnecting', () => logger.warn('Redis reconnecting...'));

let connected = false;

async function connect() {
  if (!connected) {
    await client.connect();
    connected = true;
  }
  return client;
}

// Graceful fallback — if Redis isn't available, use in-memory
const memStore = new Map();
const fallback = {
  get:    async (k)    => memStore.get(k) ?? null,
  set:    async (k, v) => { memStore.set(k, v); return 'OK'; },
  setEx:  async (k, t, v) => { memStore.set(k, v); return 'OK'; },
  del:    async (k)    => { memStore.delete(k); return 1; },
  incr:   async (k)    => { const v = (parseInt(memStore.get(k)) || 0) + 1; memStore.set(k, String(v)); return v; },
  expire: async ()     => 1,
  hSet:   async (k, f, v) => { if (!memStore.has(k)) memStore.set(k, {}); memStore.get(k)[f] = v; return 1; },
  hGet:   async (k, f) => memStore.get(k)?.[f] ?? null,
  hGetAll:async (k)    => memStore.get(k) || {},
};

let store = fallback;

async function init() {
  try {
    await connect();
    store = client;
    logger.info('Redis store active');
  } catch (e) {
    logger.warn('Redis unavailable — using in-memory fallback:', e.message);
    store = fallback;
  }
}

// Proxy methods that work regardless of Redis availability
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
