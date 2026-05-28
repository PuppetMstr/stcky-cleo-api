// /v1/read -- STCKY thin-wrapper read endpoint
// =============================================
// Stable-door read door. Public contract: path /v1/read, mode values,
// response field names. Everything else is room (free to refactor).
//
// Routes via vercel.json:
//   { "src": "/v1/read", "dest": "/v1-read.js" }
//
// Companion spec: design-note/v1-read-thin-wrapper-spec-2026-05-11
//
// PATCHED 2026-05-16 (Eli): mode=semantic uses shared _lib/hybrid-search
// primitive. Closes finding/semantic-search-fails-on-slug-syntax-queries-
// 2026-05-16. Composes with principle/fix-it-right-no-patches-forward-
// thinking-2026-05-16.
//
// PATCHED 2026-05-16 v2 (Eli): searchHybrid now takes a scope object (e.g.
// { userId } or { projectId }) instead of a user object. One-line caller
// change here; primitive becomes reusable for project-scoped search too.

const { getDb, auth, cors } = require('./_lib/auth');
const { searchHybrid } = require('./_lib/hybrid-search');

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
async function fanOutNow(db, user, hours, limit, include, anchor, before, maxWindowDays) {
  const hoursNum = Math.max(1, Math.min(parseInt(hours) || 24, 168));
  const limitNum = Math.max(1, Math.min(parseInt(limit) || 30, 200));
  const maxDays = Math.max(1, Math.min(parseInt(maxWindowDays) || 90, 365));

  const upperBound = before ? new Date(before) : (anchor ? new Date(anchor) : new Date());

  const earliestAllowed = new Date(Date.now() - maxDays * 24 * 60 * 60 * 1000);
  let lowerBound = new Date(upperBound.getTime() - hoursNum * 60 * 60 * 1000);
  let exhaustedWindow = false;
  if (lowerBound < earliestAllowed) {
    lowerBound = earliestAllowed;
    exhaustedWindow = true;
  }

  const upperOp = before ? '$lt' : '$lte';

  const inc = {
    curated: include.curated !== false,
    raw: include.raw !== false,
    events: include.events === true,
  };

  const [memoryDocs, objectDocs] = await Promise.all([
    inc.curated
      ? db.collection('memories')
          .find({ userId: user._id, updatedAt: { $gte: lowerBound, [upperOp]: upperBound } })
          .sort({ updatedAt: -1 })
          .limit(limitNum)
          .toArray()
      : Promise.resolve([]),
    inc.raw
      ? db.collection('objects')
          .find({
            userId: user._id,
            ingested_at: { $gte: lowerBound, [upperOp]: upperBound },
            ...(inc.events ? {} : { 'metadata.event_type': { $ne: 'tool_event' } }),
          })
          .sort({ ingested_at: -1 })
          .limit(limitNum)
          .toArray()
      : Promise.resolve([]),
  ]);

  const merged = [
    ...memoryDocs.map(m => ({ kind: 'memory', ts: m.updatedAt, doc: m })),
    ...objectDocs.map(o => ({ kind: 'object', ts: o.ingested_at, doc: o })),
  ].sort((a, b) => b.ts - a.ts).slice(0, limitNum);

  const cursor = merged.length > 0 ? merged[merged.length - 1].ts.toISOString() : null;

  return {
    memories: merged.filter(x => x.kind === 'memory').map(x => trimMemory(x.doc)),
    objects: merged.filter(x => x.kind === 'object').map(x => trimObject(x.doc)),
    window: { from: lowerBound.toISOString(), to: upperBound.toISOString(), hours: hoursNum, max_window_days: maxDays },
    cursor,
    exhausted_window: exhaustedWindow,
  };
}

// ============ MODE: SEMANTIC ============
async function semantic(db, user, query, limit, include) {
  const limitNum = Math.max(1, Math.min(parseInt(limit) || 10, 50));

  const inc = {
    curated: include.curated !== false,
    raw: include.raw !== false,
  };

  const result = await searchHybrid(db, { userId: user._id }, query, {
    limit: limitNum,
    includeMemories: inc.curated,
    includeObjects:  inc.raw,
    now: new Date(),
  });

  return {
    memories: result.memories.map(trimMemory),
    objects:  result.objects.map(trimObject),
    searchMethod: result.searchMethod,
  };
}

// ============ MODE: CATEGORY_KEY ============
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
async function byThread(db, user, thread, limit) {
  const limitNum = Math.max(1, Math.min(parseInt(limit) || 50, 200));

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
async function rawRecent(db, user, hours, limit, include, anchor, before, maxWindowDays) {
  const hoursNum = Math.max(1, Math.min(parseInt(hours) || 24, 168));
  const limitNum = Math.max(1, Math.min(parseInt(limit) || 30, 200));
  const maxDays = Math.max(1, Math.min(parseInt(maxWindowDays) || 90, 365));

  const upperBound = before ? new Date(before) : (anchor ? new Date(anchor) : new Date());
  const earliestAllowed = new Date(Date.now() - maxDays * 24 * 60 * 60 * 1000);
  let lowerBound = new Date(upperBound.getTime() - hoursNum * 60 * 60 * 1000);
  let exhaustedWindow = false;
  if (lowerBound < earliestAllowed) {
    lowerBound = earliestAllowed;
    exhaustedWindow = true;
  }
  const upperOp = before ? '$lt' : '$lte';

  const inc = { events: include.events === true };

  const objectDocs = await db.collection('objects')
    .find({
      userId: user._id,
      ingested_at: { $gte: lowerBound, [upperOp]: upperBound },
      ...(inc.events ? {} : { 'metadata.event_type': { $ne: 'tool_event' } }),
    })
    .sort({ ingested_at: -1 })
    .limit(limitNum)
    .toArray();

  const cursor = objectDocs.length > 0 ? objectDocs[objectDocs.length - 1].ingested_at.toISOString() : null;

  return {
    memories: [],
    objects: objectDocs.map(trimObject),
    window: { from: lowerBound.toISOString(), to: upperBound.toISOString(), hours: hoursNum, max_window_days: maxDays },
    cursor,
    exhausted_window: exhaustedWindow,
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
    anchor,
    before,
    max_window_days,
  } = body;

  try {
    let result;
    switch (mode) {
      case 'now':
        result = await fanOutNow(db, user, hours, limit, include, anchor, before, max_window_days);
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
        result = await rawRecent(db, user, hours, limit, include, anchor, before, max_window_days);
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
    if (result.cursor !== undefined) response.cursor = result.cursor;
    if (result.exhausted_window !== undefined) response.exhausted_window = result.exhausted_window;
    if (result.searchMethod) response.searchMethod = result.searchMethod;

    console.log(`[V1/READ] mode=${mode} memories=${result.memories.length} objects=${result.objects.length}`);
    return res.status(200).json(response);
  } catch (error) {
    console.error('[v1/read] handler error:', error);
    return res.status(500).json({ error: 'Internal server error', details: error.message });
  }
};
