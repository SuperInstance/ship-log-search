# Ship Log Search — Self-Host Setup

Run the full **ship-log-search** stack on a vessel navigation computer with a
single command. Your fishing logs stay on the boat's disk (persisted D1
SQLite); semantic search uses Cloudflare's free Workers AI + Vectorize tier.

```
┌─────────────────────────────────────────────────────────────┐
│  Nav computer (boat)                                        │
│                                                             │
│   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐   │
│   │  ship-log-   │   │  signalk     │   │   phone /    │   │
│   │  search      │   │  (optional)  │   │   tablet     │   │
│   │  :8787       │   │  :3000       │   │   browser    │   │
│   │              │   │              │   │              │   │
│   │  wrangler    │   │  NMEA 2000   │   └──────┬───────┘   │
│   │  dev (D1 +   │   │  GPS, depth, │          │           │
│   │  remote AI)  │   │  wind, etc.  │          │           │
│   └──────┬───────┘   └──────────────┘          │           │
│          │                                     │           │
│          ▼                                     ▼           │
│   ┌──────────────┐                    ┌──────────────┐     │
│   │ ship-log-    │                    │  http://     │     │
│   │ data volume  │                    │  nav-host:   │     │
│   │ (D1 SQLite)  │                    │  8787        │     │
│   └──────────────┘                    └──────────────┘     │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Prerequisites

A nav computer (laptop, mini-PC, Raspberry Pi 4+, or boat PC) running:

1. **Docker Engine 20.10+** and **Docker Compose v2**.
   - Linux: install via your package manager or [docker.com](https://docs.docker.com/engine/install/).
   - macOS / Windows: [Docker Desktop](https://www.docker.com/products/docker-desktop/).
   - Verify: `docker --version && docker compose version`.

2. **Outbound HTTPS to `api.cloudflare.com`** for the Workers AI and Vectorize
   API calls (semantic search). Spatial (`/api/nearby`) and timeline
   (`/api/timeline`) queries work fully offline — only the semantic and
   embedding endpoints need internet.

3. **A free Cloudflare account** with a Vectorize index already created
   (one-time setup, ~30 seconds):
   - Account ID: visible at <https://dash.cloudflare.com/?to=/:account/workers/ai>.
   - API token: create at <https://dash.cloudflare.com/profile/api-tokens>
     with **Workers AI: Read** and **Vectorize: Edit** scopes.
   - Create the index once from any laptop:
     ```bash
     npm install -g wrangler
     wrangler login
     wrangler vectorize create ship-log --dimensions 384 --metric cosine
     ```

---

## One-command start

```bash
cd self-host/
cp .env.example .env          # then edit .env (see below)
docker compose up -d
docker compose logs -f worker # optional: watch startup
```

Wait for the log line `Ready on http://0.0.0.0:8787`, then open the UI:

| Where                | URL                                |
|----------------------|------------------------------------|
| Same machine         | <http://localhost:8787>            |
| Phone on boat Wi-Fi  | <http://nav-computer:8787>         |
| Any browser on LAN   | <http://nav-computer.lan:8787>     |

The first request triggers Workers AI to warm up — expect ~1 s of latency
on the first semantic search, then it's fast.

### Required `.env` settings

```bash
# Cloudflare account ID (looks like a 32-char hex string)
CLOUDFLARE_ACCOUNT_ID=abc123...

# Cloudflare API token with Workers AI:Read + Vectorize:Edit scopes
CLOUDFLARE_API_TOKEN=your-token

# Write key — anyone with this can POST log entries.
# Generate a fresh one: openssl rand -hex 16
LOG_KEY=change-me-to-something-long-and-random

# Optional overrides
WORKER_PORT=8787
PUBLIC_URL=http://nav-computer:8787
```

If `CLOUDFLARE_API_TOKEN` is missing the worker still starts, but
`/api/search` returns 500 (D1-backed endpoints like `/api/nearby`,
`/api/timeline`, and `/api/stats` continue to work fine).

---

## How to access the UI

