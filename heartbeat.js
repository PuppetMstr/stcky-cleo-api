// cleo-api/heartbeat.js
//
// SUBSTRATE HEALTH HEARTBEAT — automated refresh of substrate-health/heartbeat-current
// Track B Phase 3 / Organism Beta Phase 3
// Filed under FINO May 3 2026.
//
// PURPOSE
// Replace the manual heartbeat-current memory (last refreshed May 1 ~9:08 PM PT,
// 32+ hours stale by morning of May 3) with an automated refresh on a cron schedule.
// Same-doors pattern: heartbeat is a regular memory readable via associative_recall
// or any other normal substrate query path. No special endpoint needed for readers.
//
// AUTH MODEL
// Triggered by Vercel Cron. Verifies Authorization header matches CRON_SECRET env var.
// Writes the heartbeat memory under the user identified by STCKY_HEARTBEAT_USER_ID env var
// (single-tenant for Beta — multi-tenant deferred per architecture-spec Q8).
//
// SMOKE TESTS RUN
// - api: trivially ok if we got this far
// - database: getDb() succeeded
// - capture: latest tool_event in objects collection, age vs NOW
// - recall: smoke probe via direct memory query (last memory write age)
// - correction_resolver: process.env.RUNG_4_MODE
// - organism_beta: presence of any kind=now_state memory
//
// FAILURE SEMANTICS
// The endpoint ALWAYS attempts to write a heartbeat reflecting actual state, even if
// some checks fail. Degraded status is the truth and should be visible. Only a total
// failure (cannot connect to DB at all) returns error without writing a heartbeat.

const { getDb, ObjectId } = require('./_lib/auth');
const { appendEvent, ensureIndexes } = require('./_lib/events');

const CAPTURE_FRESHNESS_THRESHOLD_MIN = 60;     // tool_event within 60 min = ok
const CAPTURE_DEGRADED_THRESHOLD_MIN = 240;     // 60–240 min = degraded
                                                // > 240 min = unknown/stale
const RECALL_FRESHNESS_THRESHOLD_MIN = 60 * 24; // any memory write in last 24h = ok

// Run once per cold start
let _indexesReady = null;
async function ensureEventIndexes(db) {
  if (!_indexesReady) _indexesReady = ensureIndexes(db).catch((e) => {
    console.error('[heartbeat] ensureIndexes failed:', e.message);
    _indexesReady = null;
  });
  return _indexesReady;
}

function ageStatus(ageMin, freshThresh, degradedThresh) {
  if (ageMin == null) return 'unknown';
  if (ageMin <= freshThresh) return 'ok';
  if (ageMin <= degradedThresh) return 'degraded';
  return 'unknown';
}

module.exports = async (req, res) => {
  // Vercel Cron sends GET. Reject other methods to keep the surface tight.
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // CRON SECRET CHECK
  // Vercel Cron automatically sends Authorization: Bearer <CRON_SECRET>
  // when a CRON_SECRET env var is configured on the project.
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error('[heartbeat] CRON_SECRET not configured');
    return res.status(500).json({ error: 'CRON_SECRET not configured on this deployment' });
  }
  const authHeader = req.headers['authorization'] || '';
  if (authHeader !== `Bearer ${cronSecret}`) {
    console.warn('[heartbeat] unauthorized request, rejecting');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // USER ID
  const userIdStr = process.env.STCKY_HEARTBEAT_USER_ID;
  if (!userIdStr) {
    console.error('[heartbeat] STCKY_HEARTBEAT_USER_ID not configured');
    return res.status(500).json({ error: 'STCKY_HEARTBEAT_USER_ID not configured on this deployment' });
  }

  let userId;
  try {
    userId = new ObjectId(userIdStr);
  } catch (e) {
    console.error('[heartbeat] STCKY_HEARTBEAT_USER_ID is not a valid ObjectId:', userIdStr);
    return res.status(500).json({ error: 'STCKY_HEARTBEAT_USER_ID malformed' });
  }

  const startTime = Date.now();
  const generatedAt = new Date();

  let db;
  try {
    db = await getDb();
  } catch (err) {
    // DB itself is dead — we cannot write a heartbeat. Return error so Vercel
    // surfaces the failure in its logs. The absence of a fresh heartbeat is
    // itself a signal to readers (via stale ts).
    console.error('[heartbeat] getDb() failed:', err.message);
    return res.status(500).json({ error: 'Database unavailable', message: err.message });
  }

  // CHECK 1: Capture liveness — most recent tool_event for this user
  let captureStatus = 'unknown';
  let captureLastSeen = null;
  let captureAgeMin = null;
  try {
    const latestToolEvent = await db.collection('objects')
      .findOne(
        { userId, source_type: 'tool_event' },
        { sort: { ingested_at: -1 }, projection: { ingested_at: 1, source: 1 } }
      );
    if (latestToolEvent) {
      captureLastSeen = latestToolEvent.ingested_at;
      captureAgeMin = Math.floor((generatedAt - latestToolEvent.ingested_at) / (1000 * 60));
      captureStatus = ageStatus(
        captureAgeMin,
        CAPTURE_FRESHNESS_THRESHOLD_MIN,
        CAPTURE_DEGRADED_THRESHOLD_MIN
      );
    }
  } catch (err) {
    console.error('[heartbeat] capture check failed:', err.message);
    captureStatus = 'unknown';
  }

  // CHECK 2: Recall liveness — most recent memory write
  let recallStatus = 'unknown';
  let recallLastWrite = null;
  let recallAgeMin = null;
  try {
    const latestMemory = await db.collection('memories')
      .findOne(
        { userId },
        { sort: { updatedAt: -1 }, projection: { updatedAt: 1, key: 1 } }
      );
    if (latestMemory) {
      recallLastWrite = latestMemory.updatedAt;
      recallAgeMin = Math.floor((generatedAt - latestMemory.updatedAt) / (1000 * 60));
      recallStatus = recallAgeMin <= RECALL_FRESHNESS_THRESHOLD_MIN ? 'ok' : 'unknown';
    }
  } catch (err) {
    console.error('[heartbeat] recall check failed:', err.message);
    recallStatus = 'unknown';
  }

  // CHECK 3: Organism beta presence — any now_state for this user
  // Indirect signal that organism beta phase 1 is active (events have kind=now_state)
  let organismStatus = 'unknown';
  let organismNowStateKey = null;
  try {
    const latestNow = await db.collection('memories')
      .findOne(
        { userId, category: 'now' },
        { sort: { updatedAt: -1 }, projection: { key: 1, updatedAt: 1 } }
      );
    if (latestNow) {
      organismStatus = 'active';
      organismNowStateKey = latestNow.key;
    } else {
      organismStatus = 'inactive';
    }
  } catch (err) {
    console.error('[heartbeat] organism check failed:', err.message);
    organismStatus = 'unknown';
  }

  // CHECK 4: Correction resolver mode — env var
  const correctionResolverMode = process.env.RUNG_4_MODE || 'unknown';
  const correctionResolverStatus = correctionResolverMode === 'on' ? 'ok'
    : correctionResolverMode === 'canary' ? 'canary'
    : correctionResolverMode === 'shadow' ? 'shadow'
    : correctionResolverMode === 'off' || correctionResolverMode === 'inert' ? 'off'
    : 'unknown';

  // BUILD HEARTBEAT VALUE
  const heartbeat = {
    schema_version: 'substrate_health_v0.2',
    generated_at: generatedAt.toISOString(),
    generated_by: 'cron.heartbeat',
    services: {
      api: {
        status: 'ok',
        version: process.env.API_VERSION || '4.5.0',
        commit: process.env.VERCEL_GIT_COMMIT_SHA || null,
      },
      database: {
        status: 'ok',
      },
      capture: {
        status: captureStatus,
        last_seen_at: captureLastSeen ? captureLastSeen.toISOString() : null,
        age_minutes: captureAgeMin,
        freshness_threshold_min: CAPTURE_FRESHNESS_THRESHOLD_MIN,
      },
      recall: {
        status: recallStatus,
        last_write_at: recallLastWrite ? recallLastWrite.toISOString() : null,
        age_minutes: recallAgeMin,
      },
      correction_resolver: {
        status: correctionResolverStatus,
        mode: correctionResolverMode,
      },
    },
    organism: {
      phase_1_status: organismStatus,
      latest_now_state_key: organismNowStateKey,
    },
    overall_status: (
      captureStatus === 'unknown' ||
      recallStatus === 'unknown' ||
      correctionResolverStatus === 'unknown'
    ) ? 'degraded' : 'ok',
    cron_runtime_ms: 0, // filled in below
  };

  heartbeat.cron_runtime_ms = Date.now() - startTime;

  const heartbeatValue = JSON.stringify(heartbeat, null, 2);

  // WRITE HEARTBEAT to substrate-health/heartbeat-current
  // Mirrors the same upsert pattern memory.js uses for /api/memory POST,
  // but skipping the embedding pipeline (heartbeat doesn't need to be in vector
  // search; it's reached by direct category+key lookup or by associative_recall's
  // text matching).
  try {
    await ensureEventIndexes(db);

    const now = new Date();
    const category = 'substrate-health';
    const key = 'heartbeat-current';
    const entity_id = `memory:${category}:${key}`;

    const existing = await db.collection('memories').findOne({
      userId, category, key,
    });

    const event_type = existing ? 'memory_updated' : 'memory_created';
    const payload = {
      category,
      key,
      value: heartbeatValue,
      tags: 'substrate-health,heartbeat,automated,track-b,organism-beta-phase-3',
      domain: 'work',
      anchor: false,
      relevantDate: null,
    };

    const eventResult = await appendEvent(db, {
      userId,
      projectId: null,
      entity_id,
      event_type,
      payload_mode: 'whole_state',
      payload,
      source: 'api.cron.heartbeat',
      actor: 'cron',
      tags: payload.tags.split(',').map(t => t.trim()),
      causationId: null,
    });

    const memoryDoc = {
      ...payload,
      source: 'api.cron.heartbeat',
      relevantDate: null,
      embedding: null,        // heartbeat skips embedding (read by direct lookup)
      embeddingModel: null,
      embeddingDims: null,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
      lastAccessedAt: now,
      accessCount: existing ? (existing.accessCount || 0) + 1 : 1,
      createdBy: userId,
      last_event_id: eventResult.event_id,
      first_event_id: existing ? (existing.first_event_id || eventResult.event_id) : eventResult.event_id,
      version_count: existing ? ((existing.version_count || 1) + 1) : 1,
      schema_version: '1.0',
      userId,
    };

    if (existing) {
      await db.collection('memories').updateOne(
        { _id: existing._id },
        { $set: memoryDoc }
      );
    } else {
      await db.collection('memories').insertOne(memoryDoc);
    }

    console.log(
      `[heartbeat] wrote substrate-health/heartbeat-current — ` +
      `capture=${captureStatus} recall=${recallStatus} ` +
      `resolver=${correctionResolverStatus} organism=${organismStatus} ` +
      `overall=${heartbeat.overall_status} runtime=${heartbeat.cron_runtime_ms}ms`
    );

    return res.status(200).json({
      success: true,
      overall_status: heartbeat.overall_status,
      heartbeat,
    });
  } catch (err) {
    console.error('[heartbeat] write failed:', err.message);
    return res.status(500).json({
      error: 'Failed to write heartbeat',
      message: err.message,
      // Still return the computed heartbeat so the cron logs reflect what was
      // attempted, even though it didn't land.
      computed_heartbeat: heartbeat,
    });
  }
};
