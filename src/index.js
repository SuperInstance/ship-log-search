// ship-log-search v0.2.0 — D1 as system of record, Vectorize for semantic search
// Fixes: P0 #1 (topK cap), #2 (text storage), #3 (D1 migration), #5 (XSS), #6 (error leak)
// Architecture: D1 = source of truth, Vectorize = semantic similarity only

const EMBED_MODEL = '@cf/baai/bge-small-en-v1.5';
const VALID_CATEGORIES = ['catch', 'maintenance', 'weather', 'observation', 'navigation'];
const SITKA_LAT = 57.053;
const SITKA_LON = -135.33;

export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });

		// Pages
		if (url.pathname === '/' && request.method === 'GET') return serveApp();
		if (url.pathname === '/health' && request.method === 'GET') return json({ ok: true, model: EMBED_MODEL, version: '0.2.0' });

		// Search endpoints
		if (url.pathname === '/api/search' && request.method === 'GET') return semanticSearch(url, env);
		if (url.pathname === '/api/nearby' && request.method === 'GET') return spatialSearch(url, env);
		if (url.pathname === '/api/timeline' && request.method === 'GET') return timelineSearch(url, env);

		// Data endpoints
		if (url.pathname === '/api/ingest' && request.method === 'POST') return handleIngest(request, env);
		if (url.pathname === '/api/log' && request.method === 'POST') return handleLog(request, env);
		if (url.pathname === '/api/log/' && request.method === 'DELETE') return handleDeleteAll(request, env);
		if (url.pathname === '/api/stats' && request.method === 'GET') return handleStats(env);

		// Delete single entry: /api/log/:id
		const logMatch = url.pathname.match(/^\/api\/log\/([^/]+)$/);
		if (logMatch && request.method === 'DELETE') return handleDelete(env, logMatch[1]);

		return new Response('Not Found', { status: 404, headers: corsHeaders() });
	},
};

// ─── Semantic Search (Vectorize + D1 join) ──────────────────────────────────

async function semanticSearch(url, env) {
	const q = (url.searchParams.get('q') || '').trim();
	if (!q) return json({ error: 'Missing "q" parameter.' }, 400);

	const topK = clampInt(url.searchParams.get('k'), 1, 50, 20);
	const category = url.searchParams.get('category');
	const startTime = url.searchParams.get('from');
	const endTime = url.searchParams.get('to');

	try {
		// Embed the query
		const embedOut = await env.AI.run(EMBED_MODEL, { text: [q] });
		const queryVector = Array.from(embedOut.data[0]);

		// Vectorize for semantic similarity — capped at 50
		const result = await env.VECTOR_INDEX.query(queryVector, {
			topK: Math.min(topK * 3, 50),
			returnMetadata: 'all',
		});

		// Get IDs from Vectorize results
		const ids = (result.matches || []).map(m => m.id);

		if (ids.length === 0) return json({ query: q, count: 0, results: [] });

		// Fetch full records from D1 (source of truth)
		const placeholders = ids.map(() => '?').join(',');
		let sql = `SELECT * FROM logs WHERE id IN (${placeholders})`;
		const params = [...ids];
		if (category) { sql += ` AND category = ?`; params.push(category); }
		if (startTime) { sql += ` AND timestamp >= ?`; params.push(startTime); }
		if (endTime) { sql += ` AND timestamp <= ?`; params.push(endTime); }

		const d1Result = await env.DB.prepare(sql).bind(...params).all();

		// Build a map for ordering by Vectorize score
		const scoreMap = new Map();
		for (const m of (result.matches || [])) scoreMap.set(m.id, m.score);

		// Join: D1 data + Vectorize score
		let matches = (d1Result.results || []).map(row => ({
			id: row.id,
			score: scoreMap.get(row.id) || 0,
			metadata: {
				timestamp: row.timestamp,
				lat: row.lat,
				lon: row.lon,
				category: row.category,
				text: row.text,
				location_name: row.location_name,
			},
		}));

		// Sort by score descending, slice to topK
		matches.sort((a, b) => b.score - a.score);
		matches = matches.slice(0, topK);

		return json({ query: q, count: matches.length, filters: { category, from: startTime, to: endTime }, results: matches });
	} catch (err) {
		console.error('semanticSearch error:', err);
		return json({ error: 'Search failed' }, 500);
	}
}

// ─── Spatial Search (D1 — no Vectorize needed) ──────────────────────────────

async function spatialSearch(url, env) {
	const lat = parseFloat(url.searchParams.get('lat') || String(SITKA_LAT));
	const lon = parseFloat(url.searchParams.get('lon') || String(SITKA_LON));
	const radiusKm = parseFloat(url.searchParams.get('radius') || '50');
	const topK = clampInt(url.searchParams.get('k'), 1, 200, 50);

	if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
		return json({ error: 'Need "lat" and "lon" parameters.' }, 400);
	}

	try {
		// Bounding box approximation (±radius degrees)
		const latDelta = radiusKm / 111.0;
		const lonDelta = radiusKm / (111.0 * Math.cos(lat * Math.PI / 180));

		const result = await env.DB.prepare(
			`SELECT * FROM logs
			 WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?
			 ORDER BY timestamp DESC LIMIT 500`
		).bind(
			lat - latDelta, lat + latDelta,
			lon - lonDelta, lon + lonDelta
		).all();

		// Refine with exact haversine
		let matches = (result.results || [])
			.map(row => {
				const dist = haversine(lat, lon, row.lat, row.lon);
				return dist <= radiusKm ? {
					id: row.id,
					distance_km: Math.round(dist * 10) / 10,
					metadata: {
						timestamp: row.timestamp,
						lat: row.lat, lon: row.lon,
						category: row.category,
						text: row.text,
						location_name: row.location_name,
					},
				} : null;
			})
			.filter(m => m !== null)
			.sort((a, b) => a.distance_km - b.distance_km)
			.slice(0, topK);

		return json({ origin: { lat, lon }, radius_km: radiusKm, count: matches.length, results: matches });
	} catch (err) {
		console.error('spatialSearch error:', err);
		return json({ error: 'Search failed' }, 500);
	}
}

// ─── Timeline Search (D1 — real SQL range queries) ──────────────────────────

async function timelineSearch(url, env) {
	const from = url.searchParams.get('from');
	const to = url.searchParams.get('to');
	const category = url.searchParams.get('category');
	const topK = clampInt(url.searchParams.get('k'), 1, 500, 100);

	try {
		let sql = `SELECT * FROM logs WHERE 1=1`;
		const params = [];
		if (from) { sql += ` AND timestamp >= ?`; params.push(from); }
		if (to) { sql += ` AND timestamp <= ?`; params.push(to); }
		if (category) { sql += ` AND category = ?`; params.push(category); }
		sql += ` ORDER BY timestamp DESC LIMIT ?`;
		params.push(topK);

		const result = await env.DB.prepare(sql).bind(...params).all();

		let matches = (result.results || []).map(row => ({
			id: row.id,
			metadata: {
				timestamp: row.timestamp,
				lat: row.lat, lon: row.lon,
				category: row.category,
				text: row.text,
				location_name: row.location_name,
			},
		}));

		return json({ from, to, category, count: matches.length, results: matches });
	} catch (err) {
		console.error('timelineSearch error:', err);
		return json({ error: 'Search failed' }, 500);
	}
}

// ─── Ingest (bulk — D1 + Vectorize) ─────────────────────────────────────────

async function handleIngest(request, env) {
	let body;
	try { body = await request.json(); } catch { return json({ error: 'Invalid JSON.' }, 400); }

	const docs = body?.documents;
	if (!Array.isArray(docs) || docs.length === 0) return json({ error: 'Need "documents" array.' }, 400);

	const cleaned = [];
	for (let i = 0; i < docs.length; i++) {
		const d = docs[i];
		if (!d?.id || !d?.text?.trim()) return json({ error: `documents[${i}] needs "id" and "text".` }, 400);
		const category = VALID_CATEGORIES.includes(d.category) ? d.category : (d.category || 'observation');
		cleaned.push({
			id: d.id,
			text: d.text,
			category,
			timestamp: d.timestamp || d.metadata?.timestamp || new Date().toISOString(),
			lat: d.lat ?? d.metadata?.lat ?? null,
			lon: d.lon ?? d.metadata?.lon ?? null,
			location_name: d.location_name ?? d.metadata?.location_name ?? null,
			metadata: d.metadata || {},
		});
	}

	try {
		// Embed all texts
		const out = await env.AI.run(EMBED_MODEL, { text: cleaned.map(d => [d.text, d.category, d.location_name].filter(Boolean).join(' | ')) });
		const vectors = out.data.map(v => Array.from(v));

		// Insert into D1 (source of truth)
		const stmt = env.DB.prepare(
			`INSERT OR REPLACE INTO logs (id, text, category, lat, lon, location_name, timestamp, metadata)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		);
		const batch = cleaned.map(d => stmt.bind(
			d.id, d.text.slice(0, 4000), d.category, d.lat, d.lon, d.location_name,
			d.timestamp, JSON.stringify(d.metadata)
		));
		await env.DB.batch(batch);

		// Insert into Vectorize (semantic index)
		const records = cleaned.map((d, i) => ({
			id: d.id,
			values: vectors[i],
			metadata: { timestamp: d.timestamp, category: d.category, lat: d.lat, lon: d.lon, text: d.text.slice(0, 500), location_name: d.location_name || '' },
		}));

		for (let i = 0; i < records.length; i += 100) {
			await env.VECTOR_INDEX.insert(records.slice(i, i + 100));
		}

		return json({ ingested: cleaned.length, model: EMBED_MODEL });
	} catch (err) {
		console.error('handleIngest error:', err);
		return json({ error: 'Ingest failed' }, 500);
	}
}

// ─── Quick Log (single entry — D1 + Vectorize) ──────────────────────────────

async function handleLog(request, env) {
	let body;
	try { body = await request.json(); } catch { return json({ error: 'Invalid JSON.' }, 400); }

	if (!body?.text?.trim()) return json({ error: 'Need "text" field.' }, 400);

	const id = body.id || `log-${Date.now()}`;
	const category = VALID_CATEGORIES.includes(body.category) ? body.category : 'observation';
	const timestamp = body.timestamp || new Date().toISOString();
	const lat = body.lat ?? null;
	const lon = body.lon ?? null;
	const location_name = body.location_name || null;
	const text = body.text.slice(0, 4000);

	// Build the text to embed (include context for better embeddings)
	const embedText = [text, category, location_name].filter(Boolean).join(' | ');

	try {
		// Embed
		const out = await env.AI.run(EMBED_MODEL, { text: [embedText] });
		const vec = Array.from(out.data[0]);

		// D1 insert (source of truth)
		await env.DB.prepare(
			`INSERT OR REPLACE INTO logs (id, text, category, lat, lon, location_name, timestamp, metadata)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		).bind(id, text, category, lat, lon, location_name, timestamp, JSON.stringify(body.metadata || {})).run();

		// Vectorize insert (semantic index)
		await env.VECTOR_INDEX.insert([{
			id,
			values: vec,
			metadata: { timestamp, category, lat, lon, text: text.slice(0, 500), location_name: location_name || '' },
		}]);

		return json({ logged: true, id, metadata: { timestamp, lat, lon, category, text, location_name } });
	} catch (err) {
		console.error('handleLog error:', err);
		return json({ error: 'Log failed' }, 500);
	}
}

// ─── Delete (single entry — D1 + Vectorize) ─────────────────────────────────

async function handleDelete(env, id) {
	try {
		await env.DB.prepare(`DELETE FROM logs WHERE id = ?`).bind(id).run();
		try { await env.VECTOR_INDEX.deleteByIds([id]); } catch {}
		return json({ deleted: true, id });
	} catch (err) {
		console.error('handleDelete error:', err);
		return json({ error: 'Delete failed' }, 500);
	}
}

async function handleDeleteAll(request, env) {
	return json({ error: 'Specify an id: DELETE /api/log/:id' }, 400);
}

// ─── Stats (D1 — real counts) ───────────────────────────────────────────────

async function handleStats(env) {
	try {
		const result = await env.DB.prepare(
			`SELECT
				COUNT(*) as total,
				COUNT(DISTINCT category) as categories,
				MIN(timestamp) as earliest,
				MAX(timestamp) as latest
			 FROM logs`
		).first();

		const catResult = await env.DB.prepare(
			`SELECT category, COUNT(*) as count FROM logs GROUP BY category ORDER BY count DESC`
		).all();

		return json({
			entries: result?.total || 0,
			categories: result?.categories || 0,
			earliest: result?.earliest || null,
			latest: result?.latest || null,
			byCategory: catResult.results || [],
			model: EMBED_MODEL,
			endpoints: ['/api/search', '/api/nearby', '/api/timeline', '/api/log', '/api/log/:id (DELETE)', '/api/ingest', '/api/stats'],
		});
	} catch (err) {
		console.error('handleStats error:', err);
		return json({ error: 'Stats failed' }, 500);
	}
}

// ─── Geo ────────────────────────────────────────────────────────────────────

function haversine(lat1, lon1, lat2, lon2) {
	const R = 6371;
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLon = ((lon2 - lon1) * Math.PI) / 180;
	const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
	return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Utils ──────────────────────────────────────────────────────────────────

function json(payload, status = 200) {
	return new Response(JSON.stringify(payload, null, 2), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders() },
	});
}

function corsHeaders() {
	return {
		'access-control-allow-origin': '*',
		'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
		'access-control-allow-headers': 'content-type',
	};
}

function clampInt(raw, lo, hi, fallback) {
	const n = parseInt(raw, 10);
	return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
}

// ─── HTML App (placeholder — Kimi K3 redesign pending) ──────────────────────

function serveApp() {
	return new Response(APP_HTML, {
		headers: { 'content-type': 'text/html; charset=utf-8' },
	});
}

// Will be replaced with Kimi K3 redesign
const APP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="dark">
<title>Ship Log · v0.2.0</title>
<style>
:root { --bg:#0a1118; --surface:#121b24; --surface2:#1a2530; --border:#243340; --text:#dce4ec; --dim:#7a8a98; --accent:#4ea1d3; --green:#4ade80; --amber:#fbbf24; --red:#f87171; --mono:ui-monospace,monospace; }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--text); font-family:-apple-system,sans-serif; font-size:14px; }
.container { max-width:900px; margin:0 auto; padding:16px; }
h1 { font-size:20px; }
.meta { color:var(--dim); font-size:13px; margin:4px 0 16px; }
.pill { background:var(--surface2); padding:4px 10px; border-radius:999px; font-size:12px; color:var(--dim); display:inline-block; margin:2px; }
</style>
</head>
<body>
<div class="container">
	<h1>Ship Log Search <span style="color:var(--accent)">v0.2.0</span></h1>
	<p class="meta">D1 backend upgraded. Frontend redesign in progress.</p>
	<p><a href="/api/stats" style="color:var(--accent)">Stats</a> · <a href="/api/timeline?k=10" style="color:var(--accent)">Recent</a> · <a href="/api/search?q=catch&k=5" style="color:var(--accent)">Test Search</a></p>
	<p class="meta">Endpoints:<br>
		<span class="pill">GET /api/search?q=</span>
		<span class="pill">GET /api/nearby?lat=&lon=</span>
		<span class="pill">GET /api/timeline?from=&to=</span>
		<span class="pill">POST /api/log</span>
		<span class="pill">DELETE /api/log/:id</span>
		<span class="pill">GET /api/stats</span>
	</p>
</div>
</body>
</html>`;