1. From the nav computer itself: <http://localhost:8787>
2. From a phone or tablet on the boat's Wi-Fi: replace `localhost` with the
   nav computer's hostname or LAN IP (e.g. <http://nav-pc.local:8787> or
   <http://192.168.1.50:8787>). Find your IP with `hostname -I` or
   `ip addr`.
3. The browser prompts for the **log key** the first time you save an
   entry. The key is saved in `localStorage` after that, so it won't ask
   again on the same device.

The UI has four tabs:

| Tab         | Backing endpoint        | Offline?            |
|-------------|-------------------------|---------------------|
| Semantic    | `/api/search`           | No (needs AI)       |
| Spatial     | `/api/nearby`           | **Yes** (pure D1)   |
| Timeline    | `/api/timeline`         | **Yes** (pure D1)   |
| Quick log   | `/api/log` (POST)       | Needs AI for vector |

---

## Configuring a Signal K connection

Signal K is the open marine data bus used by chart plotters, AIS receivers,
NMEA 2000 gateways, and most modern boat electronics. Adding it to the
stack lets future log entries (and Signal K plugins) read live GPS, depth,
wind, and course data.

Start it with the optional profile:

```bash
docker compose --profile with-signalk up -d
```

Then:

1. Open <http://localhost:3000> and complete the first-run wizard
   (admin password, vessel name, mmsi).
2. Connect your NMEA 2000 gateway / AIS / GPS source. Signal K auto-detects
   most TCP (`10110`) and serial (`/dev/ttyUSB0`) inputs.
3. Verify data is flowing: the Signal K dashboard should show live
   `navigation.position`, `navigation.speedOverGround`, etc.

From inside the `shipnet` Docker network the worker can reach Signal K at
the hostname `signalk` on port `3000`:

```text
http://signalk:3000/signalk/v1/api/
```

> **Note:** the worker itself does not currently ingest from Signal K
> automatically — that's a future feature. For now, log entries can be
> created with manual lat/lon or browser geolocation, and Signal K runs as
> a peer service you can integrate with later.

---

## Persisting data across reboots

All durable state lives in the named volume **`ship-log-data`**:

| File (under the volume)                | What it stores          |
|----------------------------------------|-------------------------|
| `.wrangler/state/v3/d1/.../*.sqlite`   | D1 logs table           |
| `.wrangler/state/v3/vectorize/...`     | Local Vectorize cache   |

The volume is created the first time you `up` the stack and survives:

- `docker compose restart`
- `docker compose down` (then `up` again)
- Reboots of the nav computer
- Even `docker compose stop && docker compose start`

### Backups

To back up the entire database to a single file you can copy off the boat:

```bash
docker compose exec worker tar czf - -C /data . > ship-log-backup-$(date +%F).tar.gz
```

Restore:

```bash
docker compose down
docker volume rm ship-log-data
docker volume create ship-log-data
docker compose run --rm worker tar xzf - -C /data < ship-log-backup-2026-07-18.tar.gz
docker compose up -d
```

### Wiping and starting over

```bash
docker compose down -v        # ⚠️ deletes ship-log-data and signalk-data
docker compose up -d
```

---

## Updating to the latest version

```bash
cd /path/to/ship-log-search
git pull
docker compose --profile with-signalk build --pull worker
docker compose up -d
```

The image is rebuilt with the latest source, dependencies, and migration
files. The named volume is preserved, so your data survives the upgrade.

New schema changes will be picked up by `init-db.sh` automatically on the
next start (migrations are idempotent).

---

## Troubleshooting

### `wrangler: not found` in the container

The image's `npm ci` step should have installed `wrangler`. If you mounted
a custom `node_modules` over the image's, the binary disappears. Either:

```bash
docker compose down
docker volume ls         # check for a stray node_modules volume
docker compose up -d --build
```

### `401 Unauthorized` on POST `/api/log`

Your `LOG_KEY` in `.env` doesn't match the header `X-Log-Key`. Either set a
new key in `.env` or clear it (`LOG_KEY=`) to run in open-write dev mode.

### `/api/search` returns 500 "Workers AI error"

