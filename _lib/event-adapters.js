// cleo-api/_lib/event-adapters.js
// ---------------------------------------------------------------------------
// RUNG 3 — Retrieval Plane read-side unification
// RUNG 4 — Corrections as superseding events (parseSupersedesFromValue +
//          supersedes_keys in memoryToCanonical's meta; inert unless
//          RUNG_4_MODE is set in associative.js)
//
// Normalizes the three legacy collections (cleo.memories, cleo.objects,
// cleo.events) into a single canonical candidate envelope per Blob Substrate
// Spec v0.2 Section 1, for consumption by the retrieval ranker.
//
// Source priors per Chaos's Rung 3 plan
// (architect-response/rung-3-plan-from-chaos-2026-04-24):
//   - memories:  high trust for facts, medium for continuity
//   - objects:   medium trust for facts, high for continuity (recency-rich)
//   - events:    low trust for facts, high for continuity (audit timeline)
//
// This file is READ-ONLY logic. No writes to any collection, no side effects.
// ---------------------------------------------------------------------------

'use strict';

// --- Constants ---------------------------------------------------------------

// Tools whose tool_events are activity heartbeat, not signal.
// Candidates emitted from these get flags.noisy=true and are downranked
// by the ranker. Start minimal; expand only when evidence warrants.
const NOISY_TOOLS = new Set([
  'get_now',
]);

// Source priors (Chaos, Rung 3 plan, "start simple / tune with logs").
//   trust_fact:       reliability for factual recall
//   trust_continuity: reliability for timeline / "what happened when"
// Both in [0,1]. Tune from shadow-mode logs, not philosophy.
const SOURCE_PRIORS = Object.freeze({
  memories: Object.freeze({ trust_fact: 0.95, trust_continuity: 0.50 }),
  objects:  Object.freeze({ trust_fact: 0.65, trust_continuity: 0.85 }),
  events:   Object.freeze({ trust_fact: 0.40, trust_continuity: 0.95 }),
});

const SUMMARY_MAX_CHARS = 200;
const EMBEDDING_EXPECTED_DIM = 3072; // text-embedding-3-large

// Actor types that count as "known agents" (vs generic system/user).
const KNOWN_AGENT_IDS = new Set([
  'claude', 'claude-unknown', 'chaos', 'eli',
]);

// --- SUPERSEDES line parsing (RUNG 4) ---------------------------------------
// For category=correction memories, parse SUPERSEDES lines from value text.
// Format: "SUPERSEDES: <category>/<key>" (one or more, comma-separated, on
// its own line). Returns array of {category, key} objects, or null if no
// valid line found.
//
// Example values that parse correctly:
//   "SUPERSEDES: pattern/morning-loop-may-1-2026"
//   "SUPERSEDES: pattern/foo, now/state-2026-05-01-0600am"
//
// Lenient: ignores leading whitespace, ignores empty entries, requires both
// category and key non-empty around the slash.

function parseSupersedesFromValue(text) {
  if (!text || typeof text !== 'string') return null;
  const result = [];
  const lines = text.split('\n');
  for (const line of lines) {
    const m = line.match(/^\s*SUPERSEDES:\s*(.+?)\s*$/);
    if (!m) continue;
    const items = m[1].split(',').map(s => s.trim()).filter(Boolean);
    for (const item of items) {
      const slash = item.indexOf('/');
      if (slash > 0 && slash < item.length - 1) {
        const category = item.slice(0, slash).trim();
        const key = item.slice(slash + 1).trim();
        if (category && key) result.push({ category, key });
      }
    }
  }
  return result.length > 0 ? result : null;
}

// --- Helpers ----------------------------------------------------------------

function truncate(s, n) {
  if (!s) return '';
  const str = String(s);
  return str.length > n ? str.slice(0, n) : str;
}

function isoOrNull(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return new Date(v).toISOString();
  return null;
}

// --- Actor synthesis ---------------------------------------------------------
// Every adapter produces a structured actor object per Spec v0.2 Section 1.
// Legacy records rarely carry structured actor data; we synthesize from
// whatever hints are present, defaulting conservatively.

function synthActorForMemory(mem) {
  // Memories are curated by the STCKY owner. If user_id is present, use it;
  // otherwise default to the workspace owner.
  return {
    actor_id: mem.user_id || mem.userId || 'steven',
    actor_type: 'user',
    trust_level: 'owner',
  };
}

function synthActorForObject(obj) {
  const md = obj.metadata || {};
  const speaker = md.speaker || obj.speaker || 'claude-unknown';
  const lower = String(speaker).toLowerCase();
  const isAgent = KNOWN_AGENT_IDS.has(lower) ||
                  lower.startsWith('claude') ||
                  lower.startsWith('gpt') ||
                  lower.startsWith('eli') ||
                  lower.startsWith('chaos');
  return {
    actor_id: speaker,
    actor_type: isAgent ? 'agent' : (speaker === 'steven' ? 'user' : 'agent'),
    trust_level: isAgent ? 'session' : 'owner',
  };
}

function synthActorForEvent(evt) {
  const actor = evt.actor || 'system';
  const lower = String(actor).toLowerCase();

  let actor_type;
  let trust_level;
  if (lower === 'steven') {
    actor_type  = 'user';
    trust_level = 'owner';
  } else if (KNOWN_AGENT_IDS.has(lower) ||
             lower.startsWith('claude') ||
             lower.startsWith('chaos')  ||
             lower.startsWith('eli')    ||
             lower.startsWith('gpt')) {
    actor_type  = 'agent';
    trust_level = 'session';
  } else {
    actor_type  = 'system';
    trust_level = 'system';
  }

  return { actor_id: actor, actor_type, trust_level };
}

// --- Kind synthesis ---------------------------------------------------------

function synthKindForObject(obj) {
  const sourceType = obj.source_type || obj.sourceType;
  if (sourceType === 'tool_event') {
    const md = obj.metadata || {};
    const et = md.event_type;
    if (et === 'tool_call_started')   return 'tool_call_started';
    if (et === 'tool_call_completed') return 'tool_call_completed';
    if (et === 'tool_call_failed')    return 'tool_call_failed';
    // Rung 1 tool_events without explicit event_type default to completed.
    return 'tool_call_completed';
  }
  if (sourceType === 'conversation') return 'user_message'; // conservative
  if (sourceType === 'document')     return 'object_ingested';
  return 'object_ingested';
}

// --- Flags synthesis --------------------------------------------------------

function synthFlagsForObject(obj) {
  const sourceType = obj.source_type || obj.sourceType;
  let noisy = false;
  if (sourceType === 'tool_event') {
    const md = obj.metadata || {};
    const toolName = md.tool_name || md.toolName;
    if (toolName && NOISY_TOOLS.has(toolName)) noisy = true;
    // Also honor explicit noisy flag if upstream set it.
    if (md.noisy === true) noisy = true;
  }
  return { noisy, sensitive: false, synthetic: false };
}

// --- Enrichment state -------------------------------------------------------
// CRITICAL: "Never make embedding pending equal invisible" (Chaos, Spec Sec 3).
// This field only informs the ranker how to weight semantic vs lexical scores.
// A pending candidate still surfaces; it just relies on lexical/recency until
// its embedding lands.

function enrichmentStateForObject(obj) {
  if (obj.embedding &&
      Array.isArray(obj.embedding) &&
      obj.embedding.length === EMBEDDING_EXPECTED_DIM) {
    return { state: 'complete', artifacts: ['embedding:text-embedding-3-large'] };
  }
  if (obj.embedding_state === 'failed') {
    return { state: 'failed', artifacts: [] };
  }
  return { state: 'pending', artifacts: [] };
}

// --- Adapters ---------------------------------------------------------------

/**
 * Normalize a legacy memory document into a canonical candidate envelope.
 * @param {Object} mem - document from cleo.memories
 * @returns {Object|null} canonical envelope, or null if input invalid
 */
function memoryToCanonical(mem) {
  if (!mem || !mem._id) return null;
  const id       = String(mem._id);
  const tsHuman  = isoOrNull(mem.relevantDate) ||
                   isoOrNull(mem.createdAt) ||
                   new Date(0).toISOString();
  const tsCommit = isoOrNull(mem.createdAt) || tsHuman;
  const payload  = mem.value || '';

  // RUNG 4: parse SUPERSEDES line for category=correction memories.
  // Inert if category is anything else (returns null, which the resolver
  // treats as "this memory does not supersede anything").
  const supersedes_keys = (mem.category === 'correction')
    ? parseSupersedesFromValue(payload)
    : null;

  return {
    event_id: `mem_${id}`,
    seq: null,
    snapshot: null,
    ts_human: tsHuman,
    ts_commit: tsCommit,
    actor: synthActorForMemory(mem),
    session_id: null,
    thread_id: null,
    kind: 'memory_promoted',
    parent_event_id: null,
    call_id: null,
    fingerprint: null,
    payload_ref: null,
    payload,
    summary: truncate(payload, SUMMARY_MAX_CHARS),
    status: 'committed',
    flags: { noisy: false, sensitive: false, synthetic: false },
    // Legacy memories have been indexed for months; assume complete.
    enrichment: { state: 'complete', artifacts: ['embedding:legacy'] },
    trust: SOURCE_PRIORS.memories,
    meta: {
      source_collection: 'memories',
      legacy_id: id,
      legacy_fields: {
        category: mem.category || null,
        key: mem.key || null,
        domain: mem.domain || null,
        tags: mem.tags || null,
        anchor: mem.anchor === true,
      },
      supersedes_keys, // RUNG 4: null unless category=correction with valid SUPERSEDES line
    },
  };
}

/**
 * Normalize a legacy object document into a canonical candidate envelope.
 * Handles both ingest-v0.1 records and Rung 1 tool_events.
 * @param {Object} obj - document from cleo.objects
 * @returns {Object|null} canonical envelope, or null if input invalid
 */
function objectToCanonical(obj) {
  if (!obj) return null;
  const id = obj.object_id || (obj._id && String(obj._id));
  if (!id) return null;
  const md       = obj.metadata || {};
  const tsHuman  = isoOrNull(obj.timestamp) ||
                   isoOrNull(obj.createdAt) ||
                   new Date(0).toISOString();
  const tsCommit = isoOrNull(obj.createdAt) || tsHuman;
  const payload  = obj.content || '';

  return {
    event_id: `obj_${id}`,
    seq: md.seq || null,
    snapshot: null,
    ts_human: tsHuman,
    ts_commit: tsCommit,
    actor: synthActorForObject(obj),
    session_id: obj.session_id || md.session_id || null,
    thread_id: md.thread_id || null,
    kind: synthKindForObject(obj),
    parent_event_id: md.parent_call_id ? `obj_call_${md.parent_call_id}` : null,
    call_id: md.call_id || null,
    fingerprint: md.fingerprint || null,
    payload_ref: null,
    payload,
    summary: truncate(payload, SUMMARY_MAX_CHARS),
    status: 'committed',
    flags: synthFlagsForObject(obj),
    enrichment: enrichmentStateForObject(obj),
    trust: SOURCE_PRIORS.objects,
    meta: {
      source_collection: 'objects',
      legacy_id: id,
      legacy_fields: {
        source_type: obj.source_type || obj.sourceType || null,
        source: obj.source || null,
        speaker: md.speaker || obj.speaker || null,
        tool_name: md.tool_name || null,
      },
    },
  };
}

/**
 * Normalize a legacy event document into a canonical candidate envelope.
 * @param {Object} evt - document from cleo.events
 * @returns {Object|null} canonical envelope, or null if input invalid
 */
function eventToCanonical(evt) {
  if (!evt || !evt._id) return null;
  const id       = String(evt._id);
  const md       = evt.metadata || (typeof evt.payload === 'object' ? evt.payload : {}) || {};
  const tsHuman  = isoOrNull(md.ts_human) ||
                   isoOrNull(evt.createdAt) ||
                   new Date(0).toISOString();
  const tsCommit = isoOrNull(evt.createdAt) || tsHuman;
  const payloadText = typeof evt.payload === 'string'
    ? evt.payload
    : (evt.payload ? JSON.stringify(evt.payload) : '');
  const summaryText = `${evt.type || 'event'} — ${truncate(payloadText, 150)}`;

  return {
    event_id: `evt_${id}`,
    seq: null,
    snapshot: null,
    ts_human: tsHuman,
    ts_commit: tsCommit,
    actor: synthActorForEvent(evt),
    session_id: md.session_id || null,
    thread_id: md.thread_id || null,
    kind: evt.type || 'unknown_event',
    parent_event_id: md.parent_event_id || null,
    call_id: md.call_id || null,
    fingerprint: null,
    payload_ref: null,
    payload: payloadText,
    summary: truncate(summaryText, SUMMARY_MAX_CHARS),
    status: 'committed',
    flags: { noisy: false, sensitive: false, synthetic: false },
    // Events aren't semantically embedded by default; rely on lexical/recency.
    enrichment: { state: 'skipped', artifacts: [] },
    trust: SOURCE_PRIORS.events,
    meta: {
      source_collection: 'events',
      legacy_id: id,
      legacy_fields: {
        type: evt.type || null,
        target_ref: evt.target_ref || evt.targetRef || null,
      },
    },
  };
}

// --- Exports ----------------------------------------------------------------

module.exports = {
  // adapters
  memoryToCanonical,
  objectToCanonical,
  eventToCanonical,

  // exported for ranker + tests + tuning
  NOISY_TOOLS,
  SOURCE_PRIORS,
  SUMMARY_MAX_CHARS,
  EMBEDDING_EXPECTED_DIM,

  // RUNG 4: exported for unit tests
  parseSupersedesFromValue,
};
