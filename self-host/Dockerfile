# syntax=docker/dockerfile:1.7
# ──────────────────────────────────────────────────────────────────────────────
# ship-log-search — self-host Dockerfile
#
# Builds a minimal Node.js 22 image that runs the Worker locally via
# `wrangler dev --local --persist-to=/data`. D1 is emulated by Miniflare
# using a local SQLite file under /data. Workers AI + Vectorize continue
# to call Cloudflare's free tier (auth via CLOUDFLARE_API_TOKEN).
#
# Build context is the repo root (..), so paths below are relative to it.
# ──────────────────────────────────────────────────────────────────────────────

FROM node:22-alpine AS base

# wget is needed for the HEALTHCHECK below (busybox ships it, but be explicit).
# tini gives us a proper PID 1 so SIGTERM cleanly stops wrangler dev.
RUN apk add --no-cache wget tini

# ─── Working directory ────────────────────────────────────────────────────────
WORKDIR /app

# ─── Install dependencies (cached layer) ──────────────────────────────────────
# Copy package files first so `npm ci` only re-runs when they change.
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

# ─── Copy application source ──────────────────────────────────────────────────
COPY src/ ./src/
COPY wrangler.toml ./

# ─── Copy self-host files (migrations + init script) ─────────────────────────
COPY self-host/migrations/ ./migrations/
COPY self-host/init-db.sh /usr/local/bin/init-db.sh
RUN chmod +x /usr/local/bin/init-db.sh

# ─── Persistent data directory (mounted as a Docker volume at runtime) ────────
RUN mkdir -p /data

# ─── Run as non-root for defense-in-depth ─────────────────────────────────────
RUN addgroup -S app 2>/dev/null || true \
 && adduser  -S app -G app -h /app 2>/dev/null || true \
 && chown -R app:app /app /data
USER app

# ─── Port ─────────────────────────────────────────────────────────────────────
EXPOSE 8787

# ─── Healthcheck ──────────────────────────────────────────────────────────────
# The Worker exposes /health → {"ok":true,"model":"...","version":"..."}.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=5 \
    CMD wget --quiet --tries=1 --spider http://127.0.0.1:8787/health || exit 1

# ─── Entrypoint + CMD ─────────────────────────────────────────────────────────
# init-db.sh applies migrations then `exec`s the CMD, so wrangler dev
# becomes PID 1 and receives SIGTERM directly on `docker stop`.
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/init-db.sh"]

# Default arguments to init-db.sh:
#   --persist-to=/data   keep Miniflare state on the mounted volume
#   --ip=0.0.0.0         listen on all interfaces so the host can reach us
#   --port=8787          match EXPOSE and the worker's documented dev port
CMD ["./node_modules/.bin/wrangler", "dev", \
     "--persist-to=/data", \
     "--ip=0.0.0.0", \
     "--port=8787"]