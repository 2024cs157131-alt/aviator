-- ═══════════════════════════════════════════════════════════
-- CROWN PESA AVIATOR — DATABASE SCHEMA
-- ═══════════════════════════════════════════════════════════

SET FOREIGN_KEY_CHECKS = 0;

-- ── USERS ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  uuid            CHAR(36)     NOT NULL UNIQUE,
  username        VARCHAR(50)  NOT NULL UNIQUE,
  email           VARCHAR(100) NOT NULL UNIQUE,
  password        VARCHAR(255) NOT NULL,
  country_code    CHAR(2)      NOT NULL DEFAULT 'KE',
  currency_code   CHAR(3)      NOT NULL DEFAULT 'KES',
  balance         DECIMAL(18,4) NOT NULL DEFAULT 0.0000,
  bonus_balance   DECIMAL(18,4) NOT NULL DEFAULT 0.0000,
  is_admin        TINYINT(1)   NOT NULL DEFAULT 0,
  is_suspended    TINYINT(1)   NOT NULL DEFAULT 0,
  is_self_excluded TINYINT(1)  NOT NULL DEFAULT 0,
  kyc_verified    TINYINT(1)   NOT NULL DEFAULT 0,
  two_fa_enabled  TINYINT(1)   NOT NULL DEFAULT 0,
  bot_score       DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  risk_level      ENUM('normal','suspicious','high','banned') NOT NULL DEFAULT 'normal',
  daily_deposit_limit   DECIMAL(18,4) NULL,
  daily_loss_limit      DECIMAL(18,4) NULL,
  session_time_limit    INT NULL COMMENT 'minutes',
  last_login      TIMESTAMP    NULL,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_email (email),
  INDEX idx_uuid (uuid),
  INDEX idx_risk (risk_level),
  INDEX idx_bot_score (bot_score)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── ROUNDS ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rounds (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  server_seed     VARCHAR(128)  NOT NULL,
  server_seed_hash VARCHAR(128) NOT NULL COMMENT 'Published before round — SHA256 of server_seed',
  client_seed     VARCHAR(128)  NOT NULL,
  nonce           BIGINT UNSIGNED NOT NULL,
  hmac_result     VARCHAR(128)  NOT NULL COMMENT 'HMAC-SHA256(server_seed, client_seed+nonce)',
  crash_point     DECIMAL(10,4) NOT NULL,
  status          ENUM('waiting','in_progress','crashed') NOT NULL DEFAULT 'waiting',
  player_count    INT UNSIGNED  NOT NULL DEFAULT 0,
  total_wagered   DECIMAL(18,4) NOT NULL DEFAULT 0,
  total_paid_out  DECIMAL(18,4) NOT NULL DEFAULT 0,
  house_profit    DECIMAL(18,4) NOT NULL DEFAULT 0,
  started_at      BIGINT        NULL COMMENT 'Unix ms',
  crashed_at      BIGINT        NULL COMMENT 'Unix ms',
  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_status (status),
  INDEX idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── BETS ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bets (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  round_id        BIGINT UNSIGNED NOT NULL,
  user_id         INT UNSIGNED    NOT NULL,
  amount          DECIMAL(18,4)   NOT NULL,
  currency_code   CHAR(3)         NOT NULL DEFAULT 'KES',
  auto_cashout    DECIMAL(10,4)   NULL,
  cashout_at      DECIMAL(10,4)   NULL,
  profit          DECIMAL(18,4)   NULL,
  status          ENUM('active','won','lost','cancelled') NOT NULL DEFAULT 'active',
  bet_placed_ms   BIGINT          NOT NULL COMMENT 'ms after round open',
  cashout_ms      BIGINT          NULL     COMMENT 'ms after round start',
  ip_address      VARCHAR(45)     NULL,
  created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_round (round_id),
  INDEX idx_user  (user_id),
  INDEX idx_status (status),
  FOREIGN KEY (round_id) REFERENCES rounds(id),
  FOREIGN KEY (user_id)  REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── TRANSACTIONS ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transactions (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id         INT UNSIGNED    NOT NULL,
  type            ENUM('deposit','withdrawal','bet','win','refund','adjustment','bonus') NOT NULL,
  amount          DECIMAL(18,4)   NOT NULL,
  balance_before  DECIMAL(18,4)   NOT NULL,
  balance_after   DECIMAL(18,4)   NOT NULL,
  currency_code   CHAR(3)         NOT NULL DEFAULT 'KES',
  reference       VARCHAR(100)    NULL UNIQUE,
  status          ENUM('pending','completed','failed','reversed') NOT NULL DEFAULT 'pending',
  paystack_ref    VARCHAR(100)    NULL,
  bank_name       VARCHAR(100)    NULL,
  account_number  VARCHAR(50)     NULL,
  account_name    VARCHAR(100)    NULL,
  admin_note      TEXT            NULL,
  ip_address      VARCHAR(45)     NULL,
  created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_user   (user_id),
  INDEX idx_type   (type),
  INDEX idx_status (status),
  INDEX idx_ref    (reference),
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── FRAUD EVENTS ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fraud_events (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id         INT UNSIGNED    NOT NULL,
  event_type      VARCHAR(50)     NOT NULL,
  severity        ENUM('low','medium','high','critical') NOT NULL DEFAULT 'low',
  bot_score       DECIMAL(5,2)    NOT NULL DEFAULT 0,
  details         JSON            NOT NULL,
  action_taken    VARCHAR(100)    NULL,
  resolved        TINYINT(1)      NOT NULL DEFAULT 0,
  resolved_by     INT UNSIGNED    NULL,
  created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user   (user_id),
  INDEX idx_type   (event_type),
  INDEX idx_resolved (resolved),
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── BOT BEHAVIOR SAMPLES ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS bot_samples (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id         INT UNSIGNED    NOT NULL,
  round_id        BIGINT UNSIGNED NOT NULL,
  bet_speed_ms    INT             NOT NULL COMMENT 'ms from round open to bet placed',
  cashout_speed_ms INT            NULL     COMMENT 'ms from round start to cashout',
  bet_amount      DECIMAL(18,4)   NOT NULL,
  cashout_mult    DECIMAL(10,4)   NULL,
  session_id      VARCHAR(64)     NULL,
  ip_address      VARCHAR(45)     NULL,
  user_agent_hash VARCHAR(64)     NULL,
  created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user  (user_id),
  INDEX idx_round (round_id),
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── RESPONSIBLE GAMING ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS responsible_gaming (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id         INT UNSIGNED    NOT NULL UNIQUE,
  daily_deposit_limit   DECIMAL(18,4) NULL,
  daily_loss_limit      DECIMAL(18,4) NULL,
  weekly_loss_limit     DECIMAL(18,4) NULL,
  session_limit_minutes INT          NULL,
  self_exclusion_until  TIMESTAMP    NULL,
  cool_off_until        TIMESTAMP    NULL,
  today_deposited       DECIMAL(18,4) NOT NULL DEFAULT 0,
  today_lost            DECIMAL(18,4) NOT NULL DEFAULT 0,
  limits_reset_at       DATE         NOT NULL DEFAULT (CURRENT_DATE),
  created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── AUDIT LOG ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  actor_id        INT UNSIGNED    NULL COMMENT 'admin who took action',
  target_user_id  INT UNSIGNED    NULL,
  action          VARCHAR(100)    NOT NULL,
  old_value       JSON            NULL,
  new_value       JSON            NULL,
  ip_address      VARCHAR(45)     NULL,
  created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_actor  (actor_id),
  INDEX idx_target (target_user_id),
  INDEX idx_action (action)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── GAME SETTINGS ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS game_settings (
  setting_key     VARCHAR(100)   PRIMARY KEY,
  setting_value   TEXT           NOT NULL,
  updated_by      INT UNSIGNED   NULL,
  updated_at      TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO game_settings (setting_key, setting_value) VALUES
  ('min_bet',               '10'),
  ('max_bet',               '50000'),
  ('round_wait_ms',         '8000'),
  ('house_edge',            '0.05'),
  ('maintenance_mode',      '0'),
  ('manual_crash_enabled',  '0'),
  ('manual_crash_point',    '2.00'),
  ('max_concurrent_bets',   '2'),
  ('captcha_enabled',       '0'),
  ('min_cashout_mult',      '1.01');

SET FOREIGN_KEY_CHECKS = 1;
