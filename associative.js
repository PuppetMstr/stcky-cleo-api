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

// PAYLOAD BUDGET (added Jul 18 2026) -- closes owed item (b) from the Jul 12
// door doctrine. This door once shipped 652 KB at a reader capped near 100 KB
// and the platform chopped the JSON mid-string; Chaos received a fragment that
// looked like a whole document. Nothing in this file had ever measured what it
// SHIPS. Now every response is measured before it leaves, trimmed lowest-rank-
// first if it must be, and stamped LOUD and IN-BAND when anything was left out.
// A fragment must never be able to pass as a whole.
const { enforcePayloadBudget } = require('./_lib/payload-budget');

// REFLECT MODE (opt-in, Jul 22 2026) -- "the pool answers the pour." Hop 1
// feeds the caller's turn VERBATIM through the resolved pipeline; later hops
// are seeded ONLY by the pool's own sentences, never the caller's keywords.
// Sandbox-proven the same morning on a live retrieval failure. Opt in with
// mode=reflect; every existing caller is untouched. See ./reflect-mode.js.
const { reflectRead } = require('./reflect-mode');

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
// MEMORIES RECALL IS NOW OPT-IN TOO (Aug 7 2026, Eli). Same shape as the
// events change three lines above it, and six times the cost.
//
// MEASURED, Atlas Query Insights, 24h ending 2026-08-07 ~11:18Z:
//   cleo.memories $vectorSearch -- 4,570 executions, avg 9.37 s,
//   11.89 HOURS of cluster execution time in a 24-hour day.
//
// COUNTED, Atlas Data Explorer, same morning:
//   cleo.memories holds TEN DOCUMENTS. Ten. Its vector index is 11.34 kB.
//   The newest is from April. They are: "Cleo is alive and Steven is the
//   founder!" (Mar 11), "Jim is connected", a civil complaint belonging to a
//   different userId, a form-fill profile, and six more of the same vintage.
//   Fourteen indexes stand on those ten rows.
//
// The card file was ABOLISHED ON JUL 18 2026 -- every marker was poured into
// the raw pool as a [RETIRED MARKER] object and nothing has been written to
// this collection since. So every associative call has been paying for an
// embedding round trip AND a vector search against ten dead rows, on the same
// default that let the events scan run.
//
// AND THE CLUSTER CANNOT AFFORD IT. objects and memories vector searches sum
// to 49.4 hours of execution a day. An M20 has 2 vCPU -- 48 CPU-hours in a
// day. Vector search alone was asking for more than the box has, which is why
// a limit=1 associative call took 8.6 s, why the ops board took 40 s, and why
// Jul 26 fired a CPU alert that auto-scaling could not answer because M20 is
// the configured ceiling. HALF OF THAT LOAD IS THE TEN ROWS.
//
// Opt back in any time with includeMemories=true. It is a parameter, not a
// deletion, and the collection is untouched.
// --------------------------------------------------------------------------
// --------------------------------------------------------------------------
// Events search path (NEW in v5.2.0 for Rung 3).
// Events are the Phase 0 audit log. They are NOT semantically embedded
// (adapter flags them enrichment.state='skipped'). Lexical only.
// Shadow log events are excluded from recall to prevent recursive noise.
//
// EVENTS RECALL IS NOW OPT-IN (Aug 7 2026, Eli). It used to default ON, and
// that default was costing about 566 GB of disk reads a day for nothing.
//
// MEASURED, from Atlas Performance Advisor on the LocalTravel cluster, 24h
// window ending Aug 7 2026 ~03:45 PT -- five query shapes, all from this one
// function, all against a collection that was RETIRED ON JUL 18 2026:
//
//   169 queries/hour = 4,056 a day
//   avg 86,128 documents scanned, avg 10 returned  (targeting ratio 81,174:1)
//   one shape ran 50x/hr, scanned 91,758 docs and RETURNED ZERO
//   another scanned 91,893 and returned zero
//
// AND AN INDEX CANNOT FIX IT. The $regex below is unanchored and carries the
// 'i' option, so MongoDB cannot seek on it -- every call is a collection scan
// by construction, not by accident of a missing index. Atlas offered two index
// suggestions here; both would only keep the scan inside the index instead of
// the documents. That is buying down a symptom on a collection that should not
// be read at all.
//
// WHY OFF IS SAFE: events carry no embedding, so they never contributed to the
// semantic half of a recall. They only ever entered as lexical hits on `type`
// and `actor` -- two short machine-written fields on an audit log. Reflect mode
// already sets includeEvents:false for exactly this reason ('events are audit
// noise for this purpose'). Legacy mode never searched events at all. Nothing
// that reads the pool for meaning loses anything.
//
// A caller that genuinely wants the audit log can still ask: includeEvents=true
// on GET, or includeEvents:true on POST. It is a parameter, not a deletion.
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

async function runLegacyPipeline({ db, user, query, queryTerms, limit, now, includeMemories, includeObjects, projectId, previousLastSeen, offset, recallDepth }) {
  const scope = { userId: user._id };
  const depth = recallDepth || limit;
  const off = offset || 0;

  const [smallEmbed, largeEmbed] = await Promise.all([
    includeMemories ? embed(query, 'small') : Promise.resolve(null),
    includeObjects  ? embed(query, 'large') : Promise.resolve(null),
  ]);

  const memoryTasks = [];
  if (includeMemories) {
    memoryTasks.push(smallEmbed && smallEmbed.embedding
      ? memoryVectorSearch(db, scope, smallEmbed.embedding, depth)
      : Promise.resolve(null));
    memoryTasks.push(memoryKeywordSearch(db, scope, queryTerms, depth));
  } else {
    memoryTasks.push(Promise.resolve(null), Promise.resolve([]));
  }

  const objectTasks = [];
  if (includeObjects) {
    objectTasks.push(largeEmbed && largeEmbed.embedding
      ? objectsVectorSearch(db, scope, largeEmbed.embedding, depth)
      : Promise.resolve(null));
    objectTasks.push(objectsKeywordSearch(db, scope, queryTerms, depth));
  } else {
    objectTasks.push(Promise.resolve(null), Promise.resolve([]));
  }

  const [memVec, memKw, objVec, objKw] = await Promise.all([...memoryTasks, ...objectTasks]);

  // RANK THE WHOLE RECALL POOL, THEN CUT THE PAGE OUT OF IT. The old code
  // ranked and then .slice(0, limit) -- everything past the limit was computed
  // and thrown in the bin with no way to ask for it. Now the tail is the NEXT
  // PAGE. See the cursor block in the handler.
  const allMemories = includeMemories ? mergeAndRankMemories(memVec, memKw, queryTerms, now) : [];
  const allObjects  = includeObjects  ? mergeAndRankObjects(objVec, objKw, queryTerms, now)  : [];
  const rankedMemories = allMemories.slice(off, off + limit);
  const rankedObjects  = allObjects.slice(off, off + limit);

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
    rankedTotal: Math.max(allMemories.length, allObjects.length),
    // If the ranker produced fewer rows than we asked the DB for, the DB had no
    // more to give -- we have seen the bottom. If it came back AT depth, there
    // is more behind it and "exhausted" would be a lie.
    recallSaturated: Math.max(allMemories.length, allObjects.length) >= depth,
  };
}

// --------------------------------------------------------------------------
// V3 pipeline (Rung 3).
// --------------------------------------------------------------------------

async function runV3Pipeline({ db, user, query, queryTerms, limit, now, includeMemories, includeObjects, includeEvents, projectId, previousLastSeen, rung4, offset, recallDepth }) {
  const scope = { userId: user._id };
  const depth = recallDepth || limit;
  const off = offset || 0;

  const [smallEmbed, largeEmbed] = await Promise.all([
    includeMemories ? embed(query, 'small') : Promise.resolve(null),
    includeObjects  ? embed(query, 'large') : Promise.resolve(null),
  ]);

  const memoryTasks = [];
  if (includeMemories) {
    memoryTasks.push(smallEmbed && smallEmbed.embedding
      ? memoryVectorSearch(db, scope, smallEmbed.embedding, depth)
      : Promise.resolve(null));
    memoryTasks.push(memoryKeywordSearch(db, scope, queryTerms, depth));
  } else {
    memoryTasks.push(Promise.resolve(null), Promise.resolve([]));
  }

  const objectTasks = [];
  if (includeObjects) {
    objectTasks.push(largeEmbed && largeEmbed.embedding
      ? objectsVectorSearch(db, scope, largeEmbed.embedding, depth)
      : Promise.resolve(null));
    objectTasks.push(objectsKeywordSearch(db, scope, queryTerms, depth));
  } else {
    objectTasks.push(Promise.resolve(null), Promise.resolve([]));
  }

  const eventTasks = [];
  if (includeEvents) {
    eventTasks.push(eventsKeywordSearch(db, user._id, queryTerms, depth));
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
  // Rank the WHOLE pool, then cut the page. The tail is the next page, not
  // the bin. rankCandidates takes a limit, so ask it for everything we have.
  const rankedAll = rankCandidates(prioritizedCandidates, signalsMap, {
    nowMs: now.getTime(),
    limit: prioritizedCandidates.length || 1,
  });
  const ranked = rankedAll.slice(off, off + limit);

  // --- ORGANISM BETA: handle handoff redirects ---
  const redirectedRanked = await handlePointsToRedirects(ranked, db, user._id);

  // --- Rank per source (for legacy back-compat arrays) ---
  const memCandidates = prioritizedCandidates.filter(c => c.meta.source_collection === 'memories');
  const objCandidates = prioritizedCandidates.filter(c => c.meta.source_collection === 'objects');
  const evtCandidates = prioritizedCandidates.filter(c => c.meta.source_collection === 'events');
  const page = (arr) => rankCandidates(arr, signalsMap, { nowMs: now.getTime(), limit: arr.length || 1 }).slice(off, off + limit);
  const memRanked = page(memCandidates);
  const objRanked = page(objCandidates);
  const evtRanked = page(evtCandidates);

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
    rankedTotal: rankedAll.length,
    // Saturated means the DB gave us as many rows as we asked for, so there is
    // more behind them. Only an UNsaturated recall can honestly say "that's all".
    recallSaturated: Math.max(objCandidates.length, memCandidates.length) >= depth,
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

// ===========================================================================
// declareSlice() -- RETIRED Jul 21 2026. Steven: "Any time an answer contains
// the word slices, it makes me suspicious."
//
// He is right to be. This function shipped a field called slice_notice on every
// response that said, in effect: this is a floor, not a total, there are
// probably more records behind it, now go ask again in different words until
// new queries stop returning new records.
//
// Every word of that was true. It was still the wrong artifact. It was a SIGN,
// not a WALL -- it described the limitation loudly instead of removing it, and
// it handed the actual work to the reader as a rule the reader has to remember.
// The record of this system is unambiguous about what those are worth: no rule
// has ever held, and no wall has ever failed. declareSlice was written on Jul 19
// and flagged as "a louder label on the same slice" two days later, by which
// time it was already the thing it warned about.
//
// WHAT REPLACED IT: `walk`, from the cursor block above. Where slice_notice
// announced a suspicion, walk reports measurements and finishes the job:
//   ranked_pool  how many records this question actually matched
//   returned     how many came back on this page
//   next_cursor  the exact handle for the rest -- not advice, a mechanism
//   exhausted    a machine verdict, true only when the database returned
//                fewer rows than it was asked for
//
// The stopping rule the notice used to ask a reader to follow is now performed
// by the door itself. Nobody has to remember anything.
//
// Removing this field is safe: it was additive advisory metadata. Checked the
// in-house readers -- substrate_tools.js and chat.js reach the pool through
// direct DB access, not this response shape, and the crons read objects,
// candidates, and payload_budget. Nothing consumed slice_notice.
// ===========================================================================

// ===========================================================================
// THE CURSOR. ABSENCE BECOMES A MACHINE VERDICT. Added Jul 21 2026, on Steven:
// "Just because it works does not mean it is good enough."
//
// WHAT WAS STILL WRONG AFTER THE VECTOR STRIP AND THE DEDUPE. Both of those
// made each ANSWER whole. Neither made the SEARCH FINISHABLE.
//
// MEASURED THE SAME MORNING: 63 query wordings, 1,813 unique records, and the
// new-records-per-query curve NEVER FLATTENED -- query 63 still returned 16 it
// had never seen. Every ask was capped by `limit` and there was no way to say
// "give me the next page." So exhaustion was unreachable, which means absence
// could never be earned, which means "I can't find it" could never honestly
// mean "it isn't there."
//
// That is the whole promise of the product, and the door could not keep it.
//
// The Jul 12 doctrine's third guarantee -- ABSENCE IS EARNED -- put that work
// on the READER: three distinct paths, in the person's own words, whole bodies.
// A rule the reader has to remember. We know exactly what those are worth. The
// record of this system contains no rule that ever held and no wall that ever
// failed.
//
// SO THE DOOR DOES IT NOW, MECHANICALLY:
//   * The ranker ranks the WHOLE recall pool and the page is cut out of it.
//     The tail is no longer thrown away -- it is `next_cursor`.
//   * When the payload budget has to trim, the trim is not a LOSS. The cursor
//     is computed AFTER the budget, from what actually SURVIVED, so whatever
//     got cut is simply the first thing on the next page.
//   * `exhausted: true` is stamped only when the recall pool came back UNDER
//     the depth we asked the database for. That is the only honest proof there
//     is nothing behind it. If the DB returned exactly as many rows as we
//     asked for, there is more, and the door says so.
//
// A CURSOR IS BOUND TO ITS QUESTION. It carries a hash of the query. Handing
// page 2 of one question to a different question would silently interleave two
// result sets -- a fragment passing as a whole, in a new costume. A mismatched
// cursor is REFUSED, loudly, rather than honored wrongly.
//
// COST NOTE, HONESTLY: paging deeper costs more, because reaching offset N
// means asking the database for N+limit rows (this door is superlinear in
// depth: 20 -> 3.3s, 60 -> 8.9s, 200 -> 103s). Page 1 costs exactly what it
// costs today. You only pay for depth you actually walk to.
// ===========================================================================
// PAGING MUST HAPPEN OVER A POOL THAT DOES NOT MOVE. Corrected Jul 21 2026,
// minutes after the cursor first shipped, because the first live walk was WRONG
// and the walk itself is what caught it.
//
// MEASURED ON THE LIVE DOOR, six pages of one question:
//     page 1  offset  0  returned 25  new 25  OVERLAP  0
//     page 2  offset 25  returned 15  new  9  OVERLAP  6
//     page 3  offset 40  returned 17  new  8  OVERLAP  9
//     page 4  offset 57  returned 16  new 10  OVERLAP  6
//     page 5  offset 73  returned 21  new 12  OVERLAP  9
//     page 6  offset 94  returned 21  new 10  OVERLAP 11
//     74 unique records, 41 DUPLICATES. Overlap must be zero. It was not.
//
// THE CAUSE: recallDepth was computed as offset+limit, so every page asked the
// database for a DIFFERENT, LARGER pool -- 25 rows, then 50, then 65. A vector
// search at depth 50 is not "the depth-25 result plus 25 more"; it re-ranks a
// different set. Slicing by offset across a pool that changes shape under you
// hands back records you already had and silently skips others.
//
// A reader who trusted that walk would have paid for 41 records twice and still
// been missing rows -- the old disease with a page number on it.
//
// THE FIX: the recall depth is chosen ONCE, on the first page, and CARRIED IN
// THE CURSOR. Every page of a walk searches the identical pool, so the ranking
// is identical and offset slicing is exact. Same question, same pool, same
// order, disjoint pages.
//
// COST, HONESTLY: page one now searches deeper than it strictly needs to, so a
// single-shot query is slower than it was (limit 10 asks the DB for 40). That
// is the price of pages that do not lie, and it is cheaper than shipping the
// same record six times. A caller that knows it will never walk can pin the
// cost back down with an explicit depth= parameter.
const DEFAULT_DEPTH_SPAN = 4;
const MIN_WALK_DEPTH = 40;
const MAX_WALK_DEPTH = 200;

function resolveDepth(limit, requested) {
  if (requested && requested > 0) return Math.min(requested, MAX_WALK_DEPTH);
  return Math.min(Math.max(limit * DEFAULT_DEPTH_SPAN, MIN_WALK_DEPTH), MAX_WALK_DEPTH);
}

const crypto = require('crypto');

function queryFingerprint(query) {
  return crypto.createHash('sha1').update(String(query || '')).digest('hex').slice(0, 12);
}

function encodeCursor(query, offset, depth) {
  return Buffer.from(JSON.stringify({ q: queryFingerprint(query), o: offset, d: depth }), 'utf8')
    .toString('base64url');
}

function decodeCursor(cursor, query) {
  if (!cursor) return { offset: 0, depth: null };
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
  } catch (e) {
    return { offset: 0, depth: null, error: 'CURSOR UNREADABLE. It was not produced by this door. Starting from the beginning rather than guessing.' };
  }
  if (!parsed || typeof parsed.o !== 'number' || parsed.o < 0) {
    return { offset: 0, depth: null, error: 'CURSOR MALFORMED. Starting from the beginning rather than guessing.' };
  }
  if (parsed.q !== queryFingerprint(query)) {
    return {
      offset: 0,
      depth: null,
      error: 'CURSOR BELONGS TO A DIFFERENT QUESTION. This cursor was issued for another query; ' +
             'honoring it here would splice two result sets together and hand you the seam as if it were whole. ' +
             'REFUSED -- this response starts at the beginning of THIS question.',
    };
  }
  // The depth the walk began at. Carrying it is what keeps every page of this
  // walk looking at the same pool, which is what makes the pages disjoint.
  return { offset: parsed.o, depth: (typeof parsed.d === 'number' && parsed.d > 0) ? parsed.d : null };
}

// Runs AFTER the payload budget, on what actually survived. This ordering is
// the whole trick: a trimmed item is not lost, it is the next page.
function attachCursor(response, { query, offset, limit, depth, rankedTotal, recallSaturated, cursorError }) {
  const survived = Math.max(
    Array.isArray(response.objects)    ? response.objects.length    : 0,
    Array.isArray(response.memories)   ? response.memories.length   : 0,
    Array.isArray(response.candidates) ? response.candidates.length : 0
  );

  const nextOffset = offset + survived;
  const morePages  = rankedTotal > nextOffset && survived > 0;
  // Honest exhaustion: we have walked past the end of the ranked pool AND the
  // pool itself was not saturated (the database had less than we asked for).
  const exhausted  = !morePages && !recallSaturated;

  response.walk = {
    offset,
    returned: survived,
    ranked_pool: rankedTotal,
    recall_depth: depth,
    exhausted,
    next_cursor: morePages ? encodeCursor(query, nextOffset, depth) : null,
    cursor_error: cursorError || null,
    read_this: exhausted
      ? 'EXHAUSTED. This is the end of what this question matches, and the database came back ' +
        'with LESS than it was asked for -- which is the only honest proof there is nothing behind it. ' +
        'For THIS wording, absence is now earned. Other wordings may still surface other records; ' +
        'the pool has no geography, only what connects.'
      : morePages
        ? 'MORE BEHIND THIS. Call this door again with cursor=' + encodeCursor(query, nextOffset, depth) +
          ' to get the next page. Every page of a walk searches the same pool at the same depth, so ' +
          'pages do not overlap. Anything the payload budget trimmed is NOT lost -- it is the first ' +
          'thing on that page. Do NOT conclude absence until a page comes back with exhausted: true.'
        : 'NOT EXHAUSTED. The pool came back full at the depth the database was asked for (' + depth +
          '), which means there are more records behind it that this recall never saw. Ask again in ' +
          'different words, or raise depth=, before concluding anything is absent.',
  };
  return response;
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await auth(req);
  // THE WALL (Aug 1 2026). A scoped key cannot reach pool content -- see _lib/wall.js.
  if (require('./_lib/wall').wall(req, res, user, '/api/associative')) return;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const db = await getDb();

  const previousLastSeen = user.lastSeen || null;
  await db.collection('users').updateOne(
    { _id: user._id },
    { $set: { lastSeen: new Date() } }
  );

  let query, limit, projectId, includeObjects, includeMemories, includeEvents, maxBytes, cursor, depthParam, modeParam;
  if (req.method === 'POST') {
    query = req.body.query;
    limit = req.body.limit || 10;
    projectId = req.body.projectId;
    maxBytes = parseInt(req.body.maxBytes, 10) || null;
    cursor = req.body.cursor || null;
    depthParam = parseInt(req.body.depth, 10) || null;
    modeParam = req.body.mode || null;
    includeObjects  = req.body.includeObjects  !== false;
    includeMemories = req.body.includeMemories === true;   // OPT-IN. See MEMORIES RECALL note below.
    includeEvents   = req.body.includeEvents   === true;   // OPT-IN. See EVENTS RECALL note below.
  } else if (req.method === 'GET') {
    query = req.query.query;
    limit = parseInt(req.query.limit) || 10;
    projectId = req.query.projectId;
    maxBytes = parseInt(req.query.maxBytes, 10) || null;
    cursor = req.query.cursor || null;
    depthParam = parseInt(req.query.depth, 10) || null;
    modeParam = req.query.mode || null;
    includeObjects  = req.query.includeObjects  !== 'false';
    includeMemories = req.query.includeMemories === 'true';  // OPT-IN. See MEMORIES RECALL note below.
    includeEvents   = req.query.includeEvents   === 'true';  // OPT-IN. See EVENTS RECALL note below.
  } else {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // PAYLOAD BUDGET IS FOR READERS THAT HAVE A CAP -- AND ONLY THOSE.
  //
  // Found live Jul 18 2026, hours after the budget shipped: the queue-feeder's
  // content-addressed reads ask for limit=200 with whole bodies, which is far
  // past 70 KB. The budget dropped most of the result, and the feeder -- which
  // reads suppression, prior contact, and the LEAD reserve this way -- went
  // half-blind. Its receipt reported "0 recovered by content read" and
  // "reserve: 0 SENDABLE" when the pool almost certainly still held leads.
  //
  // TWO CORRECT FIXES SHIPPED THE SAME MORNING WERE FIGHTING EACH OTHER. The
  // budget was written to protect a ChatGPT Action capped near 100 KB. It was
  // then applied to EVERY caller, including our own crons, which have no cap at
  // all and genuinely need the whole result to do their job.
  //
  // SAFE BY DEFAULT, EXPLICIT TO OPT OUT: a caller that says nothing still gets
  // the protective 70 KB ceiling, so nothing can regress into the Jul 12 shape.
  // A caller that KNOWS its own limits may declare them with maxBytes. Our crons
  // declare a large one; Chaos declares nothing and stays protected.
  const budgetOpts = maxBytes ? { maxBytes } : {};

  if (!query) return res.status(400).json({ error: 'query parameter required' });

  // WHERE THIS PAGE STARTS, AND HOW DEEP THE WHOLE WALK LOOKS. A cursor is
  // bound to its question; a mismatched or unreadable one is refused out loud
  // and we start at the beginning rather than honoring it wrongly. The DEPTH is
  // fixed on page one and carried, so every page of a walk searches the same
  // unmoving pool -- that is what makes the pages disjoint.
  const cur = decodeCursor(cursor, query);
  const offset = cur.offset;
  const recallDepth = cur.depth || resolveDepth(limit, depthParam);

  try {
    const now = new Date();
    const queryTerms = query.split(/\s+/).filter(t => t.length > 2);

    const { mode, isCanary, reason } = resolveMode(user);
    const rung4 = resolveRung4Mode(user);

    const commonArgs = {
      db, user, query, queryTerms, limit, now,
      includeMemories, includeObjects, includeEvents,
      projectId, previousLastSeen,
      rung4, offset, recallDepth,
    };

    // The cursor is attached AFTER the budget, on what actually survived the
    // trim -- so a trimmed record is never a loss, it is the next page.
    const finish = (response, rankedTotal, recallSaturated) =>
      attachCursor(
        enforcePayloadBudget(response, budgetOpts),
        { query, offset, limit, depth: recallDepth, rankedTotal: rankedTotal || 0, recallSaturated: !!recallSaturated, cursorError: cur.error }
      );

    // REFLECT MODE -- runs the resolved pipeline as its rank function, so it
    // inherits auth, scope, ranking, and every future pipeline improvement for
    // free. Objects only (memories store is retired; events are audit noise
    // for this purpose). Returns its own field shape: activation-ranked,
    // conversation stratum first. Budget still enforced on the way out.
    if (modeParam === 'reflect') {
      const rankFn = async (q, opts = {}) => {
        const args = {
          ...commonArgs,
          query: q,
          queryTerms: q.split(/\s+/).filter(t => t.length > 2),
          offset: opts.offset || 0,
          recallDepth: opts.depth || recallDepth,
          includeMemories: false,
          includeEvents: false,
        };
        const r = (mode === 'legacy')
          ? await runLegacyPipeline(args)
          : await runV3Pipeline(args);
        return r.response;
      };
      const field = await reflectRead(query, rankFn, {});
      return res.status(200).json(enforcePayloadBudget(field, budgetOpts));
    }

    if (mode === 'legacy') {
      const r = await runLegacyPipeline(commonArgs);
      await bumpAccessCounts(db, r.memoryIdsForAccessUpdate, now);
      return res.status(200).json(finish(r.response, r.rankedTotal, r.recallSaturated));
    }

    if (mode === 'v3') {
      const r = await runV3Pipeline(commonArgs);
      await bumpAccessCounts(db, r.memoryIdsForAccessUpdate, now);
      return res.status(200).json(finish(r.response, r.rankedTotal, r.recallSaturated));
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
      return res.status(200).json(finish(
        legacyResp,
        capturedLegacy && capturedLegacy.rankedTotal,
        capturedLegacy && capturedLegacy.recallSaturated
      ));
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
