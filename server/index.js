/**
 * CROWN PESA AVIATOR — Main Server
 *
 * Starts:
 *   1. Express HTTP server (REST API + static files)
 *   2. Socket.io WebSocket server (real-time game)
 *   3. Game engine loop
 *   4. Database schema install
 *   5. Redis connection
 */

require('dotenv').config();
const express        = require('express');
const http           = require('http');
const { Server }     = require('socket.io');
const session        = require('express-session');
const helmet         = require('helmet');
const cors           = require('cors');
const rateLimit      = require('express-rate-limit');
const path           = require('path');

const db             = require('./db');
const redis          = require('./redis');
const logger         = require('./logger');
const engine         = require('./game/engine');
const routes         = require('./auth/routes');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors:          { origin: '*', methods: ['GET','POST'] },
  transports:    ['websocket','polling'],
  pingTimeout:   60000,
  pingInterval:  25000,
});

// ── SESSION ──────────────────────────────────────────────────
const sessionMiddleware = session({
  secret:            process.env.SESSION_SECRET || 'dev_secret',
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

// Share session with Socket.io
io.use((socket, next) => {
  sessionMiddleware(socket.request, socket.request.res || {}, next);
});

// ── SECURITY MIDDLEWARE ──────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'", 'https://js.paystack.co', 'https://fonts.googleapis.com'],
      styleSrc:   ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://fonts.gstatic.com'],
      fontSrc:    ["'self'", 'https://fonts.gstatic.com'],
      connectSrc: ["'self'", 'wss:', 'ws:', 'https://api.paystack.co'],
      imgSrc:     ["'self'", 'data:'],
    }
  }
}));

app.use(cors({
  origin:      process.env.NODE_ENV === 'production' ? false : '*',
  credentials: true,
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Global rate limiter
app.use('/api', rateLimit({
  windowMs: 60000,
  max:      200,
  message:  { ok: false, msg: 'Too many requests' },
  standardHeaders: true,
}));

// Static files
app.use(express.static(path.join(__dirname, '../public')));

// ── ROUTES ───────────────────────────────────────────────────
app.use('/api', routes);

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ── SOCKET.IO ────────────────────────────────────────────────
engine.setIO(io);

io.on('connection', async (socket) => {
  const userId   = socket.request.session?.userId;
  const username = socket.request.session?.username;

  logger.debug(`[WS] connect: ${username || 'guest'} (${socket.id})`);

  // Immediately send current game state + history
  socket.emit('game:state', engine.getStateSnapshot());
  const history = await engine.getHistory(20);
  socket.emit('game:history', history);

  // ── BET ─────────────────────────────────────────────────
  socket.on('bet:place', async (data) => {
    if (!userId) return socket.emit('error', { msg: 'Login required' });

    const { amount, autoCashout } = data;
    const result = await engine.placeBet(
      userId,
      parseFloat(amount) || 0,
      parseFloat(autoCashout) || 0,
      socket.handshake.address,
      socket.id
    );

    if (result.ok) {
      socket.emit('bet:confirm', { betId: result.betId, newBalance: result.newBalance });
    } else {
      socket.emit('error', { msg: result.msg, code: result.code });
    }
  });

  // ── CASHOUT ─────────────────────────────────────────────
  socket.on('bet:cashout', async (data) => {
    if (!userId) return socket.emit('error', { msg: 'Login required' });

    const result = await engine.cashOut(userId, parseInt(data.roundId));

    if (result.ok) {
      socket.emit('cashout:confirm', {
        cashout_at: result.cashout_at,
        win:        result.win,
        newBalance: result.newBalance,
      });
    } else {
      socket.emit('error', { msg: result.msg });
    }
  });

  // ── VERIFY (provably fair) ───────────────────────────────
  socket.on('verify:round', async ({ roundId }) => {
    const { verifyRound } = require('./game/provableFair');
    const round = await db.one('SELECT * FROM rounds WHERE id=? AND status=?', [roundId, 'crashed']);
    if (!round) return socket.emit('verify:result', { ok: false, msg: 'Round not found' });
    const result = verifyRound(round);
    socket.emit('verify:result', { ok: true, roundId, ...result });
  });

  socket.on('disconnect', () => {
    logger.debug(`[WS] disconnect: ${username || 'guest'}`);
  });

  socket.on('error', err => {
    logger.error(`[WS] socket error: ${err.message}`);
  });
});

// ── GRACEFUL SHUTDOWN ────────────────────────────────────────
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received — shutting down gracefully');
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection:', reason);
});

// ── START ─────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT) || 3000;

(async () => {
  try {
    await redis.init();
    await db.install();
    await engine.startEngine();

    server.listen(PORT, () => {
      logger.info(`\n🚀 Crown Pesa Aviator running on port ${PORT}`);
      logger.info(`   http://localhost:${PORT}\n`);
    });
  } catch (err) {
    logger.error('Startup failed:', err);
    process.exit(1);
  }
})();
