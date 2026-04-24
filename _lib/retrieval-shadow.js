// cleo-api/_lib/retrieval-shadow.js
// ---------------------------------------------------------------------------
// RUNG 3 — Shadow-mode runner
//
// Runs the legacy retrieval pipeline and the v3 pipeline in parallel for the
// same query, returns the LEGACY result to the caller unchanged, and emits
// a divergence log so operators can compare the two rankings before flipping
// canary/on.
//
// Called by associative.js when process.env.RETRIEVAL_V3_MODE === 'shadow'.
// Also used when mode === 'canary' for non-canary users (they see legacy,
// we still log divergence against them to expand the sample).
//
// This module does NOT decide which mode to run — that's associative.js.
// It just executes both paths, compares, and writes the log event.
// ---------------------------------------------------------------------------

'use strict';

// --- Constants --------------------------------------------------------------

// How many top results from each pipeline we compare. Deeper than the
// user-visible limit so we still see ranking churn in positions 6-10.
const COMPARE_DEPTH = 10;

// Write shadow logs as events to the existing Phase 0 event log. Type is
// namespaced so operators can filter. Alternative would be a new
// cleo.shadow_retrieval collection; keeping it in events means one ledger
// and Rung 3 recall can already see the divergence history itself.
const SHADOW_EVENT_TYPE = 'retrieval_shadow_compared';

// --- Helpers ----------------------------------------------------------------

/**
 * Extract the comparable id for a legacy-result entry. Legacy returns come
 * in the shape { memories: [...], objects: [...] } and each entry has a
 * native id (_id for memories, object_id for objects). We normalize to the
 * same prefixed form that the v3 adapters produce so IDs align for compare.
 */
function legacyEntryToComparableId(entry, bucket) {
  if (!entry) return null;
  if (bucket === 'memories') {
    const id = entry._id || entry.id;
    return id ? `mem_${String(id)}` : null;
  }
  if (bucket === 'objects') {
    const id = entry.object_id || entry._id;
    return id ? `obj_${String(id)}` : null;
  }
  if (bucket === 'events') {
    const id = entry._id || entry.id;
    return id ? `evt_${String(id)}` : null;
  }
  return null;
}

/**
 * Flatten a legacy response into a single ordered list of comparable ids.
 * Legacy response shape (current production):
 *   { memories: [...], objects: [...] }
 * Legacy has no cross-bucket ranking, so we interleave by position within
 * each bucket (memory[0], object[0], memory[1], object[1], ...) — this is
 * the closest thing legacy has to a "merged top-N". It's imperfect but
 * that imperfection is exactly why Rung 3 exists.
 */
function flattenLegacyRanking(legacyResponse, depth) {
  const mems = Array.isArray(legacyResponse.memories) ? legacyResponse.memories : [];
  const objs = Array.isArray(legacyResponse.objects)  ? legacyResponse.objects  : [];
  const maxLen = Math.max(mems.length, objs.length);
  const out = [];
  for (let i = 0; i < maxLen && out.length < depth; i++) {
    if (i < mems.length) {
      const id = legacyEntryToComparableId(mems[i], 'memories');
      if (id) out.push(id);
    }
    if (i < objs.length && out.length < depth) {
      const id = legacyEntryToComparableId(objs[i], 'objects');
      if (id) out.push(id);
    }
  }
  return out;
}

/**
 * Flatten a v3 ranked response (from rankCandidates) into comparable ids
 * in score-descending order.
 */
function flattenV3Ranking(v3Ranked, depth) {
  return v3Ranked
    .slice(0, depth)
    .map(r => r && r.candidate && r.candidate.event_id)
    .filter(Boolean);
}

// --- Divergence metrics -----------------------------------------------------

/**
 * Compute divergence metrics between two ranked id lists.
 *   overlap_topN: count of ids present in both top-N lists
 *   jaccard:      |A ∩ B| / |A ∪ B|
 *   rank_delta:   sum of |rank_legacy - rank_v3| over ids present in both
 *                 (higher = bigger reordering)
 *   only_in_legacy: ids that legacy surfaced but v3 did not
 *   only_in_v3:     ids that v3 surfaced but legacy did not
 */
function computeDivergence(legacyIds, v3Ids) {
  const legacySet = new Set(legacyIds);
  const v3Set     = new Set(v3Ids);
  const overlap   = legacyIds.filter(id => v3Set.has(id));
  const union     = new Set([...legacyIds, ...v3Ids]);
  const jaccard   = union.size === 0 ? 1 : overlap.length / union.size;

  let rank_delta = 0;
  for (const id of overlap) {
    const lr = legacyIds.indexOf(id);
    const vr = v3Ids.indexOf(id);
    rank_delta += Math.abs(lr - vr);
  }

  return {
    overlap_count: overlap.length,
    jaccard,
    rank_delta,
    only_in_legacy: legacyIds.filter(id => !v3Set.has(id)),
    only_in_v3:     v3Ids.filter(id => !legacySet.has(id)),
    compared_depth: Math.max(legacyIds.length, v3Ids.length),
  };
}

// --- Main entry point -------------------------------------------------------

/**
 * Run legacy + v3 pipelines in parallel, return legacy, log divergence.
 *
 * @param {Object} args
 * @param {Function} args.legacyFn - async () => legacy response
 * @param {Function} args.v3Fn     - async () => { ranked: [...], raw: ... }
 *                                     ranked is output of rankCandidates()
 * @param {Function} args.logEvent - async (eventDoc) => void. Writes the
 *                                   shadow comparison as an event. Passed
 *                                   in so this module has no DB dependency.
 * @param {Object}   args.context  - { query, apiKey, request_id, user_id? }
 * @returns {Promise<Object>} the legacy response (unchanged)
 */
async function runShadowCompare(args) {
  const { legacyFn, v3Fn, logEvent, context } = args;

  const t0 = Date.now();
  const legacyPromise = safeRun(legacyFn, 'legacy');
  const v3Promise     = safeRun(v3Fn,     'v3');
  const [legacyResult, v3Result] = await Promise.all([legacyPromise, v3Promise]);
  const t1 = Date.now();

  // Always return legacy to the caller, even if v3 threw. Shadow mode is
  // zero-user-facing-risk by construction.
  const userFacing = legacyResult.ok
    ? legacyResult.value
    : { memories: [], objects: [], _error: legacyResult.error };

  // Fire-and-forget the log; never block the response on it.
  logShadow(logEvent, context, legacyResult, v3Result, t0, t1)
    .catch(() => { /* swallow; logging must not break recall */ });

  return userFacing;
}

async function safeRun(fn, label) {
  const start = Date.now();
  try {
    const value = await fn();
    return { ok: true, value, ms: Date.now() - start, label };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err), ms: Date.now() - start, label };
  }
}

async function logShadow(logEvent, context, legacyResult, v3Result, t0, t1) {
  if (!logEvent) return;

  const payload = {
    query: context && context.query,
    api_key_fp: context && context.apiKey ? fp(context.apiKey) : null,
    request_id: context && context.request_id,
    user_id:    context && context.user_id,
    timing: {
      legacy_ms: legacyResult.ms,
      v3_ms:     v3Result.ms,
      total_ms:  t1 - t0,
    },
    status: {
      legacy_ok: legacyResult.ok,
      v3_ok:     v3Result.ok,
      legacy_error: legacyResult.ok ? null : legacyResult.error,
      v3_error:     v3Result.ok     ? null : v3Result.error,
    },
  };

  if (legacyResult.ok && v3Result.ok) {
    const legacyIds = flattenLegacyRanking(legacyResult.value, COMPARE_DEPTH);
    const v3Ids     = flattenV3Ranking(v3Result.value.ranked || [], COMPARE_DEPTH);
    payload.divergence = computeDivergence(legacyIds, v3Ids);
    payload.legacy_top  = legacyIds;
    payload.v3_top      = v3Ids;
  } else {
    payload.divergence = { skipped: true, reason: 'pipeline_error' };
  }

  await logEvent({
    type: SHADOW_EVENT_TYPE,
    actor: 'system',
    createdAt: new Date(),
    payload,
  });
}

// Fingerprint, not value. Never log API keys.
function fp(s) {
  if (!s) return null;
  const str = String(s);
  return `${str.slice(0, 4)}…${str.slice(-4)}(len${str.length})`;
}

// --- Exports ----------------------------------------------------------------

module.exports = {
  runShadowCompare,
  computeDivergence,
  flattenLegacyRanking,
  flattenV3Ranking,
  legacyEntryToComparableId,
  SHADOW_EVENT_TYPE,
  COMPARE_DEPTH,
};
