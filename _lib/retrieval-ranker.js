// cleo-api/_lib/retrieval-ranker.js
// ---------------------------------------------------------------------------
// RUNG 3 — Retrieval ranker v0.2 (multiplicative temporal proximity)
//
// Takes a list of canonical candidates (from event-adapters.js) plus per-
// candidate semantic/lexical signals, and produces an ordered ranked list.
//
// FOUNDATIONAL PRINCIPLE (Steven, Apr 25 2026):
//   "The most important things are Now and the things before now and after
//    now that are closest to now."
//
// Time-proximity to NOW is the PRIMARY ranking axis. Lexical and semantic
// match are tiebreakers among items at similar temporal distance.
//
// Formula (v0.2, multiplicative):
//
//   relevance = w_semantic   * effective_semantic
//             + w_lexical    * lexical_match
//             + w_trust_fact * candidate.trust.trust_fact
//
//   score = temporal_proximity * relevance - w_noise_penalty * noisy
//
// where:
//   - effective_semantic = semantic if enrichment.state === 'complete', else 0
//     (preserves Spec v0.2 Sec 3 "never make embedding pending equal invisible")
//   - temporal_proximity = exp(-|now - effective_date| / halflife)
//     symmetric around NOW. Future-dated relevantDate decays the same way as
//     past-dated ts_human.
//   - effective_date = relevantDate if set AND in future, else ts_human
//
// Multiplicative (vs v0.1 additive recency) ensures ancient items can't
// dominate ranking via strong semantic/lexical match alone — their proximity
// multiplier zeroes them out regardless. This honors the principle exactly.
// ---------------------------------------------------------------------------

'use strict';

// --- Default tuning constants -----------------------------------------------

const DEFAULT_WEIGHTS = Object.freeze({
  semantic:      1.00,
  lexical:       0.30,
  trust_fact:    0.20,
  noise_penalty: 0.50,
  // NOTE: no separate recency weight in v0.2. Recency is multiplicative.
});

// 7-day half-life: a candidate from a week ago has proximity 0.5, two weeks
// ago 0.25. Symmetric for relevantDate in future. Tuneable.
const DEFAULT_RECENCY_HALFLIFE_DAYS = 7;

const DEFAULT_LIMIT = 20;

// --- Helpers ----------------------------------------------------------------

/**
 * Pick the date that anchors temporal proximity for a candidate.
 *   - If candidate has relevantDate set AND it's in the future, use that
 *     (this is the "after now" arm of the principle — scheduled future
 *     events get proximity-scored just like recent past events).
 *   - Otherwise use ts_human (the "before now" arm).
 *
 * Looks at both candidate.meta.relevantDate and candidate.relevantDate
 * for adapter flexibility.
 */
function effectiveDate(candidate) {
  if (!candidate) return null;
  let rd = (candidate.meta && candidate.meta.relevantDate) || candidate.relevantDate;
  if (rd) {
    const rdMs = Date.parse(rd);
    if (!isNaN(rdMs) && rdMs > Date.now()) return rd;
  }
  return candidate.ts_human || null;
}

/**
 * Symmetric exponential decay around NOW.
 *   distance = 0          → 1.0  (right now)
 *   distance = halflife   → 0.5
 *   distance = 2*halflife → 0.25
 *
 * Works for both past (ts_human in the past) and future (relevantDate in
 * the future) — uses absolute distance from now.
 */
function temporalProximity(candidate, nowMs, halflifeDays) {
  const eff = effectiveDate(candidate);
  if (!eff) return 0;
  const ts = Date.parse(eff);
  if (isNaN(ts)) return 0;
  const distanceDays = Math.abs(nowMs - ts) / (1000 * 60 * 60 * 24);
  return Math.pow(0.5, distanceDays / halflifeDays);
}

/**
 * Deprecated back-compat wrapper for the old (tsHumanISO, ...) signature.
 * New code should call temporalProximity(candidate, ...) directly.
 */
function recencyDecay(tsHumanISO, nowMs, halflifeDays) {
  return temporalProximity({ ts_human: tsHumanISO }, nowMs, halflifeDays);
}

/**
 * Score a single candidate. Multiplicative formula: temporal proximity
 * gates relevance. Returns score + breakdown for shadow logging.
 */
function scoreCandidate(candidate, signals, weights, nowMs, halflifeDays) {
  const semantic = Number(signals.semantic) || 0;
  const lexical  = Number(signals.lexical)  || 0;
  const trust    = (candidate.trust && Number(candidate.trust.trust_fact)) || 0.5;
  const noisy    = (candidate.flags && candidate.flags.noisy) ? 1 : 0;

  const proximity = temporalProximity(candidate, nowMs, halflifeDays);

  // Pending-embedding rule preserved from v0.1.
  const enrichState = candidate.enrichment && candidate.enrichment.state;
  const semanticActive = enrichState === 'complete';
  const effectiveSemantic = semanticActive ? semantic : 0;

  // Multiplicative scoring: temporal proximity gates relevance signals.
  // The most important things are NOW and the things closest to now.
  const relevance =
      weights.semantic   * effectiveSemantic
    + weights.lexical    * lexical
    + weights.trust_fact * trust;

  const score = proximity * relevance - weights.noise_penalty * noisy;

  return {
    score,
    breakdown: {
      semantic:           effectiveSemantic,
      lexical,
      trust_fact:         trust,
      temporal_proximity: proximity,
      noise_penalty:      noisy,
      semantic_active:    semanticActive,
      enrichment_state:   enrichState || null,
      source_collection:  candidate.meta && candidate.meta.source_collection,
      ts_human:           candidate.ts_human,
      effective_date:     effectiveDate(candidate),
      relevance_subtotal: relevance,
    },
  };
}

// --- Main entry point -------------------------------------------------------

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
  temporalProximity,
  effectiveDate,
  recencyDecay,        // deprecated, back-compat shim
  DEFAULT_WEIGHTS,
  DEFAULT_RECENCY_HALFLIFE_DAYS,
  DEFAULT_LIMIT,
};