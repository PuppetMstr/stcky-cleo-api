// /v1/read — STCKY thin-wrapper read endpoint
// =============================================
// Stable-door read door. Public contract: path /v1/read, mode values,
// response field names. Everything else is room (free to refactor).
//
// Routes via vercel.json:
//   { "src": "/v1/read", "dest": "/v1-read.js" }
//
// Companion spec: design-note/v1-read-thin-wrapper-spec-2026-05-11
// Filed by Eli May 11, 2026, then rewritten against memory.js patterns.

const { getDb, auth, cors } = require('./_lib/auth');

// ============ NOW ============
function nowISO() {
  return new Date().toISOString();
}
function nowHuman() {
  const opts = {
    timeZone: 'America/Los_Angeles',
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
    hour12: true,
  };
  return `${new Date().toLocaleString('en-US', opts)} (America/Los_Angeles)`;
}

// ============ RESPONSE SHAPING ============
// Strip embedding + heavy internals; return the documented response fields only.
function trimMemory(m) {
  return {
    _id: m._id,
    category: m.category,
    key: m.key,
    value: m.value,
    tags: m.tags || '',
    domain: m.domain || null,
    source: m.source || '',
    relevantDate: m.relevantDate || null,
    anchor: m.anchor === true,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    version_count: m.version_count || 1,
  };
}

function trimObject(o) {
  return {
    _id: o._id,
    content: o.content,
    speaker: o.speaker,
    source_type: o.source_type,
    source: o.source,
    timestamp: o.timestamp || o.client_timestamp,
    ingested_at: o.ingested_at,
    session_id: o.session_id,
    tool_name: o.metadata && o.metadata.tool_name,
    event_type: o.metadata && o.metadata.event_type,
  };
}

// ============ MODE: NOW ============
// NOW-anchored corpus pull. Parallel fan-out across curated (memories)
// and raw (objects), merged time-descending.
async function fanOutNow(db, user, hours, limit, include) {
  const hoursNum = Math.max(1, Math.min(parseInt(hours) || 24, 168));
  const limitNum = Math.max(1, Math.min(parseInt(limit) || 30, 200));
  const since = new Date(Date.now() - hoursNum * 60 * 60 * 1000);

  const inc = {
    curated: include.curated !== false,
    raw: include.raw !== false,
    events: include.events === true,
  };

  const [memoryDocs, objectDocs] = await Promise.all([
    inc.curated
      ? db.collection('memories')
          .find({ userId: user._id, updatedAt: { $gte: since } })
          .sort({ updatedAt: -1 })
          .limit(limitNum)
          .toArray()
      : Promise.resolve([]),
    inc.raw
      ? db.collection('objects')
          .find({
            userId: user._id,
            ingested_at: { $gte: since },
            ...(inc.events ? {} : { 'metadata.event_type': { $ne: 'tool_event' } }),
          })
          .sort({ ingested_at: -1 })
          .limit(limitNum)
          .toArray()
      : Promise.resolve([]),
  ]);

  // Time-descending merge across both collections, capped at limit total
  const merged = [
    ...memoryDocs.map(m => ({ kind: 'memory', ts: m.updatedAt, doc: m })),
    ...objectDocs.map(o => ({ kind: 'object', ts: o.ingested_at, doc: o })),
  ].sort((a, b) => b.ts - a.ts).slice(0, limitNum);

  return {
    memories: merged.filter(x => x.kind === 'memory').map(x => trimMemory(x.doc)),
    objects: merged.filter(x => x.kind === 'object').map(x => trimObject(x.doc)),
    window: { from: since.toISOString(), to: new Date().toISOString(), hours: hoursNum },
  };
}

// ============ MODE: SEMANTIC ============
// v1.0 implementation: regex match across key/value/tags/category, mirroring
// memory.js search action. Future: wrap associative.js for true vector ranking.
// The mode name is door (stays stable); the implementation is room.
async function semantic(db, user, query, limit, include) {
  const limitNum = Math.max(1, Math.min(parseInt(limit) || 10, 50));

  const inc = {
    curated: include.curated !== false,
    raw: include.raw !== false,
  };

  const memoryDocs = inc.curated
    ? await db.collection('memories')
        .find({
          userId: user._id,
          $or: [
            { key: { $regex: query, $options: 'i' } },
            { value: { $regex: query, $options: 'i' } },
            { tags: { $regex: query, $options: 'i' } },
            { category: { $regex: query, $options: 'i' } },
          ],
        })
        .sort({ updatedAt: -1 })
        .limit(limitNum)
        .toArray()
    : [];

  const objectDocs = inc.raw
    ? await db.collection('objects')
        .find({
          userId: user._id,
          content: { $regex: query, $options: 'i' },
        })
        .sort({ ingested_at: -1 })
        .limit(Math.ceil(limitNum / 2))
        .toArray()
    : [];

  return {
    memories: memoryDocs.map(trimMemory),
    objects: objectDocs.map(trimObject),
  };
}

// ============ MODE: CATEGORY_KEY ============
// Direct lookup. Returns the exact memory if found, otherwise empty list.
async function byCategoryKey(db, user, category, key) {
  const memory = await db.collection('memories').findOne({
    userId: user._id,
    category,
    key,
  });
  return {
    memories: memory ? [trimMemory(memory)] : [],
    objects: [],
  };
}

// ============ MODE: THREAD ============
// All memories with the thread tag matching the given thread string.
// Tags are stored as a single comma-separated string; match as substring.
async function byThread(db, user, thread, limit) {
  const limitNum = Math.max(1, Math.min(parseInt(limit) || 50, 200));

  // Escape regex metachars in thread name
  const escaped = thread.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rx = new RegExp(`(^|,)\\s*${escaped}\\s*(,|$)`, 'i');

  const memoryDocs = await db.collection('memories')
    .find({ userId: user._id, tags: { $regex: rx } })
    .sort({ updatedAt: -1 })
    .limit(limitNum)
    .toArray();

  return {
    memories: memoryDocs.map(trimMemory),
    objects: [],
  };
}

// ============ MODE: RAW_RECENT ============
// Raw objects only, NOW-anchored. Skips curated entirely.
async function rawRecent(db, user, hours, limit, include) {
  const hoursNum = Math.max(1, Math.min(parseInt(hours) || 24, 168));
  const limitNum = Math.max(1, Math.min(parseInt(limit) || 30, 200));
  const since = new Date(Date.now() - hoursNum * 60 * 60 * 1000);

  const inc = { events: include.events === true };

  const objectDocs = await db.collection('objects')
    .find({
      userId: user._id,
      ingested_at: { $gte: since },
      ...(inc.events ? {} : { 'metadata.event_type': { $ne: 'tool_event' } }),
    })
    .sort({ ingested_at: -1 })
    .limit(limitNum)
    .toArray();

  return {
    memories: [],
    objects: objectDocs.map(trimObject),
    window: { from: since.toISOString(), to: new Date().toISOString(), hours: hoursNum },
  };
}

// ============ MAIN HANDLER ============
module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  const user = await auth(req);
  if (!user) {
    console.log('[V1/READ AUTH] Failed - no user found for token');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const db = await getDb();

  // Update lastSeen (mirrors memory.js hygiene)
  await db.collection('users').updateOne(
    { _id: user._id },
    { $set: { lastSeen: new Date() } }
  );

  const body = req.body || {};
  const {
    mode = 'now',
    query,
    category,
    key,
    thread,
    hours = 24,
    limit,
    include = {},
  } = body;

  try {
    let result;
    switch (mode) {
      case 'now':
        result = await fanOutNow(db, user, hours, limit, include);
        break;
      case 'semantic':
        if (!query) {
          return res.status(400).json({ error: 'semantic mode requires query' });
        }
        result = await semantic(db, user, query, limit, include);
        break;
      case 'category_key':
        if (!category || !key) {
          return res.status(400).json({ error: 'category_key mode requires both category and key' });
        }
        result = await byCategoryKey(db, user, category, key);
        break;
      case 'thread':
        if (!thread) {
          return res.status(400).json({ error: 'thread mode requires thread' });
        }
        result = await byThread(db, user, thread, limit);
        break;
      case 'raw_recent':
        result = await rawRecent(db, user, hours, limit, include);
        break;
      default:
        return res.status(400).json({ error: `unknown mode: ${mode}` });
    }

    const response = {
      now_iso: nowISO(),
      now_human: nowHuman(),
      mode,
      memories: result.memories,
      objects: result.objects,
      total_memories: result.memories.length,
      total_objects: result.objects.length,
    };
    if (result.window) response.window = result.window;

    console.log(`[V1/READ] mode=${mode} memories=${result.memories.length} objects=${result.objects.length}`);
    return res.status(200).json(response);
  } catch (error) {
    console.error('[v1/read] handler error:', error);
    return res.status(500).json({ error: 'Internal server error', details: error.message });
  }
};
