// agent-message.js
//
// POST /api/agent-message
//
// Writes a schema-enforced agent-message to the memories collection.
// Enforces the protocol Chaos designed in minimal-agent-message-schema-2026-04-19,
// and events-log integration from Phase 0.
//
// Request body:
//   {
//     meta: {
//       from, to, thread, type, status,           // required
//       replyTo, summary,                          // optional
//       source_stcky, target_stcky,                // federation-only (optional)
//       requested_fidelity, purpose, trace_id,     // federation-only (optional)
//     },
//     body: "natural language message body",      // required, non-empty
//     extra_tags: ["optional", "extra", "tags"]   // optional
//   }
//
// Returns: { success, key, category, meta, body, tags, last_event_id, version_count }
//
// Notes:
// - Key is auto-generated per schema: <thread>-<timestamp>-<from>-to-<to>
// - Category is always 'agent-message'
// - Event log is written via memory.js conventions (inherits Phase 0 audit trail)

const { getDb, auth, cors } = require('./_lib/auth');
const { embedMemory } = require('./_lib/embeddings');
const { appendEvent, ensureIndexes } = require('./_lib/events');
const {
  validateEnvelope,
  renderMessageValue,
  renderTags,
  generateMessageKey,
  FederationError,
} = require('./_lib/federation');

let _indexesReady = null;
async function ensureEventIndexes(db) {
  if (!_indexesReady) _indexesReady = ensureIndexes(db).catch((e) => {
    console.error('[agent-message] ensureIndexes failed:', e.message);
    _indexesReady = null;
  });
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
    await ensureEventIndexes(db);

    const { meta, body, extra_tags } = req.body || {};

    // Validate envelope (throws FederationError on invalid input).
    let normalizedMeta;
    try {
      normalizedMeta = validateEnvelope(meta);
    } catch (e) {
      if (e instanceof FederationError) {
        return res.status(400).json({ error: e.message, code: e.code });
      }
      throw e;
    }

    if (typeof body !== 'string' || body.trim().length === 0) {
      return res.status(400).json({ error: 'body required (non-empty string)', code: 'BODY_MISSING' });
    }

    // Generate key per schema.
    const now = new Date();
    const key = generateMessageKey(normalizedMeta, now);
    const category = 'agent-message';
    const value = renderMessageValue(normalizedMeta, body);
    const tags = renderTags(normalizedMeta, Array.isArray(extra_tags) ? extra_tags : []);

    // Check against memory limit (agent-messages count against the quota like any memory).
    const memoryCount = await db.collection('memories').countDocuments({ userId: user._id });
    const limit = user.memoryLimit || 100;
    const existing = await db.collection('memories').findOne({
      userId: user._id, category, key,
    });
    if (!existing && memoryCount >= limit) {
      return res.status(403).json({
        error: 'Memory limit reached',
        limit,
        current: memoryCount,
        upgrade: 'Upgrade to Pro for more memories',
        upgradeUrl: 'https://stcky.ai/pricing.html',
      });
    }

    // Generate embedding (same pipeline as memory.js — agent-messages are first-class memories).
    const embeddingData = await embedMemory({ category, key, value, tags });

    // Append event BEFORE snapshot write (Phase 0 pattern).
    const entity_id = `memory:${category}:${key}`;
    const event_type = existing ? 'memory_updated' : 'memory_created';
    const userIdTail = String(user._id).slice(-6);
    const { event_id, prev_event_id } = await appendEvent(db, {
      userId: user._id,
      entity_id,
      event_type,
      payload_mode: 'whole_state',
      payload: {
        category, key, value,
        tags,
        meta: normalizedMeta,
      },
      source: `api.rest.user_${userIdTail}`,
      actor: normalizedMeta.from || 'user',
      tags: tags.split(',').map(t => t.trim()).filter(Boolean),
      causationId: normalizedMeta.replyTo || null,
    });

    const memoryDoc = {
      userId: user._id,
      category,
      key,
      value,
      tags,
      source: `agent-message.${normalizedMeta.from}`,
      relevantDate: null,
      domain: null,
      anchor: false,
      embedding: embeddingData?.embedding || null,
      embeddingModel: embeddingData?.model || null,
      embeddingDims: embeddingData?.dims || null,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
      lastAccessedAt: now,
      accessCount: existing ? (existing.accessCount || 0) + 1 : 1,
      createdBy: user._id,
      last_event_id: event_id,
      first_event_id: existing ? (existing.first_event_id || event_id) : event_id,
      version_count: existing ? ((existing.version_count || 1) + 1) : 1,
      schema_version: '1.0',
    };

    if (existing) {
      await db.collection('memories').updateOne({ _id: existing._id }, { $set: memoryDoc });
      memoryDoc._id = existing._id;
    } else {
      const result = await db.collection('memories').insertOne(memoryDoc);
      memoryDoc._id = result.insertedId;
    }

    console.log(`[AGENT-MSG] ${normalizedMeta.from} → ${normalizedMeta.to} [${normalizedMeta.thread}] ${key} | event: ${event_id}`);

    return res.json({
      success: true,
      key,
      category,
      meta: normalizedMeta,
      body,
      tags,
      last_event_id: event_id,
      prev_event_id,
      version_count: memoryDoc.version_count,
    });
  } catch (error) {
    console.error('Agent-message error:', error);
    return res.status(500).json({ error: 'Internal server error', details: error.message });
  }
};
