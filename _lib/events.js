// _lib/events.js
//
// STCKY Phase 0 — Event log helpers
// Schema v1.0 (locked April 18, 2026)
// Drop this into cleo-api/_lib/ alongside auth.js and embeddings.js.
//
// Usage from memory.js:
//   const { appendEvent, entityHistory, stateAsOf, changesSince,
//           EVENT_TYPES, PAYLOAD_MODES, SchemaError } = require('./_lib/events');

const crypto = require('crypto');

const SCHEMA_VERSION = '1.0';

const EVENT_TYPES = new Set([
  'memory_created',
  'memory_updated',
  'memory_versioned',
  'belief_revised',
  'decision_made',
  'relationship_created',
  'relationship_updated',
  'task_completed',
  'observation_logged',
]);

const PAYLOAD_MODES = new Set(['whole_state', 'field_patch', 'json_patch']);

class SchemaError extends Error {
  constructor(msg) { super(msg); this.name = 'SchemaError'; }
}

// Content-addressed event id. Deterministic: same event → same id (idempotent replay-safe).
function eventId(evt) {
  const keys = Object.keys(evt).sort();
  const canonical = JSON.stringify(evt, keys);
  return 'evt_' + crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

function validate({ event_type, payload_mode, source, payload }) {
  if (!EVENT_TYPES.has(event_type)) {
    throw new SchemaError(
      `event_type '${event_type}' not in controlled vocabulary. Allowed: ${[...EVENT_TYPES].join(', ')}`
    );
  }
  if (!PAYLOAD_MODES.has(payload_mode)) {
    throw new SchemaError(
      `payload_mode '${payload_mode}' invalid. Allowed: ${[...PAYLOAD_MODES].join(', ')}`
    );
  }
  if (!source || !source.includes('.')) {
    throw new SchemaError(
      `source must follow provider.interface.conversation_id format. Got: ${source}`
    );
  }
  if (payload_mode === 'field_patch') {
    if (!payload || typeof payload !== 'object' || !('field' in payload) || !('new_value' in payload)) {
      throw new SchemaError(`field_patch payload must be { field, new_value }`);
    }
  }
  if (payload_mode === 'json_patch') {
    throw new SchemaError('json_patch not implemented in v1.0. Reserved for v1.1.');
  }
}

/**
 * Append an immutable event to the events collection.
 * Returns { event_id, prev_event_id } — caller can stamp prev_event_id onto the memory doc.
 *
 * Required:  db, userId, entity_id, event_type, payload_mode, payload, source, actor
 * Optional:  tags, causationId, confidence, projectId
 */
async function appendEvent(db, {
  userId, projectId = null,
  entity_id, event_type, payload_mode, payload,
  source, actor,
  tags = [], causationId = null, confidence = 1.0,
}) {
  validate({ event_type, payload_mode, source, payload });

  // Look up previous event on this entity to build the chain.
  const prev = await db.collection('events')
    .find({ userId, entity_id })
    .sort({ timestamp: -1 })
    .limit(1)
    .toArray();
  const prev_event_id = prev.length ? prev[0].event_id : null;

  const timestamp = new Date();
  const doc = {
    schema_version: SCHEMA_VERSION,
    userId,
    projectId,
    entity_id,
    event_type,
    timestamp,
    actor,
    source,
    payload_mode,
    payload,
    prev_event_id,
    causation_id: causationId,
    tags,
    confidence,
  };
  const _id = eventId(doc);
  doc._id = _id;
  doc.event_id = _id;

  // Idempotent insert: if the same event content is appended twice, skip the duplicate.
  try {
    await db.collection('events').insertOne(doc);
  } catch (err) {
    if (err.code !== 11000) throw err; // re-throw anything that isn't a duplicate key
  }

  return { event_id: _id, prev_event_id };
}

/**
 * Apply fold rules to reconstruct state from a sequence of events.
 * Used by stateAsOf and counterfactual queries.
 */
function foldState(state, { event_type, payload_mode, payload, timestamp }) {
  if (event_type === 'task_completed') {
    return { ...state, completed: true, completed_at: timestamp };
  }
  if (payload_mode === 'whole_state') {
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      return { ...state, ...payload };
    }
    return { ...state, value: payload };
  }
  if (payload_mode === 'field_patch') {
    return { ...state, [payload.field]: payload.new_value };
  }
  return state;
}

// ---------- Read path ----------

async function entityHistory(db, { userId, entity_id }) {
  return db.collection('events')
    .find({ userId, entity_id })
    .sort({ timestamp: 1 })
    .toArray();
}

async function stateAsOf(db, { userId, entity_id, asOf }) {
  const cutoff = asOf instanceof Date ? asOf : new Date(asOf);
  const events = await db.collection('events')
    .find({ userId, entity_id, timestamp: { $lte: cutoff } })
    .sort({ timestamp: 1 })
    .toArray();
  if (events.length === 0) return null;

  let state = {};
  for (const e of events) {
    state = foldState(state, e);
  }
  return { as_of: cutoff.toISOString(), state, events_replayed: events.length };
}

async function changesSince(db, { userId, since, entity_id, event_type, limit = 100 }) {
  const sinceDate = since instanceof Date ? since : new Date(since);
  const filter = { userId, timestamp: { $gt: sinceDate } };
  if (entity_id) filter.entity_id = entity_id;
  if (event_type) filter.event_type = event_type;
  return db.collection('events')
    .find(filter)
    .sort({ timestamp: 1 })
    .limit(parseInt(limit))
    .toArray();
}

// ---------- Index setup ----------

async function ensureIndexes(db) {
  await db.collection('events').createIndex({ userId: 1, entity_id: 1, timestamp: 1 });
  await db.collection('events').createIndex({ userId: 1, timestamp: 1 });
  await db.collection('events').createIndex({ userId: 1, event_type: 1, timestamp: 1 });
  await db.collection('events').createIndex({ userId: 1, actor: 1, timestamp: 1 });
}

module.exports = {
  appendEvent,
  entityHistory,
  stateAsOf,
  changesSince,
  foldState,
  ensureIndexes,
  eventId,
  validate,
  EVENT_TYPES,
  PAYLOAD_MODES,
  SchemaError,
  SCHEMA_VERSION,
};
