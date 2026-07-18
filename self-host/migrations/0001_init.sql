-- 0001_init.sql
-- Initial schema for ship-log-search D1 database.
-- Extracted from VESSEL_SETUP.md and the Worker source (src/index.js).
-- Idempotent: safe to re-apply on every container start.

CREATE TABLE IF NOT EXISTS logs (
    id           TEXT PRIMARY KEY,
    text         TEXT NOT NULL,
    category     TEXT NOT NULL DEFAULT 'observation',
    lat          REAL,
    lon          REAL,
    location_name TEXT,
    timestamp    TEXT NOT NULL,
    metadata     TEXT,
    created_at   INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_logs_ts     ON logs (timestamp);
CREATE INDEX IF NOT EXISTS idx_logs_cat    ON logs (category);
CREATE INDEX IF NOT EXISTS idx_logs_latlon ON logs (lat, lon);

-- Future migrations go here as 0002_*.sql, 0003_*.sql, etc.
-- init-db.sh picks them up automatically in alphabetical order.