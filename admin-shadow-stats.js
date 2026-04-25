// admin-shadow-stats.js
//
// GET /api/admin/shadow-stats?since=ISO_DATE
// Returns aggregate statistics over `retrieval_shadow_compared` events for ops review of
// Rung 3 shadow mode rollout health. Read-only. ADMIN_SECRET gated.
//
// Healthy signal thresholds (working hypothesis — tune with observed data):
//   - count: > 50 in the inspected window
//   - jaccard mean: > 0.5 (significant overlap legacy vs v3)
//   - rank_delta median: < 5 (top results not heavily reordered)
//   - only_in_legacy mean: < 1 (v3 not systematically missing things legacy returns)
//   - v3 p95 latency: < 1.5x legacy p95 (within Chaos's 25% regression bar with margin)
//   - v3 error count: 0
//
// Yellow / red flag interpretation guide is in the response under `_interpretation`.
//
// Author: Eli — Apr 25, 2026
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

    // Verdict logic — quick health signal
    const flags = [];
    if (docs.length < 10) flags.push('LOW_VOLUME');
    if (jaccardStats.mean !== null && jaccardStats.mean < 0.3) flags.push('LOW_JACCARD');
    else if (jaccardStats.mean !== null && jaccardStats.mean < 0.5) flags.push('YELLOW_JACCARD');
    if (onlyInLegacyStats.mean !== null && onlyInLegacyStats.mean > 3) flags.push('V3_BLIND_SPOTS');
    else if (onlyInLegacyStats.mean !== null && onlyInLegacyStats.mean > 1) flags.push('YELLOW_V3_BLIND_SPOTS');
    if (v3ErrorCount > 0) flags.push(`V3_ERRORS_${v3ErrorCount}`);
    if (legacyLatencyStats.p95 && v3LatencyStats.p95) {
      const ratio = v3LatencyStats.p95 / legacyLatencyStats.p95;
      if (ratio > 2) flags.push('V3_LATENCY_2X');
      else if (ratio > 1.5) flags.push('YELLOW_V3_LATENCY_1.5X');
    }

    let verdict;
    if (flags.some((f) => f.startsWith('V3_ERRORS') || f === 'LOW_JACCARD' || f === 'V3_BLIND_SPOTS' || f === 'V3_LATENCY_2X')) {
      verdict = 'RED — shadow data shows anomalies; do not promote to canary';
    } else if (flags.some((f) => f.startsWith('YELLOW') || f === 'LOW_VOLUME')) {
      verdict = 'YELLOW — review flags before promoting to canary';
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
        jaccard_mean: 'Higher = more overlap between legacy and v3 top results. Healthy: > 0.5. Yellow: 0.3-0.5. Red: < 0.3.',
        rank_delta: 'Lower = items shared between legacy and v3 ranked similarly. High values mean v3 is heavily reordering shared candidates.',
        only_in_legacy_mean:
          'Items legacy returns that v3 misses. Should trend low. > 1 means v3 has blind spots; > 3 is a red flag.',
        only_in_v3_mean:
          'Items v3 returns that legacy misses. Expected non-zero (v3 sees events legacy cannot), but if very high, v3 may be flooding noise.',
        v3_p95_vs_legacy_p95_ratio: 'Chaos bar from Rung 3 plan: ≤ 1.25 ideal, ≤ 2.0 acceptable during canary, > 2.0 unacceptable.',
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
        endpoint_version: '0.1',
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
