require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const session    = require('express-session');
const helmet     = require('helmet');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const path       = require('path');

const db     = require('./db');
const redis  = require('./redis');
const logger = require('./logger');
const engine = require('./game/engine');
const routes = require('./auth/routes');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors:          { origin: '*', methods: ['GET','POST'] },
  transports:    ['websocket','polling'],
  pingTimeout:   60000,
  pingInterval:  25000,
});

// Trust Railway reverse proxy
app.set('trust proxy', 1);

// ── SESSION (memory store — no Redis dependency) ─────────────
const sessionMiddleware = session({
  secret:            process.env.SESSION_SECRET || 'crownpesa_dev_secret_change_me',
  resave:            false,
  saveUninitialized: false,
  cookie: {
    secure:   process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge:   7 * 24 * 60 * 60 * 1000,
    sameSite: 'lax',
  },
});
app.use(sessionMiddleware);
io.use((socket, next) => sessionMiddleware(socket.request, socket.request.res || {}, next));

// ── MIDDLEWARE ───────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:    ["'self'"],
      // 'unsafe-hashes' needed for onclick="..." attributes in HTML
      scriptSrc:     ["'self'", "'unsafe-inline'", "'unsafe-hashes'",
                      'https://js.paystack.co', 'https://fonts.googleapis.com'],
      // script-src-attr controls inline event handlers (onclick etc.)
      scriptSrcAttr: ["'unsafe-inline'"],
      // Paystack loads its own CSS from paystack.com
      styleSrc:      ["'self'", "'unsafe-inline'",
                      'https://fonts.googleapis.com', 'https://fonts.gstatic.com',
                      'https://paystack.com', 'https://*.paystack.com'],
      styleSrcElem:  ["'self'", "'unsafe-inline'",
                      'https://fonts.googleapis.com', 'https://fonts.gstatic.com',
                      'https://paystack.com', 'https://*.paystack.com'],
      fontSrc:       ["'self'", 'https://fonts.gstatic.com', 'https://paystack.com'],
      // Paystack checkout loads in an iframe from checkout.paystack.com
      frameSrc:      ['https://checkout.paystack.com', 'https://*.paystack.com'],
      connectSrc:    ["'self'", 'wss:', 'ws:',
                      'https://api.paystack.co', 'https://*.paystack.com'],
      imgSrc:        ["'self'", 'data:', 'https://*.paystack.com'],
    }
  },
  // Keep other helmet protections but don't let them interfere
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy:   false,
}));
app.use(cors({ origin: process.env.NODE_ENV === 'production' ? false : '*', credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use('/api', rateLimit({ windowMs: 60000, max: 200, message: { ok: false, msg: 'Too many requests' } }));
app.use(express.static(path.join(__dirname, '../public')));

// ── HEALTH CHECK ─────────────────────────────────────────────
let appStatus = 'starting';
app.get('/health', (req, res) => res.json({ ok: true, status: appStatus }));

// ── API ROUTES ───────────────────────────────────────────────
app.use('/api', routes);

// ── API 404 — must come BEFORE the SPA fallback ──────────────
// If an /api/* route wasn't handled above, return JSON not HTML
app.all('/api/*', (req, res) => {
  res.status(404).json({ ok: false, msg: 'API endpoint not found: ' + req.path });
});

// ── JSON error handler for API routes ───────────────────────
app.use('/api', (err, req, res, next) => {
  logger.error('API error:', err);
  res.status(500).json({ ok: false, msg: 'Server error — check logs' });
});

// ── SPA fallback — only for non-API routes ───────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

// ── SOCKET.IO ────────────────────────────────────────────────
engine.setIO(io);

io.on('connection', async (socket) => {
  const userId   = socket.request.session?.userId;
  const username = socket.request.session?.username;
  logger.debug(`[WS] connect: ${username || 'guest'} (${socket.id})`);

  // Send current game state + history immediately
  socket.emit('game:state', engine.getStateSnapshot());
  try {
    const history = await engine.getHistory(20);
    socket.emit('game:history', history);
  } catch(e) {}

  socket.on('bet:place', async (data) => {
    if (!userId) return socket.emit('error', { msg: 'Login required to bet' });
    const result = await engine.placeBet(
      userId,
      parseFloat(data.amount) || 0,
      parseFloat(data.autoCashout) || 0,
      socket.handshake.address,
      socket.id
    );
    if (result.ok) socket.emit('bet:confirm', { betId: result.betId, newBalance: result.newBalance });
    else           socket.emit('error', { msg: result.msg });
  });

  socket.on('bet:cashout', async (data) => {
    if (!userId) return socket.emit('error', { msg: 'Login required' });
    const result = await engine.cashOut(userId, parseInt(data.roundId));
    if (result.ok) socket.emit('cashout:confirm', { cashout_at: result.cashout_at, win: result.win, newBalance: result.newBalance });
    else           socket.emit('error', { msg: result.msg });
  });

  socket.on('disconnect', () => logger.debug(`[WS] disconnect: ${username || 'guest'}`));
});

// ── GRACEFUL SHUTDOWN ────────────────────────────────────────
process.on('SIGTERM', () => { logger.info('SIGTERM'); server.close(() => process.exit(0)); });
process.on('uncaughtException',  err => logger.error('Uncaught exception:', err));
process.on('unhandledRejection', err => logger.error('Unhandled rejection:', err));

// ── START — HTTP first, then DB ───────────────────────────────
const PORT = parseInt(process.env.PORT) || 3000;

server.listen(PORT, '0.0.0.0', async () => {
  logger.info(`\n🚀 Crown Pesa Aviator listening on port ${PORT}`);

  await new Promise(r => setTimeout(r, 1500)); // Railway proxy warmup

  try {
    await redis.init();
    await db.install();
    await engine.startEngine();
    appStatus = 'ready';
    logger.info('✅ Crown Pesa Aviator FULLY READY\n');
  } catch (err) {
    appStatus = 'error';
    logger.error('❌ STARTUP ERROR: ' + err.message);
    // Keep alive so you can see the error — do NOT exit
  }
});