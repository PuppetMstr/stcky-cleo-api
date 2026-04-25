/**
 * STCKY Associative Recall v5.2.2 — RUNG 3 READ-SIDE UNIFICATION (behind flag)
 *
 * v5.2.2 (2026-04-25):
 *   - PATCH: fixed shadow comparison apples-to-oranges. v5.2.1's runV3Pipeline
 *     correctly built per-source legacy back-compat arrays, but the shadow
 *     harness still received `v3.ranked` (merged top-N capped at limit total)
 *     while legacy passed its two-array shape. Comparison showed false-positive
 *     blind spots because v3 had 5 items vs legacy's 10. Fix: runV3Pipeline
 *     additionally returns `rankedForShadow` = [...memRanked, ...objRanked,
 *     ...evtRanked] (per-source, matches legacy two-array shape). v3Fn passes
 *     rankedForShadow to shadow harness. The merged `ranked` is unchanged and
 *     still available to v3-aware consumers via the `candidates` response field.
 *
 * v5.2.1 (2026-04-25):
 *   - PATCH: fixed v3 legacy back-compat array limit semantics.
 *     v5.2.0's runV3Pipeline built legacyMemories/legacyObjects/legacyEvents
 *     by filtering the merged `ranked` list (capped at `limit` total). When
 *     memories outscored objects in the unified ranker, objects got squeezed
 *     out of the legacy arrays — surfaced as V3_BLIND_SPOTS in shadow stats.
 *     Fix: per-source ranking for legacy arrays preserves "limit per source"
 *     contract from runLegacyPipeline. Merged `candidates` field unchanged
 *     (still uses unified ranker at limit total — intentional new semantic).
 *
 * v5.2.0 (2026-04-24):
 *   - Added v3 retrieval pipeline behind RETRIEVAL_V3_MODE env var:
 *       off    → legacy path only (default, byte-for-byte unchanged from 5.1.0)
 *       shadow → run legacy + v3 in parallel, return legacy, log divergence
 *       canary → v3 for users in CANARY_USER_IDS, shadow for others
 *       on     → v3 for all users
 *   - v3 pipeline queries memories + objects + events in parallel, runs
 *     adapter normalization into canonical envelopes, ranks via
 *     _lib/retrieval-ranker.js using combined semantic+lexical+recency+trust.
 *   - v3 response is ADDITIVE: legacy memories/objects arrays still populated,
 *     new events array + candidates array added. No client breakage.
 *   - Shadow divergence events written to cleo.events with
 *     type='retrieval_shadow_compared', scoped to user, excluded from recall.
 *   - Legacy path completely unchanged when RETRIEVAL_V3_MODE=off (default).
 *
 * v5.1.0 (2026-04-22):
 *   - Added objectsVectorSearch against `objects` collection.
 *   - Response includes `objects: [...]` alongside `memories: [...]`.
 *
 * v5.0.0:
 *   - Hybrid vector + keyword on memories. Temporal NOW scoring.
 */

const { getDb, auth, cors, ObjectId } = require('./_lib/auth');
const { embed } = require('./_lib/embeddings');

// Rung 3 helpers (inert if RETRIEVAL_V3_MODE is 'off')
const {
  memoryToCanonical,
  objectToCanonical,
  eventToCanonical,
} = require('./_lib/event-adapters');
const { rankCandidates }   = require('./_lib/retrieval-ranker');
const { runShadowCompare } = require('./_lib/retrieval-shadow');

const MEMORIES_VECTOR_INDEX = 'memory_vector_index';
const OBJECTS_VECTOR_INDEX  = 'objects_vector_index';

// --------------------------------------------------------------------------
// Temporal scoring (unchanged from v5.0.0/5.1.0 — used by LEGACY path only).
// --------------------------------------------------------------------------

function calculateTemporalScore(memory, now) {
  let score = 0;
  const hoursSinceUpdate = (now - new Date(memory.updatedAt)) / (1000 * 60 * 60);
  if (hoursSinceUpdate < 24) score += 30;
  else if (hoursSinceUpdate < 168) score += 20;
  else if (hoursSinceUpdate < 720) score += 10;

  if (memory.relevantDate) {
    const hoursToRelevant = Math.abs(now - new Date(memory.relevantDate)) / (1000 * 60 * 60);
    if (hoursToRelevant < 24) score += 30;
    else if (hoursToRelevant < 168) score += 20;
    else if (hoursToRelevant < 720) score += 10;
  }

  if (memory.accessCount > 10) score += 10;
  else if (memory.accessCount > 5) score += 5;

  return score;
}

function calculateObjectTemporalScore(obj, now) {
  let score = 0;
  const anchorTime = obj.timestamp || obj.ingested_at || obj.server_ingest_timestamp;
  if (anchorTime) {
    const hoursSince = (now - new Date(anchorTime)) / (1000 * 60 * 60);
    if (hoursSince < 24) score += 30;
    else if (hoursSince < 168) score += 20;
    else if (hoursSince < 720) score += 10;
  }
  return score;
}

// --------------------------------------------------------------------------
// Memory search paths (unchanged).
// --------------------------------------------------------------------------

async function memoryVectorSearch(db, userId, queryEmbedding, limit) {
  try {
    const pipeline = [
      {
        $vectorSearch: {
          index: MEMORIES_VECTOR_INDEX,
          path: 'embedding',
          queryVector: queryEmbedding,
          numCandidates: limit * 20,
          limit: limit * 2,
          filter: { userId: userId }
        }
      },
      {
        $project: {
          _id: 1,
          category: 1, key: 1, value: 1, tags: 1,
          domain: 1, anchor: 1, relevantDate: 1,
          createdAt: 1, updatedAt: 1, accessCount: 1,
          vectorScore: { $meta: 'vectorSearchScore' }
        }
      }
    ];
    return await db.collection('memories').aggregate(pipeline).toArray();
  } catch (error) {
    console.log('[ASSOCIATIVE] Memory vector search failed:', error.message);
    return null;
  }
}

async function memoryKeywordSearch(db, userId, queryTerms, limit) {
  const searchConditions = queryTerms.map(term => ({
    $or: [
      { key:      { $regex: term, $options: 'i' } },
      { value:    { $regex: term, $options: 'i' } },
      { tags:     { $regex: term, $options: 'i' } },
      { category: { $regex: term, $options: 'i' } }
    ]
  }));

  const searchQuery = {
    userId: userId,
    ...(searchConditions.length > 0 ? { $or: searchConditions.map(c => c.$or).flat() } : {})
  };

  return await db.collection('memories')
    .find(searchQuery)
    .limit(limit * 3)
    .toArray();
}

// --------------------------------------------------------------------------
// Object search paths (unchanged).
// --------------------------------------------------------------------------

async function objectsVectorSearch(db, userId, queryEmbedding, limit) {
  try {
    const pipeline = [
      {
        $vectorSearch: {
          index: OBJECTS_VECTOR_INDEX,
          path: 'embedding',
          queryVector: queryEmbedding,
          numCandidates: limit * 20,
          limit: limit * 2,
          filter: { userId: userId }
        }
      },
      {
        $project: {
          _id: 1,
          object_id: 1, content: 1, content_length: 1,
          source_type: 1, source: 1, speaker: 1,
          session_id: 1, turn_index: 1, trace_id: 1, client: 1,
          timestamp: 1, ingested_at: 1,
          parent_object_id: 1, chunk_index: 1,
          embedding: 1, // needed by adapter to determine enrichment.state
          metadata: 1,
          vectorScore: { $meta: 'vectorSearchScore' }
        }
      }
    ];
    return await db.collection('objects').aggregate(pipeline).toArray();
  } catch (error) {
    console.log('[ASSOCIATIVE] Objects vector search failed:', error.message);
    return null;
  }
}

async function objectsKeywordSearch(db, userId, queryTerms, limit) {
  if (queryTerms.length === 0) return [];

  const searchConditions = queryTerms.map(term => ({
    $or: [
      { content: { $regex: term, $options: 'i' } },
      { source:  { $regex: term, $options: 'i' } },
      { speaker: { $regex: term, $options: 'i' } }
    ]
  }));

  return await db.collection('objects')
    .find({
      userId: userId,
      $or: searchConditions.map(c => c.$or).flat()
    })
    .limit(limit * 3)
    .toArray();
}

// --------------------------------------------------------------------------
// Events search path (NEW in v5.2.0 for Rung 3).
// Events are the Phase 0 audit log. They are NOT semantically embedded
// (adapter flags them enrichment.state='skipped'). Lexical only.
// Shadow log events are excluded from recall to prevent recursive noise.
// --------------------------------------------------------------------------

async function eventsKeywordSearch(db, userId, queryTerms, limit) {
  if (queryTerms.length === 0) return [];

  const searchConditions = queryTerms.map(term => ({
    $or: [
      { type:  { $regex: term, $options: 'i' } },
      { actor: { $regex: term, $options: 'i' } }
    ]
  }));

  try {
    return await db.collection('events')
      .find({
        userId: userId,
        type: { $ne: 'retrieval_shadow_compared' }, // don't recurse into shadow logs
        $or: searchConditions.map(c => c.$or).flat()
      })
      .limit(limit * 3)
      .toArray();
  } catch (error) {
    console.log('[ASSOCIATIVE] Events keyword search failed:', error.message);
    return [];
  }
}

// --------------------------------------------------------------------------
// Merge + rank (legacy paths, unchanged).
// --------------------------------------------------------------------------

function mergeAndRankMemories(vectorResults, keywordResults, queryTerms, now) {
  const seen = new Set();
  const merged = [];

  if (vectorResults) {
    for (const m of vectorResults) {
      const id = m._id.toString();
      if (!seen.has(id)) {
        seen.add(id);
        m.vectorScore = m.vectorScore || 0;
        m.keywordScore = 0;
        merged.push(m);
      }
    }
  }

  if (keywordResults) {
    for (const m of keywordResults) {
      const id = m._id.toString();
      if (!seen.has(id)) {
        seen.add(id);
        m.vectorScore = 0;
        m.keywordScore = calculateKeywordScore(m, queryTerms, ['key', 'value', 'tags', 'category']);
        merged.push(m);
      } else {
        const existing = merged.find(x => x._id.toString() === id);
        if (existing) {
          existing.keywordScore = calculateKeywordScore(m, queryTerms, ['key', 'value', 'tags', 'category']);
        }
      }
    }
  }

  for (const m of merged) {
    const temporalScore = calculateTemporalScore(m, now);
    const normalizedVector = (m.vectorScore || 0) * 50;
    const keywordPart = m.keywordScore || 0;
    m.relevanceScore = Math.round(normalizedVector + keywordPart + temporalScore);
  }

  merged.sort((a, b) => b.relevanceScore - a.relevanceScore);
  return merged;
}

function mergeAndRankObjects(vectorResults, keywordResults, queryTerms, now) {
  const seen = new Set();
  const merged = [];

  if (vectorResults) {
    for (const o of vectorResults) {
      const id = o._id.toString();
      if (!seen.has(id)) {
        seen.add(id);
        o.vectorScore = o.vectorScore || 0;
        o.keywordScore = 0;
        merged.push(o);
      }
    }
  }

  if (keywordResults) {
    for (const o of keywordResults) {
      const id = o._id.toString();
      if (!seen.has(id)) {
        seen.add(id);
        o.vectorScore = 0;
        o.keywordScore = calculateKeywordScore(o, queryTerms, ['content', 'source', 'speaker']);
        merged.push(o);
      } else {
        const existing = merged.find(x => x._id.toString() === id);
        if (existing) {
          existing.keywordScore = calculateKeywordScore(o, queryTerms, ['content', 'source', 'speaker']);
        }
      }
    }
  }

  for (const o of merged) {
    const temporalScore = calculateObjectTemporalScore(o, now);
    const normalizedVector = (o.vectorScore || 0) * 50;
    const keywordPart = o.keywordScore || 0;
    o.relevanceScore = Math.round(normalizedVector + keywordPart + temporalScore);
  }

  merged.sort((a, b) => b.relevanceScore - a.relevanceScore);
  return merged;
}

function calculateKeywordScore(doc, queryTerms, fields) {
  if (!queryTerms || queryTerms.length === 0) return 0;
  let score = 0;
  const parts = fields.map(f => String(doc[f] ?? '')).join(' ').toLowerCase();
  for (const term of queryTerms) {
    if (parts.includes(term.toLowerCase())) {
      score += 40 / queryTerms.length;
    }
  }
  return Math.round(score);
}

// --------------------------------------------------------------------------
// LEGACY pipeline — v5.1.0 logic extracted into a helper.
// Returns the response object (no res.json() — caller does that).
// --------------------------------------------------------------------------

async function runLegacyPipeline({ db, user, query, queryTerms, limit, now, includeMemories, includeObjects, projectId, previousLastSeen }) {
  const [smallEmbed, largeEmbed] = await Promise.all([
    includeMemories ? embed(query, 'small') : Promise.resolve(null),
    includeObjects  ? embed(query, 'large') : Promise.resolve(null),
  ]);

  const memoryTasks = [];
  if (includeMemories) {
    memoryTasks.push(smallEmbed?.embedding
      ? memoryVectorSearch(db, user._id, smallEmbed.embedding, limit)
      : Promise.resolve(null));
    memoryTasks.push(memoryKeywordSearch(db, user._id, queryTerms, limit));
  } else {
    memoryTasks.push(Promise.resolve(null), Promise.resolve([]));
  }

  const objectTasks = [];
  if (includeObjects) {
    objectTasks.push(largeEmbed?.embedding
      ? objectsVectorSearch(db, user._id, largeEmbed.embedding, limit)
      : Promise.resolve(null));
    objectTasks.push(objectsKeywordSearch(db, user._id, queryTerms, limit));
  } else {
    objectTasks.push(Promise.resolve(null), Promise.resolve([]));
  }

  const [memVec, memKw, objVec, objKw] = await Promise.all([...memoryTasks, ...objectTasks]);

  const rankedMemories = includeMemories
    ? mergeAndRankMemories(memVec, memKw, queryTerms, now).slice(0, limit)
    : [];
  const rankedObjects = includeObjects
    ? mergeAndRankObjects(objVec, objKw, queryTerms, now).slice(0, limit)
    : [];

  const searchMethod = {
    memories: memVec && memVec.length > 0 ? 'hybrid' : (memKw && memKw.length > 0 ? 'keyword' : 'none'),
    objects:  objVec && objVec.length > 0 ? 'hybrid' : (objKw && objKw.length > 0 ? 'keyword' : 'none'),
  };

  return {
    response: {
      now: now.toISOString(),
      lastSeen: previousLastSeen,
      searchMethod,
      memories: rankedMemories,
      count: rankedMemories.length,
      objects: rankedObjects,
      objects_count: rankedObjects.length,
      query,
      projectId: projectId || null,
    },
    memoryIdsForAccessUpdate: rankedMemories.map(m => m._id),
  };
}

// --------------------------------------------------------------------------
// V3 pipeline (Rung 3). Queries three collections, adapts to canonical
// envelopes, ranks via shared ranker, returns additive response shape.
// --------------------------------------------------------------------------

async function runV3Pipeline({ db, user, query, queryTerms, limit, now, includeMemories, includeObjects, includeEvents, projectId, previousLastSeen }) {
  // Use the LARGE embedding for both memories and objects so a single vector
  // can drive semantic scoring across sources. Legacy kept them split because
  // the indexes use different dimensions; but for RANKING we want a single
  // semantic axis. Memories index is 1536 (small), objects index is 3072
  // (large) — so we actually need both embeddings, one per source's index.
  const [smallEmbed, largeEmbed] = await Promise.all([
    includeMemories ? embed(query, 'small') : Promise.resolve(null),
    includeObjects  ? embed(query, 'large') : Promise.resolve(null),
  ]);

  const memoryTasks = [];
  if (includeMemories) {
    memoryTasks.push(smallEmbed?.embedding
      ? memoryVectorSearch(db, user._id, smallEmbed.embedding, limit)
      : Promise.resolve(null));
    memoryTasks.push(memoryKeywordSearch(db, user._id, queryTerms, limit));
  } else {
    memoryTasks.push(Promise.resolve(null), Promise.resolve([]));
  }

  const objectTasks = [];
  if (includeObjects) {
    objectTasks.push(largeEmbed?.embedding
      ? objectsVectorSearch(db, user._id, largeEmbed.embedding, limit)
      : Promise.resolve(null));
    objectTasks.push(objectsKeywordSearch(db, user._id, queryTerms, limit));
  } else {
    objectTasks.push(Promise.resolve(null), Promise.resolve([]));
  }

  const eventTasks = [];
  if (includeEvents) {
    eventTasks.push(eventsKeywordSearch(db, user._id, queryTerms, limit));
  } else {
    eventTasks.push(Promise.resolve([]));
  }

  const [memVec, memKw, objVec, objKw, evtKw] = await Promise.all([
    ...memoryTasks, ...objectTasks, ...eventTasks,
  ]);

  // --- Build canonical candidates + signal map ---
  const candidates = [];
  const signalsMap = new Map();

  // Memories
  const memRawById = new Map();
  for (const m of (memVec || [])) {
    memRawById.set(m._id.toString(), { doc: m, vec: m.vectorScore || 0, kw: 0 });
  }
  for (const m of (memKw || [])) {
    const id = m._id.toString();
    const kwScore = calculateKeywordScore(m, queryTerms, ['key', 'value', 'tags', 'category']);
    if (memRawById.has(id)) {
      memRawById.get(id).kw = kwScore;
    } else {
      memRawById.set(id, { doc: m, vec: 0, kw: kwScore });
    }
  }
  for (const { doc, vec, kw } of memRawById.values()) {
    const c = memoryToCanonical(doc);
    if (!c) continue;
    candidates.push(c);
    signalsMap.set(c.event_id, { semantic: vec, lexical: kw / 40 });
  }

  // Objects
  const objRawById = new Map();
  for (const o of (objVec || [])) {
    objRawById.set(o._id.toString(), { doc: o, vec: o.vectorScore || 0, kw: 0 });
  }
  for (const o of (objKw || [])) {
    const id = o._id.toString();
    const kwScore = calculateKeywordScore(o, queryTerms, ['content', 'source', 'speaker']);
    if (objRawById.has(id)) {
      objRawById.get(id).kw = kwScore;
    } else {
      objRawById.set(id, { doc: o, vec: 0, kw: kwScore });
    }
  }
  for (const { doc, vec, kw } of objRawById.values()) {
    const c = objectToCanonical(doc);
    if (!c) continue;
    candidates.push(c);
    signalsMap.set(c.event_id, { semantic: vec, lexical: kw / 40 });
  }

  // Events (lexical only — adapter flags enrichment.state='skipped' so ranker
  // will zero out semantic even if we passed a nonzero value)
  for (const e of (evtKw || [])) {
    const c = eventToCanonical(e);
    if (!c) continue;
    const kwScore = calculateKeywordScore(e, queryTerms, ['type', 'actor']);
    candidates.push(c);
    signalsMap.set(c.event_id, { semantic: 0, lexical: kwScore / 40 });
  }

  // --- Rank (merged, for new candidates field) ---
  const ranked = rankCandidates(candidates, signalsMap, {
    nowMs: now.getTime(),
    limit,
  });

  // --- Rank per source (for legacy back-compat arrays) ---
  // PATCH 2026-04-25: legacy arrays must preserve the "limit per source"
  // contract from runLegacyPipeline. The previous shape filtered the merged
  // `ranked` list (capped at `limit` total), which let memories squeeze
  // objects out of the legacy arrays when they outscored objects in the
  // unified ranker — caused V3_BLIND_SPOTS in shadow data 2026-04-25.
  // Fix: rank each source separately for the legacy arrays. The new
  // `candidates` field still uses the merged ranked list (intentional new
  // semantic — best N regardless of source).
  const memCandidates = candidates.filter(c => c.meta.source_collection === 'memories');
  const objCandidates = candidates.filter(c => c.meta.source_collection === 'objects');
  const evtCandidates = candidates.filter(c => c.meta.source_collection === 'events');
  const memRanked = rankCandidates(memCandidates, signalsMap, { nowMs: now.getTime(), limit });
  const objRanked = rankCandidates(objCandidates, signalsMap, { nowMs: now.getTime(), limit });
  const evtRanked = rankCandidates(evtCandidates, signalsMap, { nowMs: now.getTime(), limit });

  // --- Build additive response ---
  const candidatesOut = ranked.map(r => ({
    event_id:          r.candidate.event_id,
    score:             Math.round(r.score * 1000) / 1000,
    source_collection: r.candidate.meta.source_collection,
    kind:              r.candidate.kind,
    ts_human:          r.candidate.ts_human,
    summary:           r.candidate.summary,
    payload:           r.candidate.payload,
    actor:             r.candidate.actor,
    flags:             r.candidate.flags,
    enrichment:        r.candidate.enrichment,
    trust:             r.candidate.trust,
    meta:              r.candidate.meta,
    breakdown:         r.breakdown,
  }));

  // Legacy arrays from per-source ranked lists. Same raw-doc shape as legacy
  // pipeline so clients reading `memories`/`objects` keep their existing
  // field shape unchanged.
  const legacyMemories = [];
  for (const r of memRanked) {
    const entry = memRawById.get(r.candidate.meta.legacy_id);
    if (entry) {
      entry.doc.relevanceScore = Math.round(r.score * 100);
      legacyMemories.push(entry.doc);
    }
  }
  const legacyObjects = [];
  for (const r of objRanked) {
    const entry = objRawById.get(r.candidate.meta.legacy_id);
    if (entry) {
      entry.doc.relevanceScore = Math.round(r.score * 100);
      legacyObjects.push(entry.doc);
    }
  }
  const legacyEvents = [];
  for (const r of evtRanked) {
    legacyEvents.push({
      _id: r.candidate.meta.legacy_id,
      type: r.candidate.kind,
      actor: r.candidate.actor.actor_id,
      ts_human: r.candidate.ts_human,
      summary: r.candidate.summary,
      relevanceScore: Math.round(r.score * 100),
    });
  }

  const searchMethod = {
    memories: memVec && memVec.length > 0 ? 'hybrid' : (memKw && memKw.length > 0 ? 'keyword' : 'none'),
    objects:  objVec && objVec.length > 0 ? 'hybrid' : (objKw && objKw.length > 0 ? 'keyword' : 'none'),
    events:   (evtKw && evtKw.length > 0) ? 'keyword' : 'none',
  };

  return {
    response: {
      now: now.toISOString(),
      lastSeen: previousLastSeen,
      searchMethod,
      memories: legacyMemories,
      count: legacyMemories.length,
      objects: legacyObjects,
      objects_count: legacyObjects.length,
      events: legacyEvents,
      events_count: legacyEvents.length,
      candidates: candidatesOut,
      candidates_count: candidatesOut.length,
      query,
      projectId: projectId || null,
      retrieval_mode: 'v3',
    },
    memoryIdsForAccessUpdate: legacyMemories.map(m => m._id),
    ranked, // merged top-N (limit total) — for v3-aware consumers via candidates field
    // PATCH 2026-04-25 v5.2.2: rankedForShadow concatenates per-source ranked lists
    // (each capped at limit per source) so shadow comparison sees the same shape
    // legacy returns from runLegacyPipeline (memories + objects two-array). Without
    // this, flattenV3Ranking would receive only `ranked` (capped at limit total)
    // and shadow would always show false-positive "blind spots" because the
    // comparison is apples-to-oranges (5 v3 items vs 10 legacy items). The merged
    // `ranked` is still returned for v3-aware consumers; this is purely additional.
    rankedForShadow: [...memRanked, ...objRanked, ...evtRanked],
  };
}

// --------------------------------------------------------------------------
// Mode resolution
// --------------------------------------------------------------------------

function resolveMode(user) {
  const raw = String(process.env.RETRIEVAL_V3_MODE || 'off').toLowerCase();
  const canaryIds = String(process.env.CANARY_USER_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const userIdStr = user && user._id && String(user._id);
  const isCanary = userIdStr && canaryIds.includes(userIdStr);

  if (raw === 'on')     return { mode: 'v3',     isCanary, reason: 'on' };
  if (raw === 'canary') return { mode: isCanary ? 'v3' : 'shadow', isCanary, reason: 'canary' };
  if (raw === 'shadow') return { mode: 'shadow', isCanary, reason: 'shadow' };
  return { mode: 'legacy', isCanary, reason: 'off' };
}

// --------------------------------------------------------------------------
// Handler
// --------------------------------------------------------------------------

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await auth(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const db = await getDb();

  // Track lastSeen — applies to all modes, runs exactly once per request.
  const previousLastSeen = user.lastSeen || null;
  await db.collection('users').updateOne(
    { _id: user._id },
    { $set: { lastSeen: new Date() } }
  );

  let query, limit, projectId, includeObjects, includeMemories, includeEvents;
  if (req.method === 'POST') {
    query = req.body.query;
    limit = req.body.limit || 10;
    projectId = req.body.projectId;
    includeObjects  = req.body.includeObjects  !== false;
    includeMemories = req.body.includeMemories !== false;
    includeEvents   = req.body.includeEvents   !== false; // v3 only; legacy ignores
  } else if (req.method === 'GET') {
    query = req.query.query;
    limit = parseInt(req.query.limit) || 10;
    projectId = req.query.projectId;
    includeObjects  = req.query.includeObjects  !== 'false';
    includeMemories = req.query.includeMemories !== 'false';
    includeEvents   = req.query.includeEvents   !== 'false';
  } else {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!query) return res.status(400).json({ error: 'query parameter required' });

  try {
    const now = new Date();
    const queryTerms = query.split(/\s+/).filter(t => t.length > 2);

    const { mode, isCanary, reason } = resolveMode(user);

    const commonArgs = {
      db, user, query, queryTerms, limit, now,
      includeMemories, includeObjects, includeEvents,
      projectId, previousLastSeen,
    };

    // -------- LEGACY (mode=off) --------
    if (mode === 'legacy') {
      const { response, memoryIdsForAccessUpdate } = await runLegacyPipeline(commonArgs);
      await bumpAccessCounts(db, memoryIdsForAccessUpdate, now);
      return res.status(200).json(response);
    }

    // -------- V3 (mode=on or canary-matched user) --------
    if (mode === 'v3') {
      const { response, memoryIdsForAccessUpdate } = await runV3Pipeline(commonArgs);
      await bumpAccessCounts(db, memoryIdsForAccessUpdate, now);
      return res.status(200).json(response);
    }

    // -------- SHADOW (mode=shadow, or mode=canary for non-canary users) --------
    if (mode === 'shadow') {
      // Build a scoped event logger that writes to cleo.events with userId.
      const eventLogger = async (evt) => {
        try {
          await db.collection('events').insertOne({
            ...evt,
            userId: user._id,
          });
        } catch (e) {
          console.log('[ASSOCIATIVE] shadow log write failed:', e.message);
        }
      };

      // Cache the legacy result so we can both return it and bump access counts.
      let capturedLegacy = null;

      const legacyResp = await runShadowCompare({
        legacyFn: async () => {
          capturedLegacy = await runLegacyPipeline(commonArgs);
          return capturedLegacy.response;
        },
        v3Fn: async () => {
          const v3 = await runV3Pipeline(commonArgs);
          // PATCH 2026-04-25 v5.2.2: pass rankedForShadow (per-source merged) to
          // keep comparison fair vs legacy's two-array shape. v3.ranked is the
          // merged top-N capped at limit total — apples-to-oranges for shadow.
          return { ranked: v3.rankedForShadow, raw: v3.response };
        },
        logEvent: eventLogger,
        context: {
          query,
          apiKey: req.headers && req.headers.authorization
            ? req.headers.authorization.replace(/^Bearer\s+/i, '')
            : (req.query && req.query.apiKey) || null,
          request_id: req.headers && (req.headers['x-request-id'] || req.headers['x-vercel-id']) || null,
          user_id: String(user._id),
          canary_eligible: isCanary,
          mode_reason: reason,
        },
      });

      if (capturedLegacy && capturedLegacy.memoryIdsForAccessUpdate) {
        await bumpAccessCounts(db, capturedLegacy.memoryIdsForAccessUpdate, now);
      }
      return res.status(200).json(legacyResp);
    }

    // Should never reach here
    return res.status(500).json({ error: 'Unknown retrieval mode', mode });

  } catch (err) {
    console.error('Associative error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// Access-count bump — preserved from legacy. Runs once per request, only on
// the memories that the user actually received. Shadow mode does NOT
// double-count (only the returned-to-user path bumps).
async function bumpAccessCounts(db, memoryIds, now) {
  if (!memoryIds || memoryIds.length === 0) return;
  try {
    await db.collection('memories').updateMany(
      { _id: { $in: memoryIds } },
      { $inc: { accessCount: 1 }, $set: { lastAccessedAt: now } }
    );
  } catch (e) {
    console.log('[ASSOCIATIVE] accessCount update failed:', e.message);
  }
}
