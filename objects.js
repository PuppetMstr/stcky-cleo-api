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

  // cleo.objects stores userId as ObjectId and ingested_at as Date
  // (verified across all 1659 docs via peek-objects-types-v2).
  // Pass user._id (already ObjectId from auth) and since (Date) directly.
  const raw = await db.collection('objects')
    .find({
      userId: user._id,
      ingested_at: { $gte: since },
    })
    .sort({ ingested_at: -1 })
    .limit(overFetch)
    .toArray();

  const filtered = filterNoise(raw).slice(0, limit);

  // v4.24.0 — THE HONEST DOOR.
  //
  // This used to return `content_snippet: obj.content.slice(0, 200)` and
  // NOTHING ELSE. Two hundred characters. No full body, no true length, no
  // signal that anything had been cut.
  //
  // This endpoint feeds the MCP corpus read — which is the WAKE READ. The
  // first thing the agent does every single morning. So every morning brief
  // was built on 200-character stubs of the day before, and the agent had no
  // idea. On July 12 2026 that agent told Steven — on his birthday, about
  // decisions he had made and shown it screenshots of — that his own
  // substrate had holes in it. It did not. This line did.
  //
  // THE LAW: A FRAGMENT MUST NEVER BE ABLE TO PASS AS A WHOLE.
  //
  // Return the body. Return its true length. Let the reader verify. If a
  // window downstream must shorten, it shortens LOUDLY and points back at
  // GET /v1/object/:id to redeem the rest.
  const slim = filtered.map(obj => {
    const content = typeof obj.content === 'string' ? obj.content : '';
    return {
      _id: String(obj._id),
      ingested_at: obj.ingested_at || null,
      timestamp: obj.timestamp || null,
      source_type: obj.source_type,
      speaker: obj.speaker || (obj.metadata && obj.metadata.speaker) || null,
      tool_name: (obj.metadata && obj.metadata.tool_name) || null,
      session_id: obj.session_id || (obj.metadata && obj.metadata.session_id) || null,
      content,                        // WHOLE. Always.
      content_length: content.length, // so the reader can VERIFY it
      truncated: false,
      content_snippet: content,       // legacy field name, no longer a snippet
    };
  });

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({
    count: slim.length,
    objects: slim,
    window_hours: windowHours,
    limit,
    pre_filter_count: raw.length,
    complete: true,
  }));
}

// --- BY-ID ACTION — THE REDEMPTION DOOR ------------------------------------
// GET /v1/object/:id
//
// Every object in the pool has an id. Every read door hands that id back.
// And until July 12 2026 there was NOTHING TO REDEEM IT AGAINST — verified
// against production that morning: /api/objects/:id → 404, /v1/object/:id →
// 404, /v1/read {mode:"object"} → 400 unknown mode.
//
// That is the hole that turns truncation from an annoyance into a lie. A
// wrapper hands the reader a stub. The reader wants the rest. The reader HAS
// the id. And the bank will not honor the ticket. So the reader does the only
// thing left to it: reasons from the piece, hits the ragged end, decides the
// pool is silent, and fills the silence with something plausible.
//
// An id is a promise. This is the house keeping it.
async function byId(req, res, db, user, id) {
  let query = null;
  try {
    const { ObjectId } = require('mongodb');
    query = ObjectId.isValid(id)
      ? { $or: [{ _id: id }, { _id: new ObjectId(id) }] }
      : { _id: id };
  } catch (e) {
    query = { _id: id };
  }
  query.userId = user._id;   // sovereignty: your pool, and yours alone

  const obj = await db.collection('objects').findOne(query);

  if (!obj) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      error: 'object_not_found',
      id,
      message: 'No object ' + id + ' in this pool. This is a definitive negative for this ID '
             + '— it is NOT a truncation, NOT a window limit, and NOT grounds to infer content. '
             + 'It is also NOT proof that the subject is absent from the pool. Search again in '
             + 'the user\'s own words before ever telling them something is missing.',
    }));
    return;
  }

  const content = typeof obj.content === 'string' ? obj.content : '';

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({
    object: {
      _id: String(obj._id),
      content,                        // WHOLE. No cap. No ellipsis. No preview.
      content_length: content.length,
      speaker: obj.speaker || (obj.metadata && obj.metadata.speaker) || null,
      source_type: obj.source_type,
      source: obj.source || null,
      timestamp: obj.timestamp || null,
      ingested_at: obj.ingested_at || null,
    },
    complete: true,
    truncated: false,
  }));
}

// --- HANDLER ---------------------------------------------------------------
module.exports = async (req, res) => {
  try {
    const db = await getDb();
    const user = await authenticate(req, db);
    // THE WALL (Aug 1 2026). A scoped key cannot reach pool content -- see _lib/wall.js.
    if (require('./_lib/wall').wall(req, res, user, '/api/objects')) return;
    if (!user) {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    // Route by URL pathname suffix.
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;

    if (path.endsWith('/recent')) {
      return await recent(req, res, db, user);
    }

    // /v1/object/:id  or  /api/objects/:id  → the redemption door.
    const m = path.match(/^\/(?:v1\/object|api\/objects)\/([^/]+)$/);
    if (m && m[1]) {
      return await byId(req, res, db, user, decodeURIComponent(m[1]));
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
