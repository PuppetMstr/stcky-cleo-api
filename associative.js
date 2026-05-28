/**
 * STCKY Associative Recall v5.3.0 — ORGANISM BETA PHASE 1
 *
 * v5.3.0 (2026-05-01):
 *   - ORGANISM BETA PHASE 1: First-class substrate kinds with retrieval priority
 *     and handoff redirect support. Extends v5.2.3 with organism-specific handling:
 *       * retrieval_priority=anchor for now_state kinds (always surface in top-3)
 *       * points_to redirect for handoff kinds (inline target memory)
 *       * bundle kind recognition (preparation for Phase 4)
 *   - Backward compatible: existing queries work unchanged, organism features
 *     activate when organism-category memories are present in results.
 *   - Built on Rung 4 foundation: correction resolver remains active, organism
 *     kinds flow through same candidate generation -> resolver -> ranking pipeline.
 *
 * v5.3.1 (2026-05-16, Eli):
 *   - Hybrid-search primitives extracted to ./_lib/hybrid-search.js for reuse
 *     by /v1/read mode=semantic. Helpers now imported instead of defined inline.
 *
 * v5.3.2 (2026-05-16, Eli):
 *   - hybrid-search primitives now take scope object instead of raw userId.
 *     Call sites here pass { userId: user._id } as scope. Enables project-
 *     scoped search elsewhere (memory.js action=search).
 *
 * (v5.2.3 changelog preserved below...)
 */

const { getDb, auth, cors, ObjectId } = require('./_lib/auth');
const { embed } = require('./_lib/embeddings');
const {
  memoryVectorSearch,
  memoryKeywordSearch,
  objectsVectorSearch,
  objectsKeywordSearch,
  mergeAndRankMemories,
  mergeAndRankObjects,
  calculateKeywordScore,
  calculateTemporalScore,
  calculateObjectTemporalScore,
} = require('./_lib/hybrid-search');

// Rung 3 helpers (inert if RETRIEVAL_V3_MODE is 'off')
const {
  memoryToCanonical,
  objectToCanonical,
  eventToCanonical,
} = require('./_lib/event-adapters');
const { rankCandidates }   = require('./_lib/retrieval-ranker');
const { runShadowCompare } = require('./_lib/retrieval-shadow');

// Rung 4 helpers (inert if RUNG_4_MODE is 'off')
const { resolveCorrections, shadowDivergence } = require('./_lib/correction-resolver');

// --------------------------------------------------------------------------
// ORGANISM BETA: Retrieval priority and redirect handlers
// --------------------------------------------------------------------------

/**
 * Apply retrieval priority boosts for organism first-class kinds.
 */
function applyRetrievalPriority(candidates, nowMs) {
  const boosted = candidates.map(c => {
    if (c.retrieval_priority === 'anchor' && c.kind === 'now_state') {
      const ageMs = nowMs - new Date(c.ts_human).getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);

      let boost = 100;
      if (ageDays > 1) boost = 80;
      if (ageDays > 2) boost = 60;
      if (ageDays > 7) boost = 40;

      return {
        ...c,
        artificial_boost: boost,
        boost_reason: `anchor_priority_now_state_age_${ageDays.toFixed(1)}d`
      };
    }
    return c;
  });

  return boosted;
}

/**
 * Handle points_to redirects for handoff kinds.
 */
async function handlePointsToRedirects(rankedResults, db, userId) {
  const redirected = [];

  for (const result of rankedResults) {
    const candidate = result.candidate;

    if (candidate.kind === 'handoff' && candidate.points_to) {
      try {
        const targetQuery = {
          userId: userId,
          category: candidate.points_to.category,
          key: candidate.points_to.key
        };

        const targetDoc = await db.collection('memories').findOne(targetQuery);

        if (targetDoc) {
          const targetCanonical = memoryToCanonical(targetDoc);
          if (targetCanonical) {
            redirected.push({
              ...result,
              candidate: {
                ...targetCanonical,
                redirected_from: {
                  handoff_id: candidate.event_id,
                  handoff_key: candidate.meta.legacy_fields.key,
                  redirect_timestamp: new Date().toISOString()
                }
              }
            });
            continue;
          }
        }

        redirected.push({
          ...result,
          candidate: {
            ...candidate,
            redirect_warning: `Target not found: ${candidate.points_to.category}/${candidate.points_to.key}`
          }
        });

      } catch (error) {
        console.log('[ORGANISM] Handoff redirect failed:', error.message);
        redirected.push(result);
      }
    } else {
      redirected.push(result);
    }
  }

  return redirected;
}

// --------------------------------------------------------------------------
// Search primitives (memory*Search, objects*Search, mergeAndRank*,
// calculate*Score) now live in ./_lib/hybrid-search.js -- imported above.
// --------------------------------------------------------------------------

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
        type: { $ne: 'retrieval_shadow_compared' },
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
// LEGACY pipeline -- v5.1.0 logic extracted into a helper.
// --------------------------------------------------------------------------

async function runLegacyPipeline({ db, user, query, queryTerms, limit, now, includeMemories, includeObjects, projectId, previousLastSeen }) {
  const scope = { userId: user._id };

  const [smallEmbed, largeEmbed] = await Promise.all([
    includeMemories ? embed(query, 'small') : Promise.resolve(null),
    includeObjects  ? embed(query, 'large') : Promise.resolve(null),
  ]);

  const memoryTasks = [];
  if (includeMemories) {
    memoryTasks.push(smallEmbed && smallEmbed.embedding
      ? memoryVectorSearch(db, scope, smallEmbed.embedding, limit)
      : Promise.resolve(null));
    memoryTasks.push(memoryKeywordSearch(db, scope, queryTerms, limit));
  } else {
    memoryTasks.push(Promise.resolve(null), Promise.resolve([]));
  }

  const objectTasks = [];
  if (includeObjects) {
    objectTasks.push(largeEmbed && largeEmbed.embedding
      ? objectsVectorSearch(db, scope, largeEmbed.embedding, limit)
      : Promise.resolve(null));
    objectTasks.push(objectsKeywordSearch(db, scope, queryTerms, limit));
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
// V3 pipeline (Rung 3).
// --------------------------------------------------------------------------

async function runV3Pipeline({ db, user, query, queryTerms, limit, now, includeMemories, includeObjects, includeEvents, projectId, previousLastSeen, rung4 }) {
  const scope = { userId: user._id };

  const [smallEmbed, largeEmbed] = await Promise.all([
    includeMemories ? embed(query, 'small') : Promise.resolve(null),
    includeObjects  ? embed(query, 'large') : Promise.resolve(null),
  ]);

  const memoryTasks = [];
  if (includeMemories) {
    memoryTasks.push(smallEmbed && smallEmbed.embedding
      ? memoryVectorSearch(db, scope, smallEmbed.embedding, limit)
      : Promise.resolve(null));
    memoryTasks.push(memoryKeywordSearch(db, scope, queryTerms, limit));
  } else {
    memoryTasks.push(Promise.resolve(null), Promise.resolve([]));
  }

  const objectTasks = [];
  if (includeObjects) {
    objectTasks.push(largeEmbed && largeEmbed.embedding
      ? objectsVectorSearch(db, scope, largeEmbed.embedding, limit)
      : Promise.resolve(null));
    objectTasks.push(objectsKeywordSearch(db, scope, queryTerms, limit));
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

  // Events (lexical only)
  for (const e of (evtKw || [])) {
    const c = eventToCanonical(e);
    if (!c) continue;
    const kwScore = calculateKeywordScore(e, queryTerms, ['type', 'actor']);
    candidates.push(c);
    signalsMap.set(c.event_id, { semantic: 0, lexical: kwScore / 40 });
  }

  // --- RUNG 4: resolve corrections (gated by RUNG_4_MODE) ---
  let workingCandidates = candidates;
  let rung4DivergenceLog = null;

  if (rung4 && rung4.active) {
    workingCandidates = resolveCorrections(candidates);
  } else if (rung4 && rung4.shadow) {
    const resolved = resolveCorrections(candidates);
    rung4DivergenceLog = shadowDivergence(candidates, resolved);
  }

  // --- ORGANISM BETA: apply retrieval priority boosts ---
  const prioritizedCandidates = applyRetrievalPriority(workingCandidates, now.getTime());

  // --- Rank (merged) ---
  const ranked = rankCandidates(prioritizedCandidates, signalsMap, {
    nowMs: now.getTime(),
    limit,
  });

  // --- ORGANISM BETA: handle handoff redirects ---
  const redirectedRanked = await handlePointsToRedirects(ranked, db, user._id);

  // --- Rank per source (for legacy back-compat arrays) ---
  const memCandidates = prioritizedCandidates.filter(c => c.meta.source_collection === 'memories');
  const objCandidates = prioritizedCandidates.filter(c => c.meta.source_collection === 'objects');
  const evtCandidates = prioritizedCandidates.filter(c => c.meta.source_collection === 'events');
  const memRanked = rankCandidates(memCandidates, signalsMap, { nowMs: now.getTime(), limit });
  const objRanked = rankCandidates(objCandidates, signalsMap, { nowMs: now.getTime(), limit });
  const evtRanked = rankCandidates(evtCandidates, signalsMap, { nowMs: now.getTime(), limit });

  const candidatesOut = redirectedRanked.map(r => ({
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
    artificial_boost:  r.candidate.artificial_boost || undefined,
    boost_reason:      r.candidate.boost_reason || undefined,
    redirected_from:   r.candidate.redirected_from || undefined,
    redirect_warning:  r.candidate.redirect_warning || undefined,
  }));

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

  if (rung4DivergenceLog && rung4DivergenceLog.filtered_count > 0) {
    db.collection('events').insertOne({
      type: 'rung_4_shadow_divergence',
      userId: user._id,
      actor: 'system',
      payload: { ...rung4DivergenceLog, query, retrieval_mode: 'v3' },
      createdAt: new Date(),
      metadata: { ts_human: new Date().toISOString() },
    }).catch(e => console.log('[ASSOCIATIVE] rung 4 shadow log failed:', e.message));
  }

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
      organism_features: {
        priority_boost_applied: prioritizedCandidates.some(c => c.artificial_boost),
        handoff_redirects_applied: candidatesOut.some(c => c.redirected_from),
        first_class_kinds_detected: candidatesOut.filter(c => ['now_state', 'bundle', 'handoff'].includes(c.kind)).length
      }
    },
    memoryIdsForAccessUpdate: legacyMemories.map(m => m._id),
    ranked: redirectedRanked,
    rankedForShadow: [...memRanked, ...objRanked, ...evtRanked],
  };
}

// --------------------------------------------------------------------------
// Mode resolution (Rung 3)
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

function resolveRung4Mode(user) {
  const raw = String(process.env.RUNG_4_MODE || 'off').toLowerCase();
  const canaryIds = String(process.env.CANARY_USER_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const userIdStr = user && user._id && String(user._id);
  const isCanary = userIdStr && canaryIds.includes(userIdStr);

  if (raw === 'on')     return { active: true,  shadow: false, reason: 'on' };
  if (raw === 'canary') return { active: isCanary, shadow: !isCanary, reason: isCanary ? 'canary-on' : 'canary-shadow' };
  if (raw === 'shadow') return { active: false, shadow: true,  reason: 'shadow' };
  return { active: false, shadow: false, reason: 'off' };
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
    includeEvents   = req.body.includeEvents   !== false;
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
    const rung4 = resolveRung4Mode(user);

    const commonArgs = {
      db, user, query, queryTerms, limit, now,
      includeMemories, includeObjects, includeEvents,
      projectId, previousLastSeen,
      rung4,
    };

    if (mode === 'legacy') {
      const { response, memoryIdsForAccessUpdate } = await runLegacyPipeline(commonArgs);
      await bumpAccessCounts(db, memoryIdsForAccessUpdate, now);
      return res.status(200).json(response);
    }

    if (mode === 'v3') {
      const { response, memoryIdsForAccessUpdate } = await runV3Pipeline(commonArgs);
      await bumpAccessCounts(db, memoryIdsForAccessUpdate, now);
      return res.status(200).json(response);
    }

    if (mode === 'shadow') {
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

      let capturedLegacy = null;

      const legacyResp = await runShadowCompare({
        legacyFn: async () => {
          capturedLegacy = await runLegacyPipeline(commonArgs);
          return capturedLegacy.response;
        },
        v3Fn: async () => {
          const v3 = await runV3Pipeline(commonArgs);
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

    return res.status(500).json({ error: 'Unknown retrieval mode', mode });

  } catch (err) {
    console.error('Associative error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

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
