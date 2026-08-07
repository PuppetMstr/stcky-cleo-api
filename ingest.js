// ingest.js
//
// POST /api/ingest
//
// STCKY Blob Door v0.1 — the "in-door" for content-addressed storage.
// Writes raw content to the objects collection with embedding + Phase 0 event log
// integration. Idempotent via SHA-256 content hash. Chunks content over threshold
// into parent + child objects. Returns structured provenance envelope per Chaos
// architect review (Apr 21, 2026).
//
// Request body:
//   {
//     content:          string,        // required, non-empty
//     source_type:      string,        // required — 'conversation' | 'document' | 'email' | etc.
//     timestamp:        ISO string,    // optional (client_timestamp); defaults to server now
//     source:           string,        // optional — provider.interface.conversation_id
//     speaker:          string,        // optional
//     session_id:       string,        // optional
//     turn_index:       number,        // optional
//     trace_id:         string,        // optional; generated if absent
//     client:           string,        // optional — 'ios' | 'web' | 'api' | ...
//     metadata:         object,        // optional — free-form passthrough
//   }
//
// Response:
//   {
//     object_id, ingested_at, stored, embedded, status,
//     chunk_count, duplicate, retry_pending, children?, provenance: { core, optional }
//   }

const { getDb, auth, cors } = require('./_lib/auth');
const { putObject, ensureObjectIndexes } = require('./_lib/objects');
const { appendEvent, ensureIndexes } = require('./_lib/events');

// One-shot index setup per cold start.
let _indexesReady = null;
async function ensureAllIndexes(db) {
  if (!_indexesReady) {
    _indexesReady = Promise.all([
      ensureIndexes(db),
      ensureObjectIndexes(db),
    ]).catch((e) => {
      console.error('[ingest] ensureIndexes failed:', e.message);
      _indexesReady = null; // allow retry on next request
    });
  }
  return _indexesReady;
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await auth(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const db = await getDb();
    await ensureAllIndexes(db);

    const {
      content,
      source_type,
      timestamp,
      source,
      speaker,
      session_id,
      turn_index,
      trace_id,
      client,
      metadata,
    } = req.body || {};

    if (typeof content !== 'string' || content.trim().length === 0) {
      return res.status(400).json({ error: 'content required (non-empty string)', code: 'CONTENT_MISSING' });
    }
    if (!source_type || typeof source_type !== 'string') {
      return res.status(400).json({ error: 'source_type required', code: 'SOURCE_TYPE_MISSING' });
    }

    // Quota check — count parent objects (not children) against memoryLimit,
    // matching the 1-turn-1-object intent from Chaos Q2.
    //
    // CAPPED Aug 7 2026, Eli. This count runs on EVERY WRITE. Uncapped and
    // unindexed it was reading 41,547 documents per ingest, 14.39 s average,
    // 4.40 hours of cluster execution time a day -- on the one door that must
    // never be slow. An index on { userId, is_parent } now answers it from
    // keys (see ensureObjectIndexes), and the { limit } option stops the count
    // the moment it reaches the quota.
    //
    // THE COMPARISON BELOW IS UNCHANGED. We only ever ask "is the count at or
    // past the limit", so counting past the limit was always wasted work. A
    // capped count answers that identically. The exact figure is still
    // reported in the 403 body -- recomputed uncapped there, where it is rare
    // and where the caller genuinely needs the true number.
    const limit = user.memoryLimit || 100;
    const parentCount = await db.collection('objects').countDocuments({
      userId: user._id,
      is_parent: { $ne: false }, // parents OR single-object (non-chunked) stores
    }, { limit });
    // Allow the dedup path through even at quota — re-ingesting the same content
    // should be a cheap idempotent return, not a 403.
    // We'll only enforce the limit on NEW inserts, which putObject handles by
    // returning duplicate:true without inserting.
    if (parentCount >= limit) {
      // Still call putObject — if it's a duplicate we return success; if it's
      // a new write it'll insert anyway. We check after to decide the response.
      // Simpler: enforce here if this would clearly be a new write, but we can't
      // know without hashing. Cheapest correct path: hash first, check existence, decide.
      const crypto = require('crypto');
      const hash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
      const existing = await db.collection('objects').findOne({ userId: user._id, content_hash: hash });
      if (!existing) {
        // Rare path. The capped count above says "at or past limit"; the caller
        // being refused deserves the real number, so pay for it here only.
        const trueCount = await db.collection('objects').countDocuments({
          userId: user._id,
          is_parent: { $ne: false },
        });
        return res.status(403).json({
          error: 'Object quota reached',
          code: 'QUOTA_REACHED',
          limit,
          current: trueCount,
          upgrade: 'Upgrade to Pro for more storage',
          upgradeUrl: 'https://stcky.ai/pricing.html',
        });
      }
    }

    const result = await putObject(db, user._id, {
      content,
      client_timestamp: timestamp,
      source_type,
      source,
      speaker,
      session_id,
      turn_index,
      trace_id,
      client,
      metadata,
    });

    // Phase 0 event log. One ledger per Chaos Q5. We emit events describing
    // what happened; duplicates still get a search/ingest event so replay
    // order is preserved.
    const userIdTail = String(user._id).slice(-6);
    const eventSource = source || `api.rest.user_${userIdTail}`;
    const actor = speaker || 'user';

    // object_ingested — fires for every PUT (new or duplicate)
    try {
      await appendEvent(db, {
        userId: user._id,
        entity_id: `object:${result.object_id}`,
        event_type: 'object_ingested',
        payload_mode: 'whole_state',
        payload: {
          object_id: result.object_id,
          content_length: content.length,
          source_type,
          chunk_count: result.chunk_count,
          duplicate: result.duplicate,
          status: result.status,
          trace_id: result.provenance.core.trace_id,
        },
        source: eventSource,
        actor,
        tags: [source_type, result.duplicate ? 'duplicate' : 'new'],
      });
    } catch (e) {
      console.error('[ingest] object_ingested event emission failed:', e.message);
    }

    // object_chunked — fires once if content was split
    if (!result.duplicate && result.chunk_count > 1) {
      try {
        await appendEvent(db, {
          userId: user._id,
          entity_id: `object:${result.object_id}`,
          event_type: 'object_chunked',
          payload_mode: 'whole_state',
          payload: {
            parent_object_id: result.object_id,
            chunk_count: result.chunk_count,
            children: (result.children || []).map(c => c.object_id),
          },
          source: eventSource,
          actor,
          tags: [source_type, 'chunked'],
        });
      } catch (e) {
        console.error('[ingest] object_chunked event emission failed:', e.message);
      }
    }

    // object_embedded — fires only on successful embedding (and only for new writes)
    if (!result.duplicate && result.status === 'embedded') {
      try {
        await appendEvent(db, {
          userId: user._id,
          entity_id: `object:${result.object_id}`,
          event_type: 'object_embedded',
          payload_mode: 'whole_state',
          payload: {
            object_id: result.object_id,
            embedded: true,
          },
          source: eventSource,
          actor,
          tags: [source_type],
        });
      } catch (e) {
        console.error('[ingest] object_embedded event emission failed:', e.message);
      }
    }

    console.log(
      `[INGEST] ${actor} → ${source_type} | ${result.object_id} | ` +
      `chunks=${result.chunk_count} status=${result.status} dup=${result.duplicate}`
    );

    return res.status(result.duplicate ? 200 : 201).json({
      object_id: result.object_id,
      ingested_at: result.ingested_at,
      stored: true,
      embedded: result.embedded,
      status: result.status,
      chunk_count: result.chunk_count,
      duplicate: result.duplicate,
      retry_pending: result.retry_pending || false,
      ...(result.children ? { children: result.children } : {}),
      provenance: result.provenance,
    });
  } catch (err) {
    console.error('[INGEST] error:', err);
    if (err.code === 'CONTENT_MISSING' || err.code === 'SOURCE_TYPE_MISSING') {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
};
