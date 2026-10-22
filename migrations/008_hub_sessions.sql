CREATE TABLE IF NOT EXISTS hub_sessions (
  session_id CHAR(32) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  secret_fingerprint CHAR(64) NOT NULL,
  device_name VARCHAR(128) NOT NULL DEFAULT '',
  platform VARCHAR(32) NOT NULL DEFAULT '',
  user_agent VARCHAR(255) NOT NULL DEFAULT '',
  persistent BOOLEAN NOT NULL DEFAULT TRUE,
  created_at DATETIME(3) NOT NULL,
  last_seen_at DATETIME(3) NOT NULL,
  expires_at DATETIME(3) NULL,
  revoked_at DATETIME(3) NULL,
  PRIMARY KEY (session_id),
  UNIQUE KEY uq_hub_sessions_token_hash (token_hash),
  KEY idx_hub_sessions_last_seen (last_seen_at),
  KEY idx_hub_sessions_revoked (revoked_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
