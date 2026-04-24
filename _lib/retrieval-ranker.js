// cleo-api/_lib/retrieval-ranker.js
// ---------------------------------------------------------------------------
// RUNG 3 — Retrieval ranker
//
// Takes a list of canonical candidates (from event-adapters.js) plus per-
// candidate semantic/lexical signals, and produces an ordered ranked list.
//
// This file does NOT perform queries. It receives signals from the caller
// (associative.js), combines them with per-candidate trust/recency/noise
// signals, and sorts. Pure logic, stateless, no I/O.
//
// Formula (v0.1, tune-with-logs per Chaos's Rung 3 plan):
//
//   score = w_semantic   * effective_semantic
//         + w_lexical    * lexical_match
//         + w_recency    * recency_decay(ts_human, now)
//         + w_trust_fact * candidate.trust.trust_fact
//         - w_noise      * (candidate.flags.noisy ? 1 : 0)
//
// where effective_semantic is the semantic signal IF enrichment.state is
// "complete", else 0 (the "never make embedding pending equal invisible"
// rule from Spec v0.2 Sec 3 — pending candidates still return, they just
// lean on lexical + recency until their embedding lands).
// ---------------------------------------------------------------------------

'use strict';

// --- Default tuning constants -----------------------------------------------

const DEFAULT_WEIGHTS = Object.freeze({
  semantic:      1.00,
  lexical:       0.30,
  recency:       0.40,
  trust_fact:    0.20,
  noise_penalty: 0.50,
});

// 7-day half-life: a candidate from a week ago scores half its raw recency,
// two weeks ago a quarter, etc. Long-lived curated memories can still win
// on semantic + trust even when recency has decayed.
const DEFAULT_RECENCY_HALFLIFE_DAYS = 7;

// Upper bound on ranked results the caller gets back per query.
const DEFAULT_LIMIT = 20;

// --- Helpers ----------------------------------------------------------------

/**
 * Exponential recency decay.
 *   age = 0         → 1.0
 *   age = halflife  → 0.5
 *   age = 2*halflife → 0.25
 * Future-dated candidates treated as "present" (decay = 1).
 *
 * @param {string} tsHumanISO - ISO 8601 timestamp from candidate.ts_human
 * @param {number} nowMs - Date.now() snapshot for this ranking pass
 * @param {number} halflifeDays
 * @returns {number} [0, 1]
 */
function recencyDecay(tsHumanISO, nowMs, halflifeDays) {
  const ts = Date.parse(tsHumanISO);
  if (isNaN(ts)) return 0;
  const ageDays = (nowMs - ts) / (1000 * 60 * 60 * 24);
  if (ageDays <= 0) return 1;
  return Math.pow(0.5, ageDays / halflifeDays);
}

/**
 * Score a single candidate given its signals.
 * Returns both the composite score and a breakdown for shadow-mode logging
 * and operator-facing "why did this rank here" surfaces.
 *
 * @param {Object} candidate - canonical envelope from an adapter
 * @param {{semantic: number, lexical: number}} signals - from caller
 * @param {Object} weights
 * @param {number} nowMs
 * @param {number} halflifeDays
 * @returns {{score: number, breakdown: Object}}
 */
function scoreCandidate(candidate, signals, weights, nowMs, halflifeDays) {
  const semantic = Number(signals.semantic) || 0;
  const lexical  = Number(signals.lexical)  || 0;
  const recency  = recencyDecay(candidate.ts_human, nowMs, halflifeDays);
  const trust    = (candidate.trust && Number(candidate.trust.trust_fact)) || 0.5;
  const noisy    = (candidate.flags && candidate.flags.noisy) ? 1 : 0;

  // "Never make embedding pending equal invisible" — Spec v0.2 Sec 3.
  // Pending candidates return with semantic weight zeroed out. Lexical +
  // recency + trust still score them; they just don't benefit from semantic
  // similarity until the embedding lands.
  const enrichState = candidate.enrichment && candidate.enrichment.state;
  const semanticActive = enrichState === 'complete';
  const effectiveSemantic = semanticActive ? semantic : 0;

  const score =
      weights.semantic      * effectiveSemantic
    + weights.lexical       * lexical
    + weights.recency       * recency
    + weights.trust_fact    * trust
    - weights.noise_penalty * noisy;

  return {
    score,
    breakdown: {
      semantic:      effectiveSemantic,
      lexical,
      recency,
      trust_fact:    trust,
      noise_penalty: noisy,
      semantic_active: semanticActive,
      enrichment_state: enrichState || null,
      source_collection: candidate.meta && candidate.meta.source_collection,
      ts_human: candidate.ts_human,
    },
  };
}

// --- Main entry point -------------------------------------------------------

/**
 * Rank a list of canonical candidates. The caller (associative.js) is
 * expected to have already run semantic and lexical queries and to pass
 * per-candidate signal scores via signalsMap.
 *
 * @param {Array<Object>} candidates - canonical envelopes from adapters
 * @param {Map<string, {semantic: number, lexical: number}>} signalsMap
 *        keyed by candidate.event_id. Missing entries treated as {0, 0}.
 * @param {Object} [opts]
 * @param {Object} [opts.weights]         override DEFAULT_WEIGHTS
 * @param {number} [opts.halflifeDays]    override DEFAULT_RECENCY_HALFLIFE_DAYS
 * @param {number} [opts.nowMs]           override Date.now() (useful for tests)
 * @param {number} [opts.limit]           override DEFAULT_LIMIT
 * @returns {Array<{candidate, score, breakdown}>} sorted desc by score
 */
function rankCandidates(candidates, signalsMap, opts) {
  opts = opts || {};
  const weights      = opts.weights      || DEFAULT_WEIGHTS;
  const halflifeDays = opts.halflifeDays || DEFAULT_RECENCY_HALFLIFE_DAYS;
  const nowMs        = opts.nowMs        || Date.now();
  const limit        = opts.limit        || DEFAULT_LIMIT;

  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  const map = signalsMap instanceof Map ? signalsMap : new Map();

  const scored = candidates.map(c => {
    const signals = map.get(c.event_id) || { semantic: 0, lexical: 0 };
    const { score, breakdown } = scoreCandidate(c, signals, weights, nowMs, halflifeDays);
    return { candidate: c, score, breakdown };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// --- Exports ----------------------------------------------------------------

module.exports = {
  rankCandidates,
  scoreCandidate,
  recencyDecay,
  DEFAULT_WEIGHTS,
  DEFAULT_RECENCY_HALFLIFE_DAYS,
  DEFAULT_LIMIT,
};
