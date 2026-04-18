-- Crown Pesa Aviator — MySQL Schema
-- Run automatically by db.install() on first boot

CREATE TABLE IF NOT EXISTS users (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  uuid            VARCHAR(36)  NOT NULL UNIQUE,
  username        VARCHAR(50)  NOT NULL UNIQUE,
  email           VARCHAR(120) NOT NULL UNIQUE,
  password        VARCHAR(100) NOT NULL,
  country_code    CHAR(2)      NOT NULL DEFAULT 'KE',
  currency_code   VARCHAR(8)   NOT NULL DEFAULT 'KES',
  balance         DECIMAL(18,4) NOT NULL DEFAULT 0,
  is_admin        TINYINT(1)   NOT NULL DEFAULT 0,
  is_suspended    TINYINT(1)   NOT NULL DEFAULT 0,
  risk_level      ENUM('low','medium','high') NOT NULL DEFAULT 'low',
  bot_score       DECIMAL(5,2) NOT NULL DEFAULT 0,
  last_login      DATETIME,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_email (email),
  INDEX idx_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS rounds (
  id                INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  server_seed       VARCHAR(64)  NOT NULL,
  server_seed_hash  VARCHAR(64)  NOT NULL,
  client_seed       VARCHAR(64)  NOT NULL,
  nonce             INT UNSIGNED NOT NULL,
  hmac_result       VARCHAR(64),
  crash_point       DECIMAL(10,2) NOT NULL,
  status            ENUM('waiting','in_progress','crashed') NOT NULL DEFAULT 'waiting',
  player_count      INT UNSIGNED  NOT NULL DEFAULT 0,
  total_wagered     DECIMAL(18,4) NOT NULL DEFAULT 0,
  started_at        BIGINT,
  crashed_at        BIGINT,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS bets (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  round_id        INT UNSIGNED NOT NULL,
  user_id         INT UNSIGNED NOT NULL,
  amount          DECIMAL(18,4) NOT NULL,
  currency_code   VARCHAR(8)   NOT NULL,
  auto_cashout    DECIMAL(10,2),
  cashout_at      DECIMAL(10,2),
  profit          DECIMAL(18,4),
  status          ENUM('active','won','lost','void') NOT NULL DEFAULT 'active',
  bet_placed_ms   INT UNSIGNED,
  cashout_ms      INT UNSIGNED,
  ip_address      VARCHAR(50),
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_round  (round_id),
  INDEX idx_user   (user_id),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS transactions (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id         INT UNSIGNED NOT NULL,
  type            ENUM('deposit','withdrawal','bet','win','adjustment','bonus') NOT NULL,
  amount          DECIMAL(18,4) NOT NULL,
  balance_before  DECIMAL(18,4) NOT NULL DEFAULT 0,
  balance_after   DECIMAL(18,4) NOT NULL DEFAULT 0,
  currency_code   VARCHAR(8)   NOT NULL DEFAULT 'KES',
  reference       VARCHAR(100),
  status          ENUM('pending','completed','failed','reversed') NOT NULL DEFAULT 'pending',
  bank_name       VARCHAR(100),
  account_number  VARCHAR(50),
  account_name    VARCHAR(100),
  admin_note      TEXT,
  ip_address      VARCHAR(50),
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user   (user_id),
  INDEX idx_type   (type),
  INDEX idx_status (status),
  INDEX idx_ref    (reference)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS game_settings (
  setting_key   VARCHAR(60)  NOT NULL PRIMARY KEY,
  setting_value VARCHAR(255) NOT NULL,
  updated_by    INT UNSIGNED,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO game_settings (setting_key, setting_value) VALUES
  ('min_bet',               '10'),
  ('max_bet',               '50000'),
  ('round_wait_ms',         '8000'),
  ('maintenance_mode',      '0'),
  ('manual_crash_point',    '2.00'),
  ('manual_crash_enabled',  '0');

CREATE TABLE IF NOT EXISTS fraud_events (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     INT UNSIGNED NOT NULL,
  event_type  VARCHAR(60)  NOT NULL,
  severity    ENUM('low','medium','high','critical') NOT NULL DEFAULT 'medium',
  bot_score   DECIMAL(5,2) NOT NULL DEFAULT 0,
  details     JSON,
  resolved    TINYINT(1)   NOT NULL DEFAULT 0,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user     (user_id),
  INDEX idx_resolved (resolved)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS audit_log (
  id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  actor_id       INT UNSIGNED,
  target_user_id INT UNSIGNED,
  action         VARCHAR(80)  NOT NULL,
  old_value      TEXT,
  new_value      TEXT,
  ip_address     VARCHAR(50),
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_actor  (actor_id),
  INDEX idx_target (target_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS responsible_gaming (
  user_id        INT UNSIGNED NOT NULL PRIMARY KEY,
  daily_limit    DECIMAL(18,4),
  weekly_limit   DECIMAL(18,4),
  self_excluded  TINYINT(1)   NOT NULL DEFAULT 0,
  exclude_until  DATETIME,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
