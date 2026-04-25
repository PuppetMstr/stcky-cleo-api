// admin-shadow-diff.js v0.1
//
// GET /api/admin/shadow-diff?event_id=<24-char-hex>
// Resolves a single retrieval_shadow_compared event's legacy_top + v3_top ID lists
// to full memory/object content for manual diff inspection. Read-only. ADMIN_SECRET gated.
//
// Purpose: satisfy Chaos's gate criterion 5 ("10+ manual diffs judged neutral-or-better").
// admin-shadow-stats gives the aggregate health signal; this gives one-event detail
// so a human can judge whether v3's chosen items are at-least-as-relevant as legacy's
// chosen items for the query.
//
// ID FORMAT in shadow event payload (from retrieval-shadow.js flatten functions):
//   "mem_<24-char-hex>"      → cleo.memories._id (MongoDB ObjectId hex)
//   "obj_obj_<32-char-hash>" → cleo.objects.object_id (content-addressed hash from /api/ingest)
//                               (the prefix is "obj_" + the object_id field which itself starts with "obj_")
//
// Author: Eli — Apr 25, 2026

const { MongoClient, ObjectId } = require('mongodb');

// ---------- Config ----------
const ADMIN_SECRET = process.env.ADMIN_SECRET;
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = 'cleo';

// Truncate long content so the response stays readable
const CONTENT_TRUNCATE_CHARS = 800;

// ---------- DB connection (cached across invocations) ----------
let cachedClient = null;
async function getDb() {
  if (cachedClient && cachedClient.topology && cachedClient.topology.isConnected()) {
    return cachedClient.db(DB_NAME);
  }
  cachedClient = new MongoClient(MONGODB_URI);
  await cachedClient.connect();
  return cachedClient.db(DB_NAME);
}

// ---------- Auth ----------
function checkAdminAuth(req) {
  if (!ADMIN_SECRET) {
    return { ok: false, status: 500, error: 'ADMIN_SECRET not configured on server' };
  }
  const header = req.headers?.authorization || req.headers?.Authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  const queryToken = req.query?.admin_secret || null;
  const provided = token || queryToken;
  if (!provided) {
    return { ok: false, status: 401, error: 'Missing admin token (Authorization: Bearer ... or ?admin_secret=)' };
  }
  if (provided !== ADMIN_SECRET) {
    return { ok: false, status: 403, error: 'Invalid admin token' };
  }
  return { ok: true };
}

// ---------- Helpers ----------
function truncate(s) {
  if (typeof s !== 'string') return s;
  if (s.length <= CONTENT_TRUNCATE_CHARS) return s;
  return s.slice(0, CONTENT_TRUNCATE_CHARS) + '... [TRUNCATED, ' + (s.length - CONTENT_TRUNCATE_CHARS) + ' more chars]';
}

// Parse a flatten ID into its lookup keys.
// Returns null if the prefix is unrecognized.
function parseFlattenId(id) {
  if (!id || typeof id !== 'string') return null;
  if (id.startsWith('mem_')) {
    const hex = id.slice(4);
    if (!/^[a-f0-9]{24}$/i.test(hex)) return null;
    return { collection: 'memories', _id_hex: hex };
  }
  if (id.startsWith('obj_')) {
    // The shadow flatten produces "obj_<object_id>" where object_id itself starts with "obj_".
    // So after stripping the leading "obj_", the remainder is the object_id field value.
    return { collection: 'objects', object_id: id.slice(4) };
  }
  return null;
}

// Resolve an array of flatten IDs to their full content documents, preserving rank order.
async function resolveIds(db, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return [];

  const memHexIds = [];
  const objIds = [];
  const parsedList = ids.map((raw) => {
    const parsed = parseFlattenId(raw);
    if (parsed) {
      if (parsed.collection === 'memories') memHexIds.push(parsed._id_hex);
      else if (parsed.collection === 'objects') objIds.push(parsed.object_id);
    }
    return { raw, parsed };
  });

  const [memDocs, objDocs] = await Promise.all([
    memHexIds.length > 0
      ? db.collection('memories').find({ _id: { $in: memHexIds.map((h) => new ObjectId(h)) } }).toArray()
      : Promise.resolve([]),
    objIds.length > 0
      ? db.collection('objects').find({ object_id: { $in: objIds } }).toArray()
      : Promise.resolve([]),
  ]);

  const memMap = new Map(memDocs.map((d) => [d._id.toString(), d]));
  const objMap = new Map(objDocs.map((d) => [d.object_id, d]));

  return parsedList.map(({ raw, parsed }, position) => {
    if (!parsed) {
      return { id: raw, position, error: 'unrecognized_prefix' };
    }
    if (parsed.collection === 'memories') {
      const d = memMap.get(parsed._id_hex);
      if (!d) return { id: raw, position, collection: 'memories', error: 'not_found' };
      return {
        id: raw,
        position,
        collection: 'memories',
        category: d.category,
        key: d.key,
        value: truncate(d.value),
        tags: d.tags,
        source: d.source,
        domain: d.domain,
        relevantDate: d.relevantDate,
        anchor: d.anchor,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
        accessCount: d.accessCount,
        lastAccessedAt: d.lastAccessedAt,
      };
    }
    if (parsed.collection === 'objects') {
      const d = objMap.get(parsed.object_id);
      if (!d) return { id: raw, position, collection: 'objects', error: 'not_found' };
      return {
        id: raw,
        position,
        collection: 'objects',
        object_id: d.object_id,
        source_type: d.source_type,
        source: d.source,
        speaker: d.speaker,
        content: truncate(d.content),
        content_length: d.content_length,
        session_id: d.session_id,
        turn_index: d.turn_index,
        timestamp: d.timestamp,
        ingested_at: d.ingested_at,
        parent_object_id: d.parent_object_id,
        chunk_index: d.chunk_index,
      };
    }
    return { id: raw, position, error: 'unknown_collection' };
  });
}

// ---------- Main handler ----------
module.exports = async (req, res) => {
  // CORS / preflight
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed; GET or POST only' });
  }

  // Auth
  const auth = checkAdminAuth(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  // event_id param
  const eventId = (req.query && req.query.event_id) || (req.body && req.body.event_id) || null;
  if (!eventId) {
    return res.status(400).json({
      error: 'Missing required param: event_id',
      usage: 'GET /api/admin/shadow-diff?event_id=<24-char-MongoDB-ObjectId-hex>',
      hint: 'Get event_id values from the _meta.sample_event._id field of /api/admin/shadow-stats, or by querying cleo.events directly.',
    });
  }
  if (!/^[a-f0-9]{24}$/i.test(eventId)) {
    return res.status(400).json({
      error: 'Invalid event_id format; expected 24-char ObjectId hex',
      received: eventId,
    });
  }

  try {
    const db = await getDb();

    const event = await db.collection('events').findOne({
      _id: new ObjectId(eventId),
      type: 'retrieval_shadow_compared',
    });
    if (!event) {
      return res.status(404).json({
        error: 'Shadow event not found',
        event_id: eventId,
        hint: 'Confirm the event_id is for a retrieval_shadow_compared event in cleo.events.',
      });
    }

    const payload = event.payload || {};
    const legacyTop = Array.isArray(payload.legacy_top) ? payload.legacy_top : [];
    const v3Top = Array.isArray(payload.v3_top) ? payload.v3_top : [];
    const divergence = payload.divergence || {};

    // Resolve both lists in parallel
    const [legacyResolved, v3Resolved] = await Promise.all([
      resolveIds(db, legacyTop),
      resolveIds(db, v3Top),
    ]);

    // Compute set diffs for visualization (preserves rank position info)
    const legacySet = new Set(legacyTop);
    const v3Set = new Set(v3Top);
    const onlyInLegacyIds = new Set(legacyTop.filter((id) => !v3Set.has(id)));
    const onlyInV3Ids = new Set(v3Top.filter((id) => !legacySet.has(id)));
    const sharedIds = legacyTop.filter((id) => v3Set.has(id));

    const onlyInLegacy = legacyResolved.filter((r) => onlyInLegacyIds.has(r.id));
    const onlyInV3 = v3Resolved.filter((r) => onlyInV3Ids.has(r.id));
    const shared = sharedIds.map((id) => ({
      id,
      legacy_position: legacyTop.indexOf(id),
      v3_position: v3Top.indexOf(id),
      rank_shift: legacyTop.indexOf(id) - v3Top.indexOf(id),
      // Resolve content from whichever list has it (they're the same item, same content)
      content: legacyResolved.find((r) => r.id === id) || v3Resolved.find((r) => r.id === id),
    }));

    return res.status(200).json({
      event: {
        _id: event._id,
        createdAt: event.createdAt,
        type: event.type,
        actor: event.actor,
      },
      query: payload.query,
      user_id: payload.user_id,
      api_key_fp: payload.api_key_fp,
      timing: payload.timing,
      status: payload.status,
      divergence: {
        jaccard: divergence.jaccard,
        rank_delta: divergence.rank_delta,
        overlap_count: divergence.overlap_count,
        compared_depth: divergence.compared_depth,
        only_in_legacy_count: onlyInLegacy.length,
        only_in_v3_count: onlyInV3.length,
        shared_count: shared.length,
      },
      legacy_top: legacyResolved,
      v3_top: v3Resolved,
      diff: {
        only_in_legacy: onlyInLegacy,
        only_in_v3: onlyInV3,
        shared,
      },
      _inspection_guide: {
        purpose: 'Manual diff inspection per Chaos canary gate criterion 5: judge whether v3 chosen items are at-least-as-relevant as legacy chosen items for the query.',
        method: 'Read the query at top. For each item in only_in_legacy, decide: would surfacing this be MORE relevant than what v3 returned in only_in_v3? Or are they comparable? Or is v3 actually surfacing better material?',
        rating_scheme: 'For each event inspected: rate v3 as BETTER (v3 picks more relevant items), NEUTRAL (comparable), or WORSE (legacy picks more relevant items). 10+ events. To pass canary gate: NEUTRAL or BETTER on >= 8 of 10.',
        store_findings_at: 'STCKY memory_store: category=manual-diff-inspection, key=rung-3-canary-gate-2026-04-25, value=ratings + reasoning per event.',
      },
      _meta: {
        endpoint_version: '0.1',
        endpoint_author: 'Eli',
        endpoint_date: '2026-04-25',
        content_truncate_chars: CONTENT_TRUNCATE_CHARS,
      },
    });
  } catch (err) {
    console.error('[shadow-diff] error:', err);
    return res.status(500).json({
      error: 'Internal server error',
      message: err.message,
    });
  }
};
