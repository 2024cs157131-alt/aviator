require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const session    = require('express-session');
const helmet     = require('helmet');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const path       = require('path');

const db      = require('./db');
const redis   = require('./redis');
const logger  = require('./logger');
const engine  = require('./game/engine');
const routes  = require('./auth/routes');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors:       { origin: '*', methods: ['GET','POST'] },
  transports: ['websocket','polling'],
  pingTimeout:   60000,
  pingInterval:  25000,
});

// ── SESSION ──────────────────────────────────────────────────
const sessionMiddleware = session({
  secret:            process.env.SESSION_SECRET || 'dev_fallback_secret_change_in_prod',
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
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'","'unsafe-inline'",'https://js.paystack.co','https://fonts.googleapis.com'],
      styleSrc:   ["'self'","'unsafe-inline'",'https://fonts.googleapis.com','https://fonts.gstatic.com'],
      fontSrc:    ["'self'",'https://fonts.gstatic.com'],
      connectSrc: ["'self'",'wss:','ws:','https://api.paystack.co'],
      imgSrc:     ["'self'",'data:'],
    }
  }
}));
app.use(cors({ origin: process.env.NODE_ENV === 'production' ? false : '*', credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use('/api', rateLimit({ windowMs: 60000, max: 200, message: { ok: false, msg: 'Too many requests' } }));
app.use(express.static(path.join(__dirname, '../public')));

// ── HEALTH CHECK — Railway pings this to know app is alive ──
app.get('/health', (req, res) => res.json({ ok: true, status: appStatus }));

// ── ROUTES ───────────────────────────────────────────────────
app.use('/api', routes);
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

// ── SOCKET.IO ────────────────────────────────────────────────
engine.setIO(io);

io.on('connection', async (socket) => {
  const userId   = socket.request.session?.userId;
  const username = socket.request.session?.username;
  logger.debug(`[WS] connect: ${username || 'guest'} (${socket.id})`);

  socket.emit('game:state', engine.getStateSnapshot());
  try {
    const history = await engine.getHistory(20);
    socket.emit('game:history', history);
  } catch(e) { /* db not ready yet */ }

  socket.on('bet:place', async (data) => {
    if (!userId) return socket.emit('error', { msg: 'Login required' });
    const result = await engine.placeBet(userId, parseFloat(data.amount)||0, parseFloat(data.autoCashout)||0, socket.handshake.address, socket.id);
    result.ok ? socket.emit('bet:confirm', { betId: result.betId, newBalance: result.newBalance })
              : socket.emit('error', { msg: result.msg });
  });

  socket.on('bet:cashout', async (data) => {
    if (!userId) return socket.emit('error', { msg: 'Login required' });
    const result = await engine.cashOut(userId, parseInt(data.roundId));
    result.ok ? socket.emit('cashout:confirm', { cashout_at: result.cashout_at, win: result.win, newBalance: result.newBalance })
              : socket.emit('error', { msg: result.msg });
  });

  socket.on('verify:round', async ({ roundId }) => {
    const { verifyRound } = require('./game/provableFair');
    const round = await db.one('SELECT * FROM rounds WHERE id=? AND status=?', [roundId, 'crashed']);
    socket.emit('verify:result', round ? { ok: true, roundId, ...verifyRound(round) } : { ok: false, msg: 'Round not found' });
  });

  socket.on('disconnect', () => logger.debug(`[WS] disconnect: ${username || 'guest'}`));
});

// ── STARTUP ──────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT) || 3000;
let appStatus = 'starting';

process.on('SIGTERM', () => {
  logger.info('SIGTERM — shutting down');
  server.close(() => process.exit(0));
});
process.on('uncaughtException',  err => logger.error('Uncaught exception:', err));
process.on('unhandledRejection', err => logger.error('Unhandled rejection:', err));

// ── START HTTP SERVER FIRST so Railway health checks pass ──
server.listen(PORT, async () => {
  logger.info(`\n🚀 Crown Pesa Aviator — HTTP server listening on port ${PORT}`);
  logger.info(`   Connecting to database...\n`);

  // Then connect to DB and start game — after HTTP is already up
  // Small delay so Railway's network proxy is fully ready before DB queries
  await new Promise(r => setTimeout(r, 1500));

  try {
    await redis.init();
    logger.info('Redis init complete');

    await db.install();
    logger.info('Database ready');

    // engine.startEngine() has its own retry logic for DB warmup
    await engine.startEngine();
    logger.info('Game engine started');

    appStatus = 'ready';
    logger.info('\n✅ Crown Pesa Aviator is FULLY READY\n');

  } catch (err) {
    appStatus = 'error';
    logger.error('\n❌ STARTUP ERROR: ' + err.message);
    logger.error('HTTP server stays alive — check variables and redeploy.\n');
    // Keep server alive — do NOT call process.exit()
    // Railway will show the error and let you fix it without a restart loop
  }
});