// ship-log-search — Semantic + spatial search for ship logs
// Time/location-stamped records: catches, maintenance, weather, observations
// Deploy on Cloudflare Workers (free tier) or run locally with `wrangler dev`

const EMBED_MODEL = '@cf/baai/bge-small-en-v1.5';

export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		if (request.method === 'OPTIONS') {
			return new Response(null, { headers: corsHeaders() });
		}

		// ── Pages ──
		if (url.pathname === '/' && request.method === 'GET') return serveApp();
		if (url.pathname === '/health' && request.method === 'GET') return json({ ok: true, model: EMBED_MODEL });

		// ── Search endpoints ──
		if (url.pathname === '/api/search' && request.method === 'GET') return semanticSearch(url, env);
		if (url.pathname === '/api/spatial' && url.pathname === '/api/nearby' && request.method === 'GET') return spatialSearch(url, env);
		if (url.pathname === '/api/nearby' && request.method === 'GET') return spatialSearch(url, env);
		if (url.pathname === '/api/timeline' && request.method === 'GET') return timelineSearch(url, env);

		// ── Data endpoints ──
		if (url.pathname === '/api/ingest' && request.method === 'POST') return handleIngest(request, env);
		if (url.pathname === '/api/log' && request.method === 'POST') return handleLog(request, env);
		if (url.pathname === '/api/stats' && request.method === 'GET') return handleStats(env);

		return new Response('Not Found', { status: 404, headers: corsHeaders() });
	},
};

// ─── HTML App ─────────────────────────────────────────────────────────────────

function serveApp() {
	return new Response(APP_HTML, {
		headers: { 'content-type': 'text/html; charset=utf-8' },
	});
}

// ─── Semantic Search ──────────────────────────────────────────────────────────

async function semanticSearch(url, env) {
	const q = (url.searchParams.get('q') || '').trim();
	if (!q) return json({ error: 'Missing "q" parameter.' }, 400);

	const topK = clampInt(url.searchParams.get('k'), 1, 50, 20);
	const category = url.searchParams.get('category'); // catch, maintenance, weather, observation, navigation
	const startTime = url.searchParams.get('from'); // ISO timestamp
	const endTime = url.searchParams.get('to');

	try {
		const embedOut = await env.AI.run(EMBED_MODEL, { text: [q] });
		const queryVector = Array.from(embedOut.data[0]);

		const opts = { topK: topK * 3, returnMetadata: 'all' }; // over-fetch for filtering
		const result = await env.VECTOR_INDEX.query(queryVector, opts);

		let matches = (result.matches || []).map((m) => ({
			id: m.id,
			score: m.score,
			metadata: m.metadata || {},
		}));

		// Apply filters
		matches = filterByCategory(matches, category);
		matches = filterByTimeRange(matches, startTime, endTime);

		matches = matches.slice(0, topK);

		return json({
			query: q,
			count: matches.length,
			filters: { category, from: startTime, to: endTime },
			results: matches,
		});
	} catch (err) {
		return json({ error: err.message || String(err) }, 500);
	}
}

// ─── Spatial Search (nearby entries) ──────────────────────────────────────────

async function spatialSearch(url, env) {
	const lat = parseFloat(url.searchParams.get('lat'));
	const lon = parseFloat(url.searchParams.get('lon'));
	const radiusKm = parseFloat(url.searchParams.get('radius') || '50');
	const topK = clampInt(url.searchParams.get('k'), 1, 50, 20);

	if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
		return json({ error: 'Need "lat" and "lon" parameters.' }, 400);
	}

	try {
		// Vectorize doesn't support spatial queries natively.
		// Strategy: query with a dummy vector, get a large batch, filter by distance.
		// For production, replace with a dedicated spatial index (D1 + SQL, or external).
		const dummyVec = new Array(384).fill(0.01);
		const result = await env.VECTOR_INDEX.query(dummyVec, {
			topK: 50,
			returnMetadata: 'all',
		});

		let matches = (result.matches || [])
			.map((m) => {
				const meta = m.metadata || {};
				const entryLat = parseFloat(meta.lat);
				const entryLon = parseFloat(meta.lon);
				if (!Number.isFinite(entryLat) || !Number.isFinite(entryLon)) return null;
				const dist = haversine(lat, lon, entryLat, entryLon);
				return { id: m.id, distance_km: dist, metadata: meta };
			})
			.filter((m) => m !== null && m.distance_km <= radiusKm)
			.sort((a, b) => a.distance_km - b.distance_km)
			.slice(0, topK);

		return json({
			origin: { lat, lon },
			radius_km: radiusKm,
			count: matches.length,
			results: matches,
		});
	} catch (err) {
		return json({ error: err.message || String(err) }, 500);
	}
}

// ─── Timeline Search (time-ordered entries) ───────────────────────────────────

async function timelineSearch(url, env) {
	const from = url.searchParams.get('from'); // ISO timestamp
	const to = url.searchParams.get('to');
	const category = url.searchParams.get('category');
	const topK = clampInt(url.searchParams.get('k'), 1, 100, 50);

	try {
		// Fetch a broad set and filter by time
		const dummyVec = new Array(384).fill(0.01);
		const result = await env.VECTOR_INDEX.query(dummyVec, {
			topK: 50,
			returnMetadata: 'all',
		});

		let matches = (result.matches || [])
			.map((m) => ({ id: m.id, metadata: m.metadata || {} }))
			.filter((m) => {
				const ts = m.metadata.timestamp;
				if (!ts) return false;
				if (from && ts < from) return false;
				if (to && ts > to) return false;
				return true;
			});

		matches = filterByCategory(matches, category);

		// Sort by timestamp descending (most recent first)
		matches.sort((a, b) => {
			const ta = a.metadata.timestamp || '';
			const tb = b.metadata.timestamp || '';
			return tb.localeCompare(ta);
		});

		matches = matches.slice(0, topK);

		return json({
			from,
			to,
			category,
			count: matches.length,
			results: matches,
		});
	} catch (err) {
		return json({ error: err.message || String(err) }, 500);
	}
}

// ─── Ingest (bulk) ────────────────────────────────────────────────────────────

async function handleIngest(request, env) {
	let body;
	try { body = await request.json(); } catch { return json({ error: 'Invalid JSON.' }, 400); }

	const docs = body?.documents;
	if (!Array.isArray(docs) || docs.length === 0) return json({ error: 'Need "documents" array.' }, 400);

	const cleaned = [];
	for (let i = 0; i < docs.length; i++) {
		const d = docs[i];
		if (!d?.id || !d?.text?.trim()) return json({ error: `documents[${i}] needs "id" and "text".` }, 400);
		const meta = { ...d.metadata };
		// Ensure timestamp exists for timeline queries
		if (!meta.timestamp) meta.timestamp = new Date().toISOString();
		cleaned.push({ id: d.id, text: d.text, metadata: meta });
	}

	try {
		const out = await env.AI.run(EMBED_MODEL, { text: cleaned.map((d) => d.text) });
		const vectors = out.data.map((v) => Array.from(v));

		const records = cleaned.map((d, i) => ({ id: d.id, values: vectors[i], metadata: d.metadata }));

		let inserted = 0;
		for (let i = 0; i < records.length; i += 100) {
			await env.VECTOR_INDEX.insert(records.slice(i, i + 100));
			inserted += Math.min(100, records.length - i);
		}

		return json({ ingested: inserted, model: EMBED_MODEL });
	} catch (err) {
		return json({ error: err.message || String(err) }, 500);
	}
}

// ─── Quick Log (single entry, convenience) ────────────────────────────────────

async function handleLog(request, env) {
	let body;
	try { body = await request.json(); } catch { return json({ error: 'Invalid JSON.' }, 400); }

	if (!body?.text?.trim()) return json({ error: 'Need "text" field.' }, 400);

	const id = body.id || `log-${Date.now()}`;
	const meta = {
		timestamp: body.timestamp || new Date().toISOString(),
		lat: body.lat ?? null,
		lon: body.lon ?? null,
		category: body.category || 'observation',
		...body.metadata,
	};

	// Build the text to embed (include context for better embeddings)
	const embedText = [body.text, meta.category, body.location_name].filter(Boolean).join(' | ');

	try {
		const out = await env.AI.run(EMBED_MODEL, { text: [embedText] });
		const vec = Array.from(out.data[0]);

		await env.VECTOR_INDEX.insert([{ id, values: vec, metadata: meta }]);

		return json({ logged: true, id, metadata: meta });
	} catch (err) {
		return json({ error: err.message || String(err) }, 500);
	}
}

// ─── Stats ────────────────────────────────────────────────────────────────────

async function handleStats(env) {
	try {
		const dummyVec = new Array(384).fill(0.01);
		const result = await env.VECTOR_INDEX.query(dummyVec, { topK: 1, returnMetadata: 'all' });
		return json({
			entries: result.count || 0,
			model: EMBED_MODEL,
			endpoints: ['/api/search', '/api/nearby', '/api/timeline', '/api/log', '/api/ingest'],
		});
	} catch (err) {
		return json({ error: err.message }, 500);
	}
}

// ─── Filters ──────────────────────────────────────────────────────────────────

function filterByCategory(matches, category) {
	if (!category) return matches;
	return matches.filter((m) => (m.metadata?.category || '').toLowerCase() === category.toLowerCase());
}

function filterByTimeRange(matches, startTime, endTime) {
	if (!startTime && !endTime) return matches;
	return matches.filter((m) => {
		const ts = m.metadata?.timestamp;
		if (!ts) return false;
		if (startTime && ts < startTime) return false;
		if (endTime && ts > endTime) return false;
		return true;
	});
}

// ─── Geo ──────────────────────────────────────────────────────────────────────

function haversine(lat1, lon1, lat2, lon2) {
	const R = 6371; // Earth radius km
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLon = ((lon2 - lon1) * Math.PI) / 180;
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
	return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Utils ────────────────────────────────────────────────────────────────────

function json(payload, status = 200) {
	return new Response(JSON.stringify(payload, null, 2), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders() },
	});
}

function corsHeaders() {
	return {
		'access-control-allow-origin': '*',
		'access-control-allow-methods': 'GET, POST, OPTIONS',
		'access-control-allow-headers': 'content-type',
	};
}

function clampInt(raw, lo, hi, fallback) {
	const n = parseInt(raw, 10);
	return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
}

// ─── HTML App (Map + Search + Timeline) ───────────────────────────────────────

const APP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="dark">
<title>Ship Log · Semantic Search</title>
<style>
:root {
	--bg: #0a1118; --surface: #121b24; --surface2: #1a2530;
	--border: #243340; --text: #dce4ec; --dim: #7a8a98;
	--accent: #4ea1d3; --accent-glow: rgba(78,161,211,0.15);
	--green: #4ade80; --amber: #fbbf24; --red: #f87171;
	--mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
	--sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font-family: var(--sans); font-size: 14px; }
.app { display: grid; grid-template-columns: 1fr; max-width: 1100px; margin: 0 auto; padding: 16px; gap: 16px; }
@media (min-width: 800px) { .app { grid-template-columns: 1fr 1fr; } }
header { grid-column: 1 / -1; text-align: center; padding: 20px 0; }
header h1 { margin: 0; font-size: 22px; font-weight: 600; }
header h1 .accent { color: var(--accent); }
header p { margin: 4px 0 0; color: var(--dim); font-size: 13px; }
.panel { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
.panel h2 { margin: 0 0 12px; font-size: 14px; color: var(--dim); text-transform: uppercase; letter-spacing: 0.05em; }
.search-box { display: flex; gap: 8px; }
.search-box input { flex: 1; background: var(--surface2); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; color: var(--text); font-size: 14px; outline: none; }
.search-box input:focus { border-color: var(--accent); }
.search-box button, .btn { background: var(--accent); color: #0a1118; border: 0; border-radius: 8px; padding: 10px 16px; font-weight: 600; cursor: pointer; font-size: 13px; }
.btn-sm { background: var(--surface2); color: var(--dim); border: 1px solid var(--border); padding: 4px 10px; font-size: 12px; border-radius: 999px; cursor: pointer; }
.btn-sm:hover { border-color: var(--accent); color: var(--accent); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.results { margin-top: 12px; display: flex; flex-direction: column; gap: 8px; }
.entry { background: var(--surface2); border: 1px solid var(--border); border-radius: 8px; padding: 12px; }
.entry .meta { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; }
.entry .cat { font-family: var(--mono); font-size: 11px; padding: 2px 8px; border-radius: 999px; }
.cat-catch { background: rgba(74,222,128,0.15); color: var(--green); }
.cat-maintenance { background: rgba(251,191,36,0.15); color: var(--amber); }
.cat-weather { background: rgba(78,161,211,0.15); color: var(--accent); }
.cat-observation { background: rgba(122,138,152,0.15); color: var(--dim); }
.cat-navigation { background: rgba(168,85,247,0.15); color: #c084fc; }
.entry .time { font-family: var(--mono); font-size: 12px; color: var(--dim); }
.entry .coords { font-family: var(--mono); font-size: 11px; color: var(--dim); }
.entry .text { margin-top: 6px; }
.entry .score { font-family: var(--mono); font-size: 11px; color: var(--dim); float: right; }
.tab-bar { display: flex; gap: 4px; margin-bottom: 12px; }
.tab { padding: 6px 14px; border-radius: 8px 8px 0 0; cursor: pointer; font-size: 13px; color: var(--dim); border-bottom: 2px solid transparent; }
.tab.active { color: var(--accent); border-bottom-color: var(--accent); }
.hidden { display: none; }
input.coords-input { width: 80px; background: var(--surface2); border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; color: var(--text); font-size: 13px; }
label { font-size: 12px; color: var(--dim); }
.log-form { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.log-form input, .log-form textarea, .log-form select { background: var(--surface2); border: 1px solid var(--border); border-radius: 6px; padding: 8px; color: var(--text); font-size: 13px; }
.log-form .full { grid-column: 1 / -1; }
.log-form textarea { min-height: 60px; resize: vertical; }
</style>
</head>
<body>
<div class="app">
	<header>
		<h1>Ship Log <span class="accent">Search</span></h1>
		<p>Semantic · spatial · timeline search over your vessel's history</p>
	</header>

	<!-- Search Panel -->
	<div class="panel" style="grid-column: 1 / -1;">
		<div class="tab-bar">
			<div class="tab active" data-tab="semantic" onclick="switchTab('semantic')">🔍 Semantic</div>
			<div class="tab" data-tab="spatial" onclick="switchTab('spatial')">📍 Nearby</div>
			<div class="tab" data-tab="timeline" onclick="switchTab('timeline')">📅 Timeline</div>
			<div class="tab" data-tab="log" onclick="switchTab('log')">➕ Log Entry</div>
		</div>

		<!-- Semantic Search -->
		<div id="tab-semantic">
			<div class="search-box">
				<input type="text" id="sem-q" placeholder="e.g. good chumming near Cape Edgecumbe, hydraulic failure, salmon set at 30 fathoms" onkeydown="if(event.key==='Enter')doSearch()">
				<button onclick="doSearch()">Search</button>
			</div>
			<div class="chips">
				<button class="btn-sm" onclick="quickSearch('good salmon catch')">good salmon catch</button>
				<button class="btn-sm" onclick="quickSearch('engine maintenance')">engine maintenance</button>
				<button class="btn-sm" onclick="quickSearch('bad weather rough seas')">bad weather</button>
				<button class="btn-sm" onclick="quickSearch('hydraulic problem')">hydraulic problem</button>
				<button class="btn-sm" onclick="quickSearch('tide change')">tide change</button>
			</div>
			<div class="chips" id="sem-filters"></div>
		</div>

		<!-- Spatial Search -->
		<div id="tab-spatial" class="hidden">
			<div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
				<label>Lat</label><input type="number" id="sp-lat" class="coords-input" step="0.0001" placeholder="56.6">
				<label>Lon</label><input type="number" id="sp-lon" class="coords-input" step="0.0001" placeholder="-134.0">
				<label>Radius (km)</label><input type="number" id="sp-radius" class="coords-input" value="50">
				<button class="btn" onclick="doSpatial()">Find Nearby</button>
			</div>
		</div>

		<!-- Timeline -->
		<div id="tab-timeline" class="hidden">
			<div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
				<label>From</label><input type="date" id="tl-from">
				<label>To</label><input type="date" id="tl-to">
				<select id="tl-cat" style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:6px;color:var(--text);">
					<option value="">All categories</option>
					<option value="catch">Catch</option>
					<option value="maintenance">Maintenance</option>
					<option value="weather">Weather</option>
					<option value="observation">Observation</option>
					<option value="navigation">Navigation</option>
				</select>
				<button class="btn" onclick="doTimeline()">Load Timeline</button>
			</div>
		</div>

		<!-- Quick Log Entry -->
		<div id="tab-log" class="hidden">
			<div class="log-form">
				<input type="text" id="log-text" class="full" placeholder="What happened? e.g. Chummed for 45 min, set 600 fath on the slack. 32 sockeye.">
				<select id="log-category">
					<option value="observation">Observation</option>
					<option value="catch">Catch</option>
					<option value="maintenance">Maintenance</option>
					<option value="weather">Weather</option>
					<option value="navigation">Navigation</option>
				</select>
				<input type="text" id="log-loc" placeholder="Location name (e.g. Cape Edgecumbe)">
				<input type="number" id="log-lat" class="coords-input" step="0.0001" placeholder="Lat">
				<input type="number" id="log-lon" class="coords-input" step="0.0001" placeholder="Lon">
				<button class="btn full" onclick="doLog()">Log Entry</button>
			</div>
		</div>

		<div id="status" style="margin-top:12px; font-size:13px; color:var(--dim);"></div>
		<div id="results" class="results"></div>
	</div>
</div>

<script>
function switchTab(tab) {
	document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
	document.querySelectorAll('[id^="tab-"]').forEach(el => {
		if (el.id === 'tab-' + tab) el.classList.remove('hidden');
		else if (el.id.startsWith('tab-') && el.id !== 'tab-bar') el.classList.add('hidden');
	});
	document.getElementById('results').innerHTML = '';
	document.getElementById('status').textContent = '';
}

function quickSearch(q) {
	document.getElementById('sem-q').value = q;
	doSearch();
}

async function doSearch() {
	const q = document.getElementById('sem-q').value.trim();
	if (!q) return;
	setStatus('Searching...');
	const res = await fetch('/api/search?q=' + encodeURIComponent(q) + '&k=20');
	const data = await res.json();
	if (!res.ok) return setStatus('Error: ' + (data.error || res.status), true);
	renderResults(data.results || [], data.count);
}

async function doSpatial() {
	const lat = document.getElementById('sp-lat').value;
	const lon = document.getElementById('sp-lon').value;
	const radius = document.getElementById('sp-radius').value || 50;
	if (!lat || !lon) return setStatus('Need lat and lon.', true);
	setStatus('Searching nearby...');
	const res = await fetch('/api/nearby?lat=' + lat + '&lon=' + lon + '&radius=' + radius + '&k=20');
	const data = await res.json();
	if (!res.ok) return setStatus('Error: ' + (data.error || res.status), true);
	renderResults(data.results || [], data.count, true);
}

async function doTimeline() {
	const from = document.getElementById('tl-from').value;
	const to = document.getElementById('tl-to').value;
	const cat = document.getElementById('tl-cat').value;
	let qs = '/api/timeline?k=50';
	if (from) qs += '&from=' + from + 'T00:00:00Z';
	if (to) qs += '&to=' + to + 'T23:59:59Z';
	if (cat) qs += '&category=' + cat;
	setStatus('Loading timeline...');
	const res = await fetch(qs);
	const data = await res.json();
	if (!res.ok) return setStatus('Error: ' + (data.error || res.status), true);
	renderResults(data.results || [], data.count, false, true);
}

async function doLog() {
	const text = document.getElementById('log-text').value.trim();
	if (!text) return setStatus('Need text.', true);
	const body = {
		text,
		category: document.getElementById('log-category').value,
		location_name: document.getElementById('log-loc').value || undefined,
		lat: parseFloat(document.getElementById('log-lat').value) || undefined,
		lon: parseFloat(document.getElementById('log-lon').value) || undefined,
	};
	setStatus('Logging...');
	const res = await fetch('/api/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
	const data = await res.json();
	if (!res.ok) return setStatus('Error: ' + (data.error || res.status), true);
	document.getElementById('log-text').value = '';
	setStatus('✅ Logged: ' + data.id);
}

function renderResults(results, count, isSpatial, isTimeline) {
	const el = document.getElementById('results');
	if (!results.length) { setStatus('No results.'); el.innerHTML = ''; return; }
	setStatus(count + ' entries found');
	el.innerHTML = results.map(r => {
		const m = r.metadata || {};
		const cat = m.category || 'observation';
		const ts = m.timestamp ? new Date(m.timestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
		const coords = (m.lat != null && m.lon != null) ? m.lat.toFixed(4) + ', ' + m.lon.toFixed(4) : '';
		const dist = isSpatial && r.distance_km != null ? r.distance_km.toFixed(1) + ' km' : '';
		const score = !isSpatial && !isTimeline && r.score != null ? (r.score * 100).toFixed(1) + '%' : '';
		const locName = m.location_name ? ' · ' + m.location_name : '';
		return '<div class="entry">' +
			'<div class="meta">' +
			'<span class="cat cat-' + cat + '">' + cat + '</span>' +
			'<span class="time">' + ts + '</span>' +
			(dist ? '<span class="time">' + dist + '</span>' : '') +
			(score ? '<span class="score">' + score + '</span>' : '') +
			'</div>' +
			'<div class="text">' + escHtml(m.description || m.text || r.id) + '</div>' +
			(coords ? '<div class="coords">' + coords + locName + '</div>' : '') +
			'</div>';
	}).join('');
}

function setStatus(msg, isErr) {
	const el = document.getElementById('status');
	el.textContent = msg;
	el.style.color = isErr ? 'var(--red)' : 'var(--dim)';
}

function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
</script>
</body>
</html>`;
