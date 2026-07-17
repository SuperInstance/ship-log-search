# Ship Log Search

**Semantic + spatial + timeline search for vessel logs.** Every entry is time-stamped and location-stamped. Search by meaning, by proximity, or by date range.

Runs on Cloudflare Workers (free tier) or locally with `wrangler dev`.

## What it does

- **Semantic search** — "good chumming near Cape Edgecumbe" finds entries about successful baiting near that area, even if the exact words don't match
- **Spatial search** — "what happened within 50km of 56.6, -134.0?" returns entries sorted by distance
- **Timeline search** — "all maintenance logs from July 2026" returns time-ordered entries filtered by category
- **Quick log** — POST a single entry with text, category, lat/lon, and timestamp

## Entry categories

| Category | Example |
|----------|---------|
| `catch` | "32 sockeye, 600 fath on the slack, 45 min soak" |
| `maintenance` | "Port hydraulic ram weeping — topped off fluid, ordered seal kit" |
| `weather` | "NW 25 knots, 6-foot swell at the banks. Barometer dropping." |
| `observation` | "Humpbacks working the tide rip. Bait balls on the sounder at 25 fathoms." |
| `navigation` | "Anchored in Port Bazant. Good holding in mud. 60 feet." |

## Quickstart

```bash
# 1. Create the Vectorize index (one time)
npm run create-index

# 2. Deploy to Cloudflare
npm run deploy

# 3. Or run locally
npm run dev
```

## API

### POST /api/log — Quick log entry

```json
{
  "text": "Chummed 45 min on the slack. 32 sockeye, 12 pinks. 600 fath.",
  "category": "catch",
  "lat": 56.6043,
  "lon": -134.4120,
  "location_name": "Cape Edgecumbe"
}
```

### POST /api/ingest — Bulk import

```json
{
  "documents": [
    {
      "id": "log-001",
      "text": "Port engine overheating. Shut down, inspected raw water intake. Cleared debris.",
      "metadata": {
        "timestamp": "2026-07-15T14:30:00Z",
        "lat": 56.6043,
        "lon": -134.4120,
        "category": "maintenance",
        "location_name": "Cape Edgecumbe"
      }
    }
  ]
}
```

### GET /api/search — Semantic search

```
GET /api/search?q=hydraulic+failure&category=maintenance&from=2026-06-01T00:00:00Z&k=20
```

Params:
- `q` — search query (required)
- `category` — filter by category (catch, maintenance, weather, observation, navigation)
- `from` — ISO timestamp, entries after this
- `to` — ISO timestamp, entries before this
- `k` — max results (1-50, default 20)

### GET /api/nearby — Spatial search

```
GET /api/nearby?lat=56.6&lon=-134.0&radius=50&k=20
```

Returns entries within `radius` km of `lat, lon`, sorted by distance.

### GET /api/timeline — Time-ordered entries

```
GET /api/timeline?from=2026-07-01T00:00:00Z&to=2026-07-31T23:59:59Z&category=catch&k=50
```

Returns entries in the time range, most recent first.

### GET /api/stats — Index statistics

```json
{
  "entries": 1500,
  "model": "@cf/baai/bge-small-en-v1.5",
  "endpoints": ["/api/search", "/api/nearby", "/api/timeline", "/api/log", "/api/ingest"]
}
```

## Free tier limits

- 10M vectors (you'll never hit this with log entries)
- 100K requests/day
- Workers AI embedding: free

## Running on your laptop

```bash
# Install wrangler
npm install

# Run locally (connects to Cloudflare for AI + Vectorize)
npx wrangler dev

# Open http://localhost:8787
```

## Importing existing logs

If you have existing fishing logs (CSV, spreadsheet, paper notes), write a script to:

1. Parse each entry
2. Build the `text` field (concatenate description, conditions, catch info)
3. Add `timestamp`, `lat`, `lon`, `category` as metadata
4. POST to `/api/ingest` in batches of 100

Example Python script:

```python
import csv, requests, json

API = "https://your-ship-log.workers.dev/api/ingest"

docs = []
with open('fishing_logs.csv') as f:
    for row in csv.DictReader(f):
        text = f"{row['description']} | {row['catch_summary']} | {row['conditions']}"
        docs.append({
            "id": row['id'],
            "text": text,
            "metadata": {
                "timestamp": row['datetime'],
                "lat": float(row['latitude']),
                "lon": float(row['longitude']),
                "category": row.get('category', 'observation'),
                "location_name": row.get('location', ''),
            }
        })

# POST in batches of 100
for i in range(0, len(docs), 100):
    batch = docs[i:i+100]
    r = requests.post(API, json={"documents": batch})
    print(f"Batch {i//100}: {r.json()}")
```

## License

MIT
