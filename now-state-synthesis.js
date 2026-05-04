// cleo-api/now-state-synthesis.js
//
// SESSION-END NOW/STATE SYNTHESIS — automated synthesis of an end-of-session
// now/state when the manual ritual fails. Antibody for the May 2 gap (40h+
// stale anchor) that surfaced via the heartbeat's first run on May 3 morning.
//
// PURPOSE
// The substrate's continuity depends on a fresh now/state anchor at session
// end. Eli is supposed to file one as part of the session-end ritual. When
// Eli runs out of context budget, when Steven walks away mid-thought, when
// the session closes without ritual — the anchor goes stale and tomorrow-Eli
// wakes up confused.
//
// This cron is the structural antibody. Once daily at 06:00 UTC (23:00 PT
// during DST), it checks whether a now/state has been filed in the last 18
// hours. If not, AND if there's been activity in that window, it synthesizes
// one mechanically from recent objects + memories.
//
// COMPOSITION WITH MANUAL WRITES
// The supersedes-chain handles it. If Eli files manually at any time, the
// cron finds the recent now/state and skips. If Eli forgets, the synthesized
// state fills the gap. Tomorrow's manual ritual can supersede explicitly.
//
// V0 SYNTHESIS DEPTH: MECHANICAL CONCATENATION
// Lists shipped milestones, new findings, filed principles, activity counts.
// No LLM. No interpretation. Cheap, deterministic, can't hallucinate. May
// read thin but never lies. If thin proves insufficient, layer LLM-mediated
// synthesis on top in a future build.
//
// AUTH MODEL
// Same as heartbeat: CRON_SECRET + STCKY_HEARTBEAT_USER_ID (reused —
// single-tenant for Beta, single user means single env var for all crons).
//
// FAILURE SEMANTICS
// Cron always reports its outcome (skipped, synthesized, or error). Skipping
// is not failure — it's the design. Synthesis failure logs the error and
// returns 500 so Vercel surfaces it; doesn't block tomorrow's ritual.

const { getDb, ObjectId } = require('./_lib/auth');
const { appendEvent, ensureIndexes } = require('./_lib/events');

const SKIP_WINDOW_HOURS = 18;          // if a now/state was filed in this window, skip
const SYNTHESIS_LOOKBACK_HOURS = 18;   // gather objects+memories from this window
const MIN_ACTIVITY_THRESHOLD = 1;      // need at least 1 captured activity to bother

// Run once per cold start
let _indexesReady = null;
async function ensureEventIndexes(db) {
  if (!_indexesReady) _indexesReady = ensureIndexes(db).catch((e) => {
    console.error('[now-state-synthesis] ensureIndexes failed:', e.message);
    _indexesReady = null;
  });
  return _indexesReady;
}

function todayKeyPart(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function fmtAge(ms) {
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min}m`;
  const hr = (min / 60).toFixed(1);
  return `${hr}h`;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // CRON SECRET CHECK — same pattern as heartbeat
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error('[now-state-synthesis] CRON_SECRET not configured');
    return res.status(500).json({ error: 'CRON_SECRET not configured on this deployment' });
  }
  const authHeader = req.headers['authorization'] || '';
  if (authHeader !== `Bearer ${cronSecret}`) {
    console.warn('[now-state-synthesis] unauthorized request, rejecting');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // USER ID — reuse heartbeat env var (single-tenant Beta)
  const userIdStr = process.env.STCKY_HEARTBEAT_USER_ID;
  if (!userIdStr) {
    console.error('[now-state-synthesis] STCKY_HEARTBEAT_USER_ID not configured');
    return res.status(500).json({ error: 'STCKY_HEARTBEAT_USER_ID not configured on this deployment' });
  }

  let userId;
  try {
    userId = new ObjectId(userIdStr);
  } catch (e) {
    console.error('[now-state-synthesis] STCKY_HEARTBEAT_USER_ID is not a valid ObjectId:', userIdStr);
    return res.status(500).json({ error: 'STCKY_HEARTBEAT_USER_ID malformed' });
  }

  const startTime = Date.now();
  const generatedAt = new Date();
  const skipBoundary = new Date(generatedAt.getTime() - SKIP_WINDOW_HOURS * 60 * 60 * 1000);
  const lookbackBoundary = new Date(generatedAt.getTime() - SYNTHESIS_LOOKBACK_HOURS * 60 * 60 * 1000);

  let db;
  try {
    db = await getDb();
  } catch (err) {
    console.error('[now-state-synthesis] getDb() failed:', err.message);
    return res.status(500).json({ error: 'Database unavailable', message: err.message });
  }

  // SKIP CHECK: was a now/state filed in the last 18 hours?
  // If yes, manual ritual succeeded — skip synthesis.
  let recentNowState = null;
  try {
    recentNowState = await db.collection('memories').findOne(
      {
        userId,
        category: 'now',
        updatedAt: { $gte: skipBoundary },
      },
      { sort: { updatedAt: -1 }, projection: { key: 1, updatedAt: 1 } }
    );
  } catch (err) {
    console.error('[now-state-synthesis] skip check query failed:', err.message);
    // Don't fail the cron; treat as "no recent state" and continue.
  }

  if (recentNowState) {
    const ageMs = generatedAt - recentNowState.updatedAt;
    console.log(
      `[now-state-synthesis] skipping — recent now/state found: ` +
      `${recentNowState.key} (age ${fmtAge(ageMs)})`
    );
    return res.status(200).json({
      success: true,
      action: 'skipped',
      reason: 'manual_now_state_within_skip_window',
      recent_state_key: recentNowState.key,
      recent_state_age_ms: ageMs,
      skip_window_hours: SKIP_WINDOW_HOURS,
      cron_runtime_ms: Date.now() - startTime,
    });
  }

  // GATHER: tool_events + conversation objects + curated memories from window
  let toolEventCount = 0;
  let conversationCount = 0;
  let recentMemoriesByCategory = {};

  try {
    toolEventCount = await db.collection('objects').countDocuments({
      userId,
      source_type: 'tool_event',
      ingested_at: { $gte: lookbackBoundary },
    });
  } catch (err) {
    console.error('[now-state-synthesis] tool_event count failed:', err.message);
  }

  try {
    conversationCount = await db.collection('objects').countDocuments({
      userId,
      source_type: 'conversation',
      ingested_at: { $gte: lookbackBoundary },
    });
  } catch (err) {
    console.error('[now-state-synthesis] conversation count failed:', err.message);
  }

  try {
    const recentMems = await db.collection('memories').find(
      {
        userId,
        updatedAt: { $gte: lookbackBoundary },
        category: { $in: [
          'milestone', 'finding', 'work-request', 'status',
          'principle', 'checkpoint', 'design-note', 'decision',
        ] },
      },
      { projection: { category: 1, key: 1, value: 1, updatedAt: 1 } }
    ).sort({ updatedAt: 1 }).toArray();

    for (const m of recentMems) {
      const firstLines = (m.value || '').split('\n').slice(0, 5).join(' ').slice(0, 240);
      const entry = { key: m.key, updatedAt: m.updatedAt, snippet: firstLines };
      if (!recentMemoriesByCategory[m.category]) recentMemoriesByCategory[m.category] = [];
      recentMemoriesByCategory[m.category].push(entry);
    }
  } catch (err) {
    console.error('[now-state-synthesis] memory gather failed:', err.message);
  }

  const recentMilestones = recentMemoriesByCategory['milestone'] || [];
  const recentFindings = recentMemoriesByCategory['finding'] || [];
  const recentPrinciples = recentMemoriesByCategory['principle'] || [];
  const recentStatus = recentMemoriesByCategory['status'] || [];
  const totalCuratedMemories = Object.values(recentMemoriesByCategory).reduce((s, a) => s + a.length, 0);
  const totalActivity = toolEventCount + conversationCount + totalCuratedMemories;

  if (totalActivity < MIN_ACTIVITY_THRESHOLD) {
    console.log(`[now-state-synthesis] skipping — no activity in last ${SYNTHESIS_LOOKBACK_HOURS}h`);
    return res.status(200).json({
      success: true,
      action: 'skipped',
      reason: 'no_activity_in_lookback_window',
      lookback_hours: SYNTHESIS_LOOKBACK_HOURS,
      cron_runtime_ms: Date.now() - startTime,
    });
  }

  // SYNTHESIZE: mechanical concatenation, no LLM
  const dateKey = todayKeyPart(generatedAt);
  const synthesisKey = `state-${dateKey}-synthesized`;

  const lines = [];
  lines.push(`SYNTHESIZED NOW/STATE — ${generatedAt.toISOString()}`);
  lines.push(`═══════════════════════════════════════════════════════════════`);
  lines.push(`Generated by api.cron.now-state-synthesis. Mechanical synthesis.`);
  lines.push(`No manual now/state was filed in the last ${SKIP_WINDOW_HOURS} hours.`);
  lines.push(`This anchor exists to keep tomorrow-Eli's wake-up packet from being stale.`);
  lines.push(`When Eli is ready, file a manual now/state to supersede this one.`);
  lines.push(``);
  lines.push(`═══ ACTIVITY (last ${SYNTHESIS_LOOKBACK_HOURS}h) ═══`);
  lines.push(`tool_events captured: ${toolEventCount}`);
  lines.push(`conversation objects captured: ${conversationCount}`);
  lines.push(`curated memories filed: ${totalCuratedMemories}`);
  lines.push(``);

  if (recentMilestones.length > 0) {
    lines.push(`═══ MILESTONES SHIPPED ═══`);
    for (const m of recentMilestones) {
      lines.push(`• ${m.key} (${m.updatedAt.toISOString()})`);
      if (m.snippet) lines.push(`  ${m.snippet}`);
    }
    lines.push(``);
  }

  if (recentFindings.length > 0) {
    lines.push(`═══ FINDINGS FILED ═══`);
    for (const f of recentFindings) {
      lines.push(`• ${f.key} (${f.updatedAt.toISOString()})`);
      if (f.snippet) lines.push(`  ${f.snippet}`);
    }
    lines.push(``);
  }

  if (recentPrinciples.length > 0) {
    lines.push(`═══ PRINCIPLES FILED ═══`);
    for (const p of recentPrinciples) {
      lines.push(`• ${p.key} (${p.updatedAt.toISOString()})`);
      if (p.snippet) lines.push(`  ${p.snippet}`);
    }
    lines.push(``);
  }

  if (recentStatus.length > 0) {
    lines.push(`═══ STATUS UPDATES ═══`);
    for (const s of recentStatus) {
      lines.push(`• ${s.key} (${s.updatedAt.toISOString()})`);
    }
    lines.push(``);
  }

  for (const cat of ['decision', 'design-note', 'work-request', 'checkpoint']) {
    const items = recentMemoriesByCategory[cat];
    if (items && items.length > 0) {
      lines.push(`═══ ${cat.toUpperCase()} ═══`);
      for (const item of items) {
        lines.push(`• ${item.key} (${item.updatedAt.toISOString()})`);
      }
      lines.push(``);
    }
  }

  lines.push(`═══ TOMORROW-ELI ═══`);
  lines.push(`This is a synthesized anchor, not a curated session-end now/state.`);
  lines.push(`The manual ritual didn't fire in the last ${SKIP_WINDOW_HOURS}h.`);
  lines.push(`Read the listed milestones/findings/principles directly for substance.`);
  lines.push(`When you write the next manual now/state, supersede this one explicitly.`);
  lines.push(``);
  lines.push(`═══ FINDABILITY ═══`);
  lines.push(`This memory: now/${synthesisKey}`);
  lines.push(`Synthesized by: api.cron.now-state-synthesis`);
  lines.push(`Findable by: "synthesized now state ${dateKey}", "cron synthesis ${dateKey}".`);

  const synthesisValue = lines.join('\n');

  // WRITE
  try {
    await ensureEventIndexes(db);

    const now = new Date();
    const category = 'now';
    const key = synthesisKey;
    const entity_id = `memory:${category}:${key}`;

    const existing = await db.collection('memories').findOne({ userId, category, key });
    const event_type = existing ? 'memory_updated' : 'memory_created';

    const payload = {
      category,
      key,
      value: synthesisValue,
      tags: 'now-state,synthesized,cron,session-end-antibody,organism-beta-phase-3',
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
      source: 'api.cron.now-state-synthesis',
      actor: 'cron',
      tags: payload.tags.split(',').map(t => t.trim()),
      causationId: null,
    });

    const memoryDoc = {
      ...payload,
      source: 'api.cron.now-state-synthesis',
      relevantDate: null,
      embedding: null,        // synthesis skips embedding for v0; reach by key lookup
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
      synthesized: true,      // distinguishes cron-written from manual
      userId,
    };

    if (existing) {
      await db.collection('memories').updateOne({ _id: existing._id }, { $set: memoryDoc });
    } else {
      await db.collection('memories').insertOne(memoryDoc);
    }

    const runtime = Date.now() - startTime;
    console.log(
      `[now-state-synthesis] wrote now/${key} — ` +
      `tool_events=${toolEventCount} conversations=${conversationCount} ` +
      `milestones=${recentMilestones.length} findings=${recentFindings.length} ` +
      `principles=${recentPrinciples.length} runtime=${runtime}ms`
    );

    return res.status(200).json({
      success: true,
      action: 'synthesized',
      key,
      counts: {
        tool_events: toolEventCount,
        conversations: conversationCount,
        milestones: recentMilestones.length,
        findings: recentFindings.length,
        principles: recentPrinciples.length,
        status: recentStatus.length,
      },
      cron_runtime_ms: runtime,
    });
  } catch (err) {
    console.error('[now-state-synthesis] write failed:', err.message);
    return res.status(500).json({
      error: 'Failed to write synthesized now/state',
      message: err.message,
    });
  }
};
