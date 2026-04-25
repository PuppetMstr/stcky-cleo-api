// admin-shadow-stats.js v0.2
//
// GET /api/admin/shadow-stats?since=ISO_DATE
// Returns aggregate statistics over `retrieval_shadow_compared` events for ops review of
// Rung 3 shadow mode rollout health. Read-only. ADMIN_SECRET gated.
//
// v0.2 (2026-04-25) — RECALIBRATED THRESHOLDS per Chaos's Apr 25 canary gate response.
// v0.1 thresholds assumed v3 should match legacy nearly identically. After v5.2.1+v5.2.2
// patches, v3's unified ranker produces intentionally different (but symmetric) divergence
// from legacy. Updated thresholds reward symmetric divergence (= ranker doing its job)
// and flag asymmetric divergence (= actual regression signal).
//
// CHAOS GATE (Apr 25 response):
//   1. No systematic source suppression (only_in_legacy not >> only_in_v3)
//   2. abs(only_in_legacy - only_in_v3) low and diffs explainable
//   3. Quality floor via moderate jaccard (>= 0.4) or manual relevance wins
//   4. 100+ shadow events preferred, zero v3 errors, latency <= 1.25x ideal
//   5. 10+ manual diffs judged neutral-or-better (handled separately via shadow-diff endpoint)
//
// Yellow / red flag interpretation guide is in the response under `_interpretation`.
//
// Author: Eli — Apr 25, 2026 (v0.1 → v0.2 same morning)
// Field paths in the divergence event payload are based on rung-3-shadow-skeleton-2026-04-24.
// First call returns one `_meta.sample_event` so Steven can verify the shape matches before relying on aggregates.

const { MongoClient } = require('mongodb');

// ---------- Config ----------
const ADMIN_SECRET = process.env.ADMIN_SECRET; // hardened Apr 22, no fallback
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = 'cleo';
const EVENTS_COLLECTION = 'events';
const SHADOW_EVENT_TYPE = 'retrieval_shadow_compared';

// Default window if `since` not provided: last 48h (covers shadow rollout window since Apr 24 morning)
const DEFAULT_WINDOW_HOURS = 48;

// ---------- DB connection (cached across invocations on warm Lambdas) ----------
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

// ---------- Percentile helper (in-process, since not all Mongo versions support $percentile cleanly) ----------
function percentile(sortedArr, p) {
  if (!sortedArr || sortedArr.length === 0) return null;
  const idx = Math.min(sortedArr.length - 1, Math.max(0, Math.ceil((p / 100) * sortedArr.length) - 1));
  return sortedArr[idx];
}

function summarizeNumericValues(values) {
  if (!values || values.length === 0) {
    return { count: 0, mean: null, min: null, p50: null, p95: null, p99: null, max: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count: sorted.length,
    mean: round(sum / sorted.length, 4),
    min: sorted[0],
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1],
  };
}

function round(n, decimals = 4) {
  if (n === null || n === undefined || isNaN(n)) return null;
  const factor = Math.pow(10, decimals);
  return Math.round(n * factor) / factor;
}

