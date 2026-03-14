/**
 * Database Module — MySQL connection pool with helpers
 */
const mysql  = require('mysql2/promise');
const logger = require('./logger');
require('dotenv').config();

const pool = mysql.createPool({
  host:               process.env.DB_HOST     || 'localhost',
  port:               parseInt(process.env.DB_PORT) || 3306,
  database:           process.env.DB_NAME,
  user:               process.env.DB_USER,
  password:           process.env.DB_PASS,
  waitForConnections: true,
  connectionLimit:    parseInt(process.env.DB_POOL_SIZE) || 20,
  queueLimit:         0,
  timezone:           'Z',
  charset:            'utf8mb4',
});

pool.on('connection', () => logger.debug('DB: new connection'));

/**
 * Execute a query — returns raw result
 */
async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

/**
 * Fetch single row or null
 */
async function one(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

/**
 * Insert and return insert ID
 */
async function insert(sql, params = []) {
  const [result] = await pool.execute(sql, params);
  return result.insertId;
}

/**
 * Run queries inside a transaction — auto-commits or rolls back
 */
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

/**
 * Atomically debit a user's balance — throws if insufficient funds
 */
async function debitBalance(conn, userId, amount) {
  const [result] = await conn.execute(
    'UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?',
    [amount, userId, amount]
  );
  if (result.affectedRows === 0) {
    throw new Error('INSUFFICIENT_BALANCE');
  }
}

/**
 * Atomically credit a user's balance
 */
async function creditBalance(conn, userId, amount) {
  await conn.execute(
    'UPDATE users SET balance = balance + ? WHERE id = ?',
    [amount, userId]
  );
}

/**
 * Install schema on first run
 */
async function install() {
  const fs   = require('fs');
  const path = require('path');
  const sql  = fs.readFileSync(path.join(__dirname, '../database/schema.sql'), 'utf8');

  // Split on semicolons and run each statement
  const statements = sql
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('--'));

  for (const stmt of statements) {
    try {
      await pool.execute(stmt);
    } catch (e) {
      if (!e.message.includes('already exists')) {
        logger.warn('Schema warning:', e.message.substring(0, 100));
      }
    }
  }
  logger.info('✅ Database schema ready');
}

module.exports = { pool, query, one, insert, transaction, debitBalance, creditBalance, install };
