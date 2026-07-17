# Ship Log Search — Vessel Setup Guide

> For OpenClaw instances on navigation computers, laptops, and vessel devices.
> Read this. Run the commands. You'll have a working logbook in 10 minutes.

---

## What This Is

A semantic + spatial + timeline search engine for ship logs. Built for commercial fishing vessels. Runs on Cloudflare's free tier — costs $0.

**Three search modes:**
- **Semantic** — "good salmon catch" finds entries about sockeye sets, even if those exact words aren't used
- **Nearby** — "what happened within 50km of Cape Edgecumbe?"
- **Timeline** — "show me all maintenance logs from July"

Every entry stores: text, category, GPS coordinates, location name, timestamp. Searchable instantly. Editable. Deletable.

---

## Architecture (How It Works)

```
Vessel (laptop/phone)                    Cloudflare Edge (free tier)
┌─────────────────┐                      ┌──────────────────────────┐
│  Browser        │                      │  Cloudflare Worker       │
│  (the UI)       │◄────── HTTPS ──────► │  (ship-log-search)       │
│                 │                      │                          │
│  Offline:       │                      │  ┌────────────────────┐  │
│  forms queue    │                      │  │ D1 SQLite          │  │
│  in localStorage│                      │  │ (source of truth)  │  │
│  sync when      │                      │  │ logs table         │  │
│  online         │                      │  └────────────────────┘  │
└─────────────────┘                      │                          │
                                         │  ┌────────────────────┐  │
                                         │  │ Vectorize          │  │
                                         │  │ (semantic index)   │  │
                                         │  │ 384-dim cosine     │  │
                                         │  └────────────────────┘  │
                                         │                          │
                                         │  ┌────────────────────┐  │
                                         │  │ Workers AI         │  │
                                         │  │ bge-small-en-v1.5  │  │
                                         │  │ (embedding model)  │  │
                                         │  └────────────────────┘  │
                                         └──────────────────────────┘
```

**Data flow on write:**
1. Browser sends `POST /api/log` with `{text, category, lat, lon, location_name}`
2. Worker validates auth (`X-Log-Key` header)
3. Worker embeds text via Workers AI (`bge-small-en-v1.5`, 384 dimensions)
4. Full record → D1 SQLite (immediately consistent, source of truth)
5. Vector + metadata → Vectorize (eventually consistent, search index)

**Data flow on search:**
1. Semantic: Worker embeds query → Vectorize finds similar → D1 joins full records
2. Nearby: D1 bounding-box SQL query → haversine refinement
3. Timeline: D1 range query with `ORDER BY timestamp DESC`

**Why two stores?** D1 is a real database — SQL queries, immediate consistency, edit/delete, no row limits. Vectorize is a vector similarity engine — it finds semantically related entries. They're complementary. D1 is the source of truth; Vectorize can be rebuilt from D1 at any time.

---

## Setup: Spin Up Your Own Instance

### Prerequisites
- A Cloudflare account (free)
- Node.js 18+ and npm
- A terminal

### Step 1: Clone the repo

```bash
git clone https://github.com/SuperInstance/ship-log-search.git
cd ship-log-search
```

### Step 2: Install Wrangler

```bash
npm install
npx wrangler login    # opens browser to authenticate with Cloudflare
```

### Step 3: Create the D1 database

```bash
npx wrangler d1 create ship-log-db
```

Copy the `database_id` from the output. Edit `wrangler.toml` and paste it in:

```toml
[[d1_databases]]
binding = "DB"
database_name = "ship-log-db"
database_id = "<paste-your-id-here>"
```

### Step 4: Create the Vectorize index

```bash
npx wrangler vectorize create ship-log --dimensions 384 --metric cosine
```

### Step 5: Create the table

```bash
npx wrangler d1 execute ship-log-db --remote --command "
CREATE TABLE IF NOT EXISTS logs (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'observation',
  lat REAL,
  lon REAL,
  location_name TEXT,
  timestamp TEXT NOT NULL,
  metadata TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_logs_cat ON logs(category);
CREATE INDEX IF NOT EXISTS idx_logs_latlon ON logs(lat, lon);
"
```