// ---------- Main handler ----------
module.exports = async (req, res) => {
  // Method check — read-only, accept GET and POST
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth
  const auth = checkAdminAuth(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error });
  }

  // Parse window
  const sinceParam = req.query?.since || req.body?.since || null;
  let sinceDate;
  if (sinceParam) {
    sinceDate = new Date(sinceParam);
    if (isNaN(sinceDate.getTime())) {
      return res.status(400).json({ error: 'Invalid `since` parameter; expected ISO date string' });
    }
  } else {
    sinceDate = new Date(Date.now() - DEFAULT_WINDOW_HOURS * 3600 * 1000);
  }

  try {
    const db = await getDb();
    const events = db.collection(EVENTS_COLLECTION);

    const match = {
      type: SHADOW_EVENT_TYPE,
      createdAt: { $gte: sinceDate },
    };

    // Pull all events in window. For Rung 3 shadow rollout the volume is bounded to
    // (tool-call count) over the window, so this fits comfortably in memory. If volume grows,
    // switch to in-Mongo $facet aggregation with $bucket for histograms.
    const docs = await events.find(match).sort({ createdAt: 1 }).limit(50000).toArray();

    if (docs.length === 0) {
      return res.status(200).json({
        window: {
          since: sinceDate.toISOString(),
          now: new Date().toISOString(),
          total_events: 0,
        },
        verdict: 'NO_DATA',
        message: `No ${SHADOW_EVENT_TYPE} events found in window. Either shadow mode is off, or no recall calls have happened in the window.`,
      });
    }

    // Extract metric arrays. Field paths assumed per rung-3-shadow-skeleton-2026-04-24.
    // If sample_event below shows different paths, adjust here.
    const jaccardValues = [];
    const rankDeltaValues = [];
    const onlyInLegacySizes = [];
    const onlyInV3Sizes = [];
    const legacyLatencies = [];
    const v3Latencies = [];
    let v3ErrorCount = 0;
    let legacyErrorCount = 0;
    let skippedCount = 0;
    const queryDivergence = []; // {query, rank_delta, jaccard, createdAt}

    for (const doc of docs) {
      const p = doc.payload || {};
      const div = p.divergence || {};
      const timing = p.timing || {};
      const status = p.status || {};

      if (typeof div.jaccard === 'number') jaccardValues.push(div.jaccard);
      if (typeof div.rank_delta === 'number') rankDeltaValues.push(div.rank_delta);
      if (Array.isArray(div.only_in_legacy)) onlyInLegacySizes.push(div.only_in_legacy.length);
      if (Array.isArray(div.only_in_v3)) onlyInV3Sizes.push(div.only_in_v3.length);
      if (typeof timing.legacy_ms === 'number') legacyLatencies.push(timing.legacy_ms);
      if (typeof timing.v3_ms === 'number') v3Latencies.push(timing.v3_ms);
      if (status.v3_error) v3ErrorCount++;
      if (status.legacy_error) legacyErrorCount++;
      if (div.skipped) skippedCount++;

      // For top-divergent queries: collect those with high rank_delta or low jaccard
      if (typeof div.rank_delta === 'number' && p.query) {
        queryDivergence.push({
          query: p.query,
          rank_delta: div.rank_delta,
          jaccard: div.jaccard ?? null,
          only_in_legacy_count: Array.isArray(div.only_in_legacy) ? div.only_in_legacy.length : null,
          only_in_v3_count: Array.isArray(div.only_in_v3) ? div.only_in_v3.length : null,
          createdAt: doc.createdAt,
        });
      }
    }

    // Top 10 most divergent queries — sorted by rank_delta desc, with jaccard tiebreaker (low jaccard = more divergent)
    queryDivergence.sort((a, b) => {
      if (b.rank_delta !== a.rank_delta) return b.rank_delta - a.rank_delta;
      return (a.jaccard ?? 1) - (b.jaccard ?? 1);
    });
    const topDivergent = queryDivergence.slice(0, 10);

    // Summary
    const jaccardStats = summarizeNumericValues(jaccardValues);
    const rankDeltaStats = summarizeNumericValues(rankDeltaValues);
    const onlyInLegacyStats = summarizeNumericValues(onlyInLegacySizes);
    const onlyInV3Stats = summarizeNumericValues(onlyInV3Sizes);
    const legacyLatencyStats = summarizeNumericValues(legacyLatencies);
    const v3LatencyStats = summarizeNumericValues(v3Latencies);

    // Verdict logic v0.2 — recalibrated per Chaos's Apr 25 gate response
    const flags = [];

    // LOW_VOLUME: Chaos prefers 100+ events; under that is YELLOW (not blocking)
    if (docs.length < 100) flags.push('LOW_VOLUME');

    // JACCARD: recalibrated floor at 0.4 (was 0.5). Ranker divergence is by design.
    if (jaccardStats.mean !== null) {
      if (jaccardStats.mean < 0.3) flags.push('LOW_JACCARD');
      else if (jaccardStats.mean < 0.4) flags.push('YELLOW_JACCARD');
    }

    // DIVERGENCE ASYMMETRY (Chaos gate criterion 1+2):
    // Symmetric divergence = healthy ranker behavior. Asymmetric divergence in legacy's
    // favor = systematic source suppression (the bug we fixed). Asymmetric in v3's favor
    // = noise flooding (less critical, still worth flagging).
    if (onlyInLegacyStats.mean !== null && onlyInV3Stats.mean !== null) {
      const legacyMean = onlyInLegacyStats.mean;
      const v3Mean = onlyInV3Stats.mean;
      const absDiff = Math.abs(legacyMean - v3Mean);

      // V3_BLIND_SPOTS: legacy mean exceeds v3 mean by 2x AND legacy >= 2 absolute
      // (the systematic suppression signal that triggered the original RED finding)
      if (legacyMean > v3Mean * 2 && legacyMean >= 2) {
        flags.push('V3_BLIND_SPOTS');
      }
      // V3_NOISE_FLOOD: v3 surfaces >>2x what legacy does, AND v3 >= 3 absolute
      // (yellow because more is recoverable than less, but worth review)
      else if (v3Mean > legacyMean * 2 && v3Mean >= 3) {
        flags.push('YELLOW_V3_NOISE_FLOOD');
      }
      // ASYMMETRY (yellow): absolute difference > 2 even if not 2x ratio
      else if (absDiff > 2) {
        flags.push('YELLOW_ASYMMETRY');
      }
    }

    // V3 ERRORS: any > 0 is RED
    if (v3ErrorCount > 0) flags.push(`V3_ERRORS_${v3ErrorCount}`);

    // LATENCY: <=1.25 GREEN, 1.25-2.0 YELLOW, >2.0 RED
    if (legacyLatencyStats.p95 && v3LatencyStats.p95) {
      const ratio = v3LatencyStats.p95 / legacyLatencyStats.p95;
      if (ratio > 2) flags.push('V3_LATENCY_2X');
      else if (ratio > 1.25) flags.push('YELLOW_V3_LATENCY_125X');
    }

    let verdict;
    if (flags.some((f) => f.startsWith('V3_ERRORS') || f === 'LOW_JACCARD' || f === 'V3_BLIND_SPOTS' || f === 'V3_LATENCY_2X')) {
      verdict = 'RED — shadow data shows anomalies; do not promote to canary';
    } else if (flags.some((f) => f.startsWith('YELLOW') || f === 'LOW_VOLUME')) {
      verdict = 'YELLOW — review flags; canary acceptable if manual diff inspection clean';
    } else {
      verdict = 'GREEN — shadow data healthy; safe to promote to canary';
    }

    return res.status(200).json({
      window: {
        since: sinceDate.toISOString(),
        now: new Date().toISOString(),
        first_event: docs[0].createdAt,
        last_event: docs[docs.length - 1].createdAt,
        total_events: docs.length,
      },
      verdict,
      flags,
      health: {
        jaccard: jaccardStats,
        rank_delta: rankDeltaStats,
        only_in_legacy: onlyInLegacyStats,
        only_in_v3: onlyInV3Stats,
        legacy_latency_ms: legacyLatencyStats,
        v3_latency_ms: v3LatencyStats,
        v3_error_count: v3ErrorCount,
        legacy_error_count: legacyErrorCount,
        skipped_count: skippedCount,
        v3_p95_vs_legacy_p95_ratio:
          legacyLatencyStats.p95 && v3LatencyStats.p95
            ? round(v3LatencyStats.p95 / legacyLatencyStats.p95, 3)
            : null,
      },
      top_divergent_queries: topDivergent,
      _interpretation: {
        jaccard_mean: 'Higher = more overlap between legacy and v3 top results. v0.2 thresholds (post-Chaos-recalibration): >= 0.4 healthy, 0.3-0.4 yellow, < 0.3 red. Lower than v0.1 because v3 ranker is intentionally different from legacy.',
        rank_delta: 'Lower = items shared between legacy and v3 ranked similarly. High values mean v3 is heavily reordering shared candidates. Not directly thresholded — informational.',
        only_in_legacy_mean: 'Items legacy returns that v3 misses. v0.2 interpretation: not flagged in isolation. Only flagged when STRONGLY ASYMMETRIC vs only_in_v3 (legacy >> v3 indicates systematic suppression — the V3_BLIND_SPOTS bug).',
        only_in_v3_mean: 'Items v3 returns that legacy misses. v0.2 interpretation: symmetric with only_in_legacy is HEALTHY (ranker doing its unified-scoring job). v3 >> legacy is YELLOW_V3_NOISE_FLOOD.',
        asymmetry: 'V3_BLIND_SPOTS = legacy_mean > 2 * v3_mean AND legacy_mean >= 2. YELLOW_V3_NOISE_FLOOD = v3_mean > 2 * legacy_mean AND v3_mean >= 3. YELLOW_ASYMMETRY = abs(diff) > 2 without 2x ratio.',
        v3_p95_vs_legacy_p95_ratio: 'Chaos bar: <= 1.25 ideal (GREEN), 1.25-2.0 acceptable during canary (YELLOW), > 2.0 unacceptable (RED).',
        low_volume: 'LOW_VOLUME = under 100 events. YELLOW (not blocking) per Chaos "100+ preferred." Manual diff inspection (shadow-diff endpoint) can compensate at lower volume.',
      },
      _meta: {
        sample_event: docs[0], // first event so we can verify the field paths assumed in this code match reality
        field_paths_assumed: [
          'payload.divergence.jaccard',
          'payload.divergence.rank_delta',
          'payload.divergence.only_in_legacy (array)',
          'payload.divergence.only_in_v3 (array)',
          'payload.divergence.skipped (boolean)',
          'payload.timing.legacy_ms',
          'payload.timing.v3_ms',
          'payload.status.v3_error',
          'payload.status.legacy_error',
          'payload.query',
        ],
        endpoint_version: '0.2',
        endpoint_author: 'Eli',
        endpoint_date: '2026-04-25',
      },
    });
  } catch (err) {
    console.error('shadow-stats error:', err);
    return res.status(500).json({
      error: 'Aggregation failed',
      detail: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    });
  }
};