`CLOUDFLARE_API_TOKEN` is missing or doesn't have the right scopes. Verify
the token at <https://dash.cloudflare.com/profile/api-tokens>; it needs
**Workers AI: Read** and **Vectorize: Edit**.

To test semantic search without internet, fall back to `/api/nearby` or
`/api/timeline` — both work fully offline.

### Vectorize index not found

You must create the Vectorize index once per Cloudflare account:

```bash
wrangler vectorize create ship-log --dimensions 384 --metric cosine
```

This is a one-time setup. The container does not create it automatically
because Vectorize is a free-tier Cloudflare resource, not a local service.

### "Address already in use" on port 8787

Something on the nav computer is using that port (commonly the Signal K
server if you installed it natively). Either:

- Change `WORKER_PORT=8788` in `.env` and reload, **or**
- Stop the conflicting service.

### Logs look hung at "Compiling worker..."

The first `wrangler dev` start downloads the workerd binary and builds
the worker bundle. Allow 30–60 seconds on a Raspberry Pi. Subsequent
restarts are fast (~2 s).

### Schema is missing — search returns SQL errors

The init script should have created `logs` automatically. To re-run it
manually:

```bash
docker compose exec worker wrangler d1 execute ship-log-db \
  --local --persist-to=/data \
  --file=/app/migrations/0001_init.sql --yes
```

### Persistent volume fills up the disk

D1 SQLite grows slowly — about 2 KB per entry with a typical log. 10,000
entries ≈ 20 MB. If disk is critical, add a periodic VACUUM:

```bash
docker compose exec worker sqlite3 \
  /data/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite \
  "VACUUM;"
```

(`sqlite3` is not bundled in the image — install it on the host and run
against the bind-mounted volume, or extend the Dockerfile.)

### Healthcheck failing but logs look fine

The first healthcheck fires after `start_period=90s`. If you see
`unhealthy` and the worker has clearly started, the issue is usually the
container can't reach `127.0.0.1:8787` itself (some custom networks
interfere). Verify with:

```bash
docker compose exec worker wget -qO- http://127.0.0.1:8787/health
```

---

## Files in this directory

| File                  | Purpose                                              |
|-----------------------|------------------------------------------------------|
| `docker-compose.yml`  | The full stack (worker + optional Signal K)          |
| `Dockerfile`          | Worker image (Node 22, runs wrangler dev)            |
| `init-db.sh`          | Applies migrations to local D1 on every container start |
| `migrations/`         | SQL files applied in alphabetical order              |
| `migrations/0001_init.sql` | Initial `logs` table + indexes                  |
| `.env.example`        | Template for required environment variables          |

---

## Architecture notes

- **Worker source** (`src/index.js`) is **unchanged**. The image runs
  `wrangler dev` locally with the same bindings declared in `wrangler.toml`.
- **D1** is emulated by Miniflare and stored under the `ship-log-data`
  volume. No code changes needed.
- **Workers AI** (`env.AI.run`) and **Vectorize** (`env.VECTOR_INDEX`) are
  not emulated locally — the worker calls Cloudflare's free tier using
  `CLOUDFLARE_API_TOKEN`. This keeps the on-boat stack small (no ~30 MB
  embedding model to download) and stays within Cloudflare's generous free
  limits (100K Workers AI requests/day, 10M vector rows).
- **Spatial + Timeline queries** (D1-only) work fully offline. These are
  the queries you reach for most often at sea when you have no
  connectivity.

For a fully offline stack (local embedding model + local vector index),
see the [Roadmap](#roadmap) section.

---

## Roadmap

- **Local embedding fallback** — bundle `@xenova/transformers` and a
  local vector store as a sidecar container that mirrors the Cloudflare
  API surface, so the whole stack runs with no internet.
- **Signal K ingest plugin** — auto-fill `lat`/`lon`/`timestamp` from
  Signal K's `navigation.*` stream when creating a log entry.
- **HTTPS via Traefik or Caddy** — terminate TLS on a known port so
  browsers trust the cert when accessing from phones.

PRs welcome.