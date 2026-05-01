// cleo-api/_lib/correction-resolver.js
// ---------------------------------------------------------------------------
// RUNG 4 — Corrections as superseding events (resolver layer)
//
// Sits ABOVE candidate generation. Filters candidates that have been
// superseded by a correction in the same candidate set. Original memories
// remain in cleo.memories untouched — this filter is purely additive at
// READ time. Direct key lookup via memory_recall always returns the
// original; only associative_recall filters.
//
// Per Chaos Apr 25 architect-call: "Do not let Rung 4 become a ranker rewrite."
// Per Steven May 1: "visible and findable" — originals stay accessible.
//
// v0.1 SCOPE BOUND: handles "all chain in candidates" case only. If chain is
// A->B->C and only A and C are in candidates (B not loaded), v0.1 does not
// transitively filter A. Documented as known bound; v0.2 will walk chains.
// ---------------------------------------------------------------------------

'use strict';

/**
 * Filter candidates that have been superseded by a correction in the
 * candidate set.
 *
 * Matching uses (category, key) tuples from meta.legacy_fields and
 * meta.supersedes_keys, which are populated by event-adapters.js when
 * a memory has category=correction and a SUPERSEDES line in its value.
 *
 * @param {Array} candidates - canonical envelopes from event-adapters.js
 * @returns {Array} candidates with superseded entries removed
 */
function resolveCorrections(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return candidates;

  // Build set of "<category>/<key>" strings that have been superseded
  // by anything in the candidate set.
  const supersededByCatKey = new Set();
  for (const c of candidates) {
    const supersedesKeys = c && c.meta && c.meta.supersedes_keys;
    if (Array.isArray(supersedesKeys)) {
      for (const sk of supersedesKeys) {
        if (sk && sk.category && sk.key) {
          supersededByCatKey.add(`${sk.category}/${sk.key}`);
        }
      }
    }
  }

  if (supersededByCatKey.size === 0) return candidates;

  // Filter out candidates whose (category, key) has been superseded.
  return candidates.filter(c => {
    const lf = c && c.meta && c.meta.legacy_fields;
    if (!lf || !lf.category || !lf.key) return true; // not a memory or no cat/key — keep
    return !supersededByCatKey.has(`${lf.category}/${lf.key}`);
  });
}

/**
 * Compute divergence stats between unfiltered and filtered candidate sets,
 * for shadow-mode observability events.
 *
 * @param {Array} originalCandidates
 * @param {Array} resolvedCandidates - subset of original
 * @returns {Object} divergence stats
 */
function shadowDivergence(originalCandidates, resolvedCandidates) {
  const resolvedIds = new Set(resolvedCandidates.map(c => c.event_id));
  const filtered = originalCandidates.filter(c => !resolvedIds.has(c.event_id));
  return {
    original_count: originalCandidates.length,
    resolved_count: resolvedCandidates.length,
    filtered_count: filtered.length,
    filtered_event_ids: filtered.map(c => c.event_id),
    filtered_keys: filtered
      .map(c => c.meta && c.meta.legacy_fields)
      .filter(lf => lf && lf.category && lf.key)
      .map(lf => `${lf.category}/${lf.key}`),
  };
}

module.exports = {
  resolveCorrections,
  shadowDivergence,
};
