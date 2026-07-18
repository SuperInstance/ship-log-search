#!/bin/sh
# init-db.sh — Initialize the local D1 SQLite database for ship-log-search.
#
# Runs once on container startup, before wrangler dev takes over.
# - Ensures the persistence directory exists.
# - Applies every .sql file in /app/migrations/ in alphabetical order.
# - Idempotent: safe to run on every container start.
# - Hands off to the CMD via `exec "$@"` so PID 1 becomes wrangler dev.

set -eu

# ─── Pretty logging ───────────────────────────────────────────────────────────
log()  { printf '[init-db] %s\n' "$*"; }
warn() { printf '[init-db] WARN: %s\n' "$*" >&2; }

# ─── Banner ───────────────────────────────────────────────────────────────────
log "================================================"
log "  Ship Log Search — init-db.sh"
log "================================================"

# ─── Ensure persistence dir exists ───────────────────────────────────────────
mkdir -p /data
log "Persistence directory: /data"

# ─── Apply migrations in order ───────────────────────────────────────────────
cd /app

MIGRATION_DIR="${MIGRATION_DIR:-/app/migrations}"

if [ ! -d "$MIGRATION_DIR" ]; then
    warn "Migration directory $MIGRATION_DIR not found, skipping schema setup."
else
    # Find all .sql files, sort them alphabetically, apply each one.
    SQL_FILES=$(find "$MIGRATION_DIR" -maxdepth 1 -type f -name '*.sql' | sort)

    if [ -z "$SQL_FILES" ]; then
        warn "No .sql files in $MIGRATION_DIR, skipping schema setup."
    else
        for SQL_FILE in $SQL_FILES; do
            log "Applying migration: $(basename "$SQL_FILE")"
            # Use --yes to auto-confirm any prompts.
            # Pipe stdout/stderr through cat so the output is readable
            # even when wrangler colorizes output.
            if npx wrangler d1 execute ship-log-db \
                    --local \
                    --persist-to=/data \
                    --file="$SQL_FILE" \
                    --yes 2>&1; then
                log "  ✓ $(basename "$SQL_FILE") applied."
            else
                warn "  ! $(basename "$SQL_FILE") returned non-zero (may already be applied)."
            fi
        done
    fi
fi

# ─── Verify schema ───────────────────────────────────────────────────────────
log "Verifying schema..."
if npx wrangler d1 execute ship-log-db \
        --local \
        --persist-to=/data \
        --command="SELECT name FROM sqlite_master WHERE type='table' AND name='logs';" \
        --yes 2>&1 | grep -q "logs"; then
    log "✓ Schema verified — logs table present."
else
    warn "Could not verify logs table — search queries may fail until it exists."
fi

log "Initialization complete. Starting worker..."
log "================================================"

# ─── Hand off to CMD (wrangler dev) ──────────────────────────────────────────
# exec replaces this shell process so signals (SIGTERM, SIGINT) flow to wrangler.
exec "$@"