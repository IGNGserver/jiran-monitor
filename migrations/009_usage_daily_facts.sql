-- Joint daily usage facts. The graph partition is replaced atomically on ingest;
-- the best-effort partition is a one-time upgrade from the append-only event
-- ledger and can never be mistaken for the original producer calendar graph.
CREATE TABLE IF NOT EXISTS usage_daily_fact_days (
  device_id VARCHAR(191) NOT NULL,
  day_key DATE NOT NULL,
  source VARCHAR(32) NOT NULL,
  time_basis VARCHAR(32) NOT NULL,
  time_zone VARCHAR(128) NOT NULL DEFAULT '',
  fact_count INT UNSIGNED NOT NULL DEFAULT 0,
  truncated BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (device_id, day_key, source),
  KEY idx_usage_daily_fact_days_day (day_key, device_id),
  CONSTRAINT fk_usage_daily_fact_days_device FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS usage_daily_facts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  device_id VARCHAR(191) NOT NULL,
  day_key DATE NOT NULL,
  client VARCHAR(100) NOT NULL,
  model VARCHAR(255) NOT NULL,
  provider VARCHAR(255) NOT NULL DEFAULT '',
  total_tokens BIGINT UNSIGNED NOT NULL DEFAULT 0,
  output_tokens BIGINT UNSIGNED NULL,
  cache_read_tokens BIGINT UNSIGNED NULL,
  cache_write_tokens BIGINT UNSIGNED NULL,
  unclassified_tokens BIGINT UNSIGNED NULL,
  cost_usd DECIMAL(24,10) NULL,
  message_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  token_components_available BOOLEAN NOT NULL DEFAULT FALSE,
  provenance VARCHAR(32) NOT NULL DEFAULT 'unknown',
  source VARCHAR(32) NOT NULL,
  time_basis VARCHAR(32) NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_usage_daily_facts_day_device (day_key, device_id),
  KEY idx_usage_daily_facts_client_day (client, day_key),
  KEY idx_usage_daily_facts_model_day (model, day_key),
  KEY idx_usage_daily_facts_provider_day (provider, day_key),
  CONSTRAINT fk_usage_daily_facts_device FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Existing installations deliberately do not backfill the append-only ledger in
-- this migration: an unbounded startup INSERT would make upgrade time and write
-- amplification depend on the entire event archive. The bounded analytics read
-- queries uncovered device/day partitions on demand and labels them bestEffort;
-- exact graph partitions always take precedence over those recordedAt buckets.
