/**
 * Database Module — MySQL connection pool with helpers
 * Has a 10-second connection timeout so startup never hangs
 */
const mysql  = require('mysql2/promise');
const logger = require('./logger');
require('dotenv').config();

// Validate required env vars at startup and log clearly
function checkConfig() {
  const required = ['DB_HOST','DB_NAME','DB_USER','DB_PASS'];
  const missing  = required.filter(k => !process.env[k]);
  if (missing.length > 0) {
    logger.error('═══════════════════════════════════════════');
    logger.error('MISSING DATABASE ENVIRONMENT VARIABLES:');
    missing.forEach(k => logger.error(`  ✗ ${k} is not set`));
    logger.error('Add these in Railway → App service → Variables tab');
    logger.error('═══════════════════════════════════════════');
    return false;
  }
  return true;
}

const pool = mysql.createPool({
  host:               process.env.DB_HOST     || 'localhost',
  port:               parseInt(process.env.DB_PORT) || 3306,
  database:           process.env.DB_NAME,
  user:               process.env.DB_USER,
  password:           process.env.DB_PASS,
  waitForConnections: true,
  connectionLimit:    parseInt(process.env.DB_POOL_SIZE) || 10,
  queueLimit:         0,
  timezone:           'Z',
  charset:            'utf8mb4',
  connectTimeout:     30000,   // 30s — Railway proxy needs time on cold start
  enableKeepAlive:    true,
  keepAliveInitialDelay: 0,
});

pool.on('connection', () => logger.debug('DB: new connection opened'));

async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

async function one(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

async function insert(sql, params = []) {
  const [result] = await pool.execute(sql, params);
  return result.insertId;
}

async function transaction(fn) {
  const conn = await pool.getConnection();
  await conn.beginTransaction();
  try {
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function debitBalance(conn, userId, amount) {
  const [result] = await conn.execute(
    'UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?',
    [amount, userId, amount]
  );
  if (result.affectedRows === 0) throw new Error('INSUFFICIENT_BALANCE');
}

async function creditBalance(conn, userId, amount) {
  await conn.execute('UPDATE users SET balance = balance + ? WHERE id = ?', [amount, userId]);
}

async function install() {
  if (!checkConfig()) {
    throw new Error('Missing required database environment variables — see logs above');
  }

  // Test connection first with clear error message
  try {
    const conn = await pool.getConnection();
    conn.release();
    logger.info('✅ Database connected successfully');
  } catch (err) {
    logger.error('═══════════════════════════════════════════');
    logger.error('DATABASE CONNECTION FAILED:');
    logger.error(`  Error: ${err.message}`);
    logger.error('Check your DB_HOST, DB_NAME, DB_USER, DB_PASS in Railway Variables');
    logger.error('═══════════════════════════════════════════');
    throw err;
  }

  const fs   = require('fs');
  const path = require('path');
  const sql  = fs.readFileSync(path.join(__dirname, '../database/schema.sql'), 'utf8');

  const statements = sql
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 10 && !s.startsWith('--') && !s.startsWith('/*'));

  for (const stmt of statements) {
    try {
      await pool.execute(stmt);
    } catch (e) {
      if (!e.message.includes('already exists') && !e.message.includes('Duplicate')) {
        logger.warn('Schema note:', e.message.substring(0, 120));
      }
    }
  }
  logger.info('✅ Database schema ready');
}

module.exports = { pool, query, one, insert, transaction, debitBalance, creditBalance, install };
