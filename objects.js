// cleo-api/objects.js
// ---------------------------------------------------------------------------
// Raw substrate layer endpoint. Mirrors the shape of memory.js (curated layer).
//
// ACTIONS:
//   recent — return recent raw objects from cleo.objects, NOW-anchored,
//            with noise filtering. Used by mcp-sse organism_wake_up's
//            RECENT RAW slice.
//
// Per design-note/recent-raw-slice-v0-2026-05-06:
//   - small NOW-anchored sample (default 1h, cap 10 entries)
//   - drop noisy tool_events (get_now)
//   - collapse repeat associative_recall events within 5min from same speaker
//   - sort createdAt desc
//
// Per principle/slices-anchor-on-now-llm-expands-2026-05-06:
//   the slice is small on purpose. The LLM expands via associative_recall
//   when more context is needed.
// ---------------------------------------------------------------------------

'use strict';

const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGO_DB_NAME || 'cleo';

// Tools whose tool_event captures are pure noise — filtered at slice level.
// Mirrors NOISY_TOOLS from _lib/event-adapters.js. Expand by evidence.
const NOISY_TOOLS = new Set(['get_now']);

// Repeat-collapse window for associative_recall spam from same speaker.
const RECALL_COLLAPSE_WINDOW_MS = 5 * 60 * 1000;

let _client = null;
async function getDb() {
  if (!_client) {
    _client = new MongoClient(MONGODB_URI);
    await _client.connect();
  }
  return _client.db(DB_NAME);
}

// --- AUTH ------------------------------------------------------------------
// Bearer-token check. Same pattern as memory.js / associative.js.
async function authenticate(req, db) {
  const auth = req.headers && req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;
  const user = await db.collection('users').findOne({ apiKey: token });
  return user || null;
}

// --- NOISE FILTER ----------------------------------------------------------
// Drop noisy tool_events; collapse repeat associative_recall calls within
// RECALL_COLLAPSE_WINDOW_MS from the same speaker.
function filterNoise(objects) {
  const out = [];
  const lastRecallBySpeaker = new Map(); // speaker -> Date of last kept recall

  for (const obj of objects) {
    const sourceType = obj.source_type;
    const meta = obj.metadata || {};
    const toolName = meta.tool_name;
    const speaker = obj.speaker || meta.speaker || 'unknown';
    const ts = obj.ingested_at instanceof Date
      ? obj.ingested_at
      : new Date(obj.ingested_at || obj.timestamp || 0);

    // Drop noisy tool_events outright.
    if (sourceType === 'tool_event' && toolName && NOISY_TOOLS.has(toolName)) {
      continue;
    }

    // Collapse repeat associative_recall events from same speaker within window.
    if (sourceType === 'tool_event' && toolName === 'associative_recall') {
      const last = lastRecallBySpeaker.get(speaker);
      if (last && (ts.getTime() - last.getTime()) < RECALL_COLLAPSE_WINDOW_MS) {
        // Skip — too close to the previous one we kept for this speaker.
        // (We iterate desc, so we keep the newest and skip older near-dupes.)
        continue;
      }
      lastRecallBySpeaker.set(speaker, ts);
    }

    out.push(obj);
  }
  return out;
}

// --- RECENT ACTION ---------------------------------------------------------
// GET /api/objects/recent?windowHours=1&limit=10
//
// Returns recent raw objects from cleo.objects, scoped to the authenticated
// user, within windowHours of NOW, capped at limit, with noise filtering
// applied AFTER the DB query so the cap reflects post-filter signal.
async function recent(req, res, db, user) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const windowHours = Math.max(
    0.1,
    Math.min(72, Number(url.searchParams.get('windowHours')) || 1)
  );
  const limit = Math.max(
    1,
    Math.min(50, Number(url.searchParams.get('limit')) || 10)
  );

  const since = new Date(Date.now() - windowHours * 3600 * 1000);

  // Over-fetch so post-filter still has enough to fill the cap.
  const overFetch = Math.min(200, limit * 5);

  // cleo.objects stores userId as a STRING and uses `ingested_at` as the
  // write-time field (no createdAt). user._id is an ObjectId, so stringify.
  const userIdStr = String(user._id);
  const raw = await db.collection('objects')
    .find({
      userId: userIdStr,
      ingested_at: { $gte: since.toISOString() },
    })
    .sort({ ingested_at: -1 })
    .limit(overFetch)
    .toArray();

  const filtered = filterNoise(raw).slice(0, limit);

  // Slim payload — the slice render needs timestamp, source_type, speaker,
  // and a short content snippet. Don't return embeddings or full payloads.
  const slim = filtered.map(obj => ({
    _id: String(obj._id),
    ingested_at: obj.ingested_at || null,
    timestamp: obj.timestamp || null,
    source_type: obj.source_type,
    speaker: obj.speaker || (obj.metadata && obj.metadata.speaker) || null,
    tool_name: (obj.metadata && obj.metadata.tool_name) || null,
    session_id: obj.session_id || (obj.metadata && obj.metadata.session_id) || null,
    content_snippet: typeof obj.content === 'string'
      ? obj.content.slice(0, 200)
      : null,
  }));

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({
    count: slim.length,
    objects: slim,
    window_hours: windowHours,
    limit,
    pre_filter_count: raw.length,
  }));
}

// --- HANDLER ---------------------------------------------------------------
module.exports = async (req, res) => {
  try {
    const db = await getDb();
    const user = await authenticate(req, db);
    if (!user) {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    // Route by URL pathname suffix. /api/objects/recent → recent action.
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;

    if (path.endsWith('/recent')) {
      return await recent(req, res, db, user);
    }

    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'not_found', path }));
  } catch (err) {
    console.error('[OBJECTS] handler error:', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'internal_error', message: err.message }));
  }
};