### Step 6: Set a write key (required for logging entries)

```bash
# Generate a random key and set it as a secret
echo "boat-log-key-$(openssl rand -hex 8)" | npx wrangler secret put LOG_KEY
```

**Save this key** — you'll need it to log entries. The UI will prompt for it on first write.

### Step 7: Deploy

```bash
npx wrangler deploy
```

Your instance is now live at `https://ship-log-search.<your-account>.workers.dev/`

### Step 8: Seed initial data (optional)

```bash
npx wrangler d1 execute ship-log-db --remote --command "
INSERT INTO logs (id, text, category, lat, lon, location_name, timestamp, metadata) VALUES
('log-001', 'First set of the season. 400 fath on the slack. 250 lbs sockeye.', 'catch', 56.80, -135.50, 'Cape Edgecumbe', '2026-07-10T14:30:00Z', '{}'),
('log-002', 'Hydraulic winch service. Replaced seal on port drum.', 'maintenance', 57.05, -135.33, 'Sitka Harbor', '2026-07-11T09:00:00Z', '{}');
"
```

For the new entries to be searchable via semantic search, also insert them into Vectorize:

```bash
# Use the API to log each entry (this writes to both D1 and Vectorize)
KEY="<your-log-key from step 6>"
URL="https://ship-log-search.<your-account>.workers.dev"

curl -X POST "$URL/api/ingest" \
  -H "Content-Type: application/json" \
  -H "X-Log-Key: $KEY" \
  -d '{"documents":[{"id":"seed-001","text":"First set of the season. 400 fath on the slack. 250 lbs sockeye.","category":"catch","metadata":{"lat":56.8,"lon":-135.5,"location_name":"Cape Edgecumbe","timestamp":"2026-07-10T14:30:00Z"}}]}'
```

---

## Using the App

### From a browser (phone/tablet/laptop)

1. Open your Worker URL in any browser
2. To log an entry: tap **Log Entry** tab → type what happened → pick category → optionally add GPS
3. First write prompts for the write key (saved in localStorage after)
4. To search: **Semantic** tab, type natural language
5. To find nearby entries: **Nearby** tab → "Use my position" (browser geolocation) or enter coords
6. To browse by date: **Timeline** tab → pick date range

### From the API (for automation/echogram feeds)

```bash
# Log an entry
curl -X POST https://ship-log-search.YOUR-ACCOUNT.workers.dev/api/log \
  -H "Content-Type: application/json" \
  -H "X-Log-Key: YOUR-KEY" \
  -d '{"text":"500 lbs on the morning slack","category":"catch","lat":56.8,"lon":-135.5,"location_name":"Cape Edgecumbe"}'

# Search
curl "https://ship-log-search.YOUR-ACCOUNT.workers.dev/api/search?q=salmon+catch&k=10"

# Timeline
curl "https://ship-log-search.YOUR-ACCOUNT.workers.dev/api/timeline?from=2026-07-01&to=2026-07-31"

# Nearby
curl "https://ship-log-search.YOUR-ACCOUNT.workers.dev/api/nearby?lat=56.8&lon=-135.5&radius=30"

# Stats
curl "https://ship-log-search.YOUR-ACCOUNT.workers.dev/api/stats"

# Delete an entry
curl -X DELETE "https://ship-log-search.YOUR-ACCOUNT.workers.dev/api/log/log-001" \
  -H "X-Log-Key: YOUR-KEY"
```

---

## Vessel Deployment Patterns

### Pattern 1: Cloud-only (simplest)
The Worker runs on Cloudflare. The vessel browser connects directly. No local infrastructure.

**Best for:** Vessels with reliable satellite internet.

**Offline behavior:** The browser shows a cached page. Form submissions fail silently. No data is lost (form data persists in the input fields). When connectivity returns, submit again.

### Pattern 2: Local relay (recommended for boats)
Run a lightweight local proxy on the vessel's navigation computer:

```bash
# On the nav computer (Python, 30 lines)
python3 -m http.server 8080  # serves a simple redirect page
```

Or use Tailscale to connect directly to the Worker:

```bash
# Install Tailscale on the nav computer
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up

# The Worker is always reachable via its public URL
# Tailscale gives the nav computer a private IP for SSH/admin
```

### Pattern 3: Edge sync (advanced)
Run a local SQLite database on the nav computer that syncs to D1 when online:

```bash
# On the nav computer
sqlite3 /var/lib/shiplog/local.db < schema.sql
# Entries written locally, synced to Cloudflare D1 via API when connection is available
```

This requires a sync script — not included yet. Roadmap item.

---

## For OpenClaw Agents: Quick Setup Checklist

If you're an OpenClaw agent on a vessel and need to set this up for your operator:

```bash
# 1. Check if ship-log-search is already deployed
curl -s https://YOUR-WORKER-URL/health

# If not deployed, run the 8-step setup above.

# 2. Verify D1 is working
curl -s https://YOUR-WORKER-URL/api/stats
# Should return JSON with entries count

# 3. Test a write
curl -X POST https://YOUR-WORKER-URL/api/log \
  -H "Content-Type: application/json" \
  -H "X-Log-Key: $LOG_KEY" \
  -d '{"text":"OpenClaw system check — all green","category":"observation"}'

# 4. Test search
curl -s "https://YOUR-WORKER-URL/api/search?q=system+check"

# 5. Tell the operator the URL and write key
# Store credentials in ~/.config/shiplog/config.toml
```

Store the deployment config:

```toml
# ~/.config/shiplog/config.toml
worker_url = "https://ship-log-search.<account>.workers.dev"
log_key = "<your-log-key>"
vessel_name = "<vessel name>"
home_port = "<home port>"
```

---

## Troubleshooting

**Semantic search returns 0 results for new entries**
Vectorize is eventually consistent. Wait 5-10 seconds after writing for the index to propagate. Timeline and Nearby queries work immediately (they use D1).

**"Unauthorized" on POST/DELETE**
The `X-Log-Key` header doesn't match the `LOG_KEY` secret set on the Worker. Re-set it: `npx wrangler secret put LOG_KEY`.

**Nearby returns nothing**
Check that entries have `lat` and `lon` values. Entries without coordinates are excluded from spatial queries.

**Vectorize dimension mismatch**
The embedding model `bge-small-en-v1.5` produces 384-dimensional vectors. The Vectorize index must be created with `--dimensions 384`. If you get dimension errors, delete and recreate the index.

**D1 rate limits (free tier)**
- 5M row reads/day
- 100K row writes/day
- For a single vessel logging every few minutes, you'll never hit this

---

## Free Tier Limits

| Resource | Free Tier Limit | Our Usage |
|----------|----------------|-----------|
| Workers requests | 100K/day | ~100-500/day per vessel |
| Workers AI | 10K neurons/day | ~100-500 embeds/day |
| Vectorize | 10M vectors/index | <10K entries per vessel |
| D1 reads | 5M rows/day | <1K/day |
| D1 writes | 100K rows/day | <100/day |
| D1 databases | 10 | 1 |

A single vessel will use <1% of every limit.

---

## File Structure

```
ship-log-search/
├── src/
│   └── index.js          # The entire Worker (backend + frontend)
├── new-ui.html           # Standalone HTML (for editing/testing the UI)
├── wrangler.toml         # Cloudflare config (bindings, D1, Vectorize)
├── package.json
└── README.md
```

The Worker is a single file. The HTML UI is embedded as a template string. Everything is in one deployable unit — no build step, no dependencies, no framework.

---

## Roadmap

- [ ] Offline sync (local SQLite → D1 when online)
- [ ] Map view (Leaflet + OpenStreetMap for Nearby results)
- [ ] Photo attachments (R2 storage for catch photos)
- [ ] Multi-vessel support (shared index with vessel_id field)
- [ ] Export to CSV/Excel (D1 query → file download)
- [ ] Automated echogram ingestion (Webhook → /api/ingest)
- [ ] Turnstile integration (CAPTCHA for public writes instead of shared key)

---

*Built for commercial fishermen. Edge-first. Wattage-constrained. The boat is the reference implementation.*
