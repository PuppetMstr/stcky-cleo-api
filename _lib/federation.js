// _lib/federation.js
//
// STCKY Federation — foundational primitives
// Version: 0.1 (April 19, 2026)
//
// Philosophy (per Chaos's architect take Apr 19):
//   "The unit of sharing is not the memory record. It is the answer surface."
// Target STCKY reasons over its own memory locally. Raw records do not
// cross the wire unless policy explicitly authorizes fidelity=raw.
//
// This module owns:
//   1. Agent-message envelope schema + validator
//   2. Fidelity ladder (all 7 levels from day one)
//   3. Policy grammar + evaluator
//   4. Federation request/response shape
//
// It does NOT own I/O (DB, HTTP). Handlers own that. This is pure logic.

const crypto = require('crypto');

// ============================================================
// CONSTANTS
// ============================================================

const FEDERATION_VERSION = '0.1';

// Fidelity ladder — rungs ordered from most restrictive to least.
// Policy expresses max_fidelity; answer cannot exceed it.
const FIDELITY_LEVELS = [
  'deny',       // 0: refuse outright
  'existence',  // 1: "something is known about X" / "nothing is known"
  'yes_no',     // 2: boolean answer to a closed question
  'summary',    // 3: synthesized paraphrase, no direct records
  'cited',      // 4: summary + citation keys (no raw values)
  'redacted',   // 5: record contents with sensitive fields masked
  'raw',        // 6: raw memory records as stored
];
const FIDELITY_RANK = Object.fromEntries(FIDELITY_LEVELS.map((f, i) => [f, i]));

// Agent-message types (from Chaos's minimal-agent-message-schema-2026-04-19)
const MESSAGE_TYPES = new Set(['brief', 'response', 'question', 'decision', 'handoff']);
const MESSAGE_STATUSES = new Set(['open', 'answered', 'closed']);

// Federation-specific message types (extend the base set)
const FEDERATION_TYPES = new Set(['federation_ask', 'federation_answer', 'federation_denied']);

class FederationError extends Error {
  constructor(msg, code = 'FEDERATION_ERROR') {
    super(msg);
    this.name = 'FederationError';
    this.code = code;
  }
}

// ============================================================
// AGENT-MESSAGE ENVELOPE
// ============================================================

/**
 * Validate an agent-message META envelope.
 * Throws FederationError on invalid input.
 * Returns normalized META object.
 */
function validateEnvelope(meta) {
  if (!meta || typeof meta !== 'object') {
    throw new FederationError('META envelope required', 'ENVELOPE_MISSING');
  }

  const required = ['from', 'to', 'thread', 'type', 'status'];
  for (const field of required) {
    if (!meta[field] || typeof meta[field] !== 'string') {
      throw new FederationError(`META.${field} required and must be string`, 'ENVELOPE_INVALID');
    }
  }

  const allTypes = new Set([...MESSAGE_TYPES, ...FEDERATION_TYPES]);
  if (!allTypes.has(meta.type)) {
    throw new FederationError(
      `META.type '${meta.type}' not in allowed set: ${[...allTypes].join(', ')}`,
      'ENVELOPE_TYPE_INVALID'
    );
  }

  if (!MESSAGE_STATUSES.has(meta.status)) {
    throw new FederationError(
      `META.status '${meta.status}' not in allowed set: ${[...MESSAGE_STATUSES].join(', ')}`,
      'ENVELOPE_STATUS_INVALID'
    );
  }

  // Thread format: <topic>-<YYYY-MM-DD>
  if (!/^[a-z0-9_-]+-\d{4}-\d{2}-\d{2}$/.test(meta.thread)) {
    throw new FederationError(
      `META.thread '${meta.thread}' must match <topic>-<YYYY-MM-DD>`,
      'ENVELOPE_THREAD_INVALID'
    );
  }

  return {
    from: meta.from,
    to: meta.to,
    thread: meta.thread,
    type: meta.type,
    status: meta.status,
    replyTo: meta.replyTo || null,
    summary: meta.summary || null,
    // Federation-only fields (optional for non-federation messages)
    source_stcky: meta.source_stcky || null,
    target_stcky: meta.target_stcky || null,
    requested_fidelity: meta.requested_fidelity || null,
    purpose: meta.purpose || null,
    trace_id: meta.trace_id || null,
  };
}

/**
 * Build the canonical storage value for an agent-message.
 * Format: META block (JSON) + blank line + BODY (natural language).
 * Matches Chaos's minimal-agent-message-schema-2026-04-19.
 */
function renderMessageValue(meta, body) {
  const normalized = validateEnvelope(meta);
  if (typeof body !== 'string' || body.length === 0) {
    throw new FederationError('BODY required and must be non-empty string', 'BODY_MISSING');
  }
  return `META\n${JSON.stringify(normalized, null, 2)}\n\nBODY\n${body}`;
}

/**
 * Parse a stored agent-message value back into { meta, body }.
 * Tolerant of extra whitespace. Returns null if not in expected format.
 */
function parseMessageValue(value) {
  if (typeof value !== 'string') return null;
  const metaMatch = value.match(/META\s*\n([\s\S]*?)\n\s*BODY\s*\n([\s\S]*)/);
  if (!metaMatch) return null;
  try {
    const meta = JSON.parse(metaMatch[1]);
    const body = metaMatch[2].trim();
    return { meta, body };
  } catch {
    return null;
  }
}

/**
 * Build the canonical tags string per Chaos's schema.
 * Participants + topic + thread + type + status.
 */
function renderTags(meta, extraTags = []) {
  const parts = [
    meta.from,
    meta.to,
    meta.thread.replace(/-\d{4}-\d{2}-\d{2}$/, ''), // topic (thread minus date)
    `thread:${meta.thread}`,
    `type:${meta.type}`,
    `status:${meta.status}`,
    ...extraTags,
  ];
  return parts.filter(Boolean).join(',');
}

/**
 * Generate a message key matching Chaos's format:
 * <thread>-<timestamp>-<from>-to-<to>
 * Timestamp is UTC ISO basic format YYYYMMDDTHHMMSSZ.
 */
function generateMessageKey(meta, date = new Date()) {
  const ts = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return `${meta.thread}-${ts}-${meta.from}-to-${meta.to}`;
}

// ============================================================
// FIDELITY LADDER
// ============================================================

/**
 * Compare two fidelity levels. Returns the lower (more restrictive) one.
 * Used when policy grants fidelity F_max and caller requests F_req —
 * the response fidelity is min(F_req, F_max).
 */
function minFidelity(a, b) {
  if (!FIDELITY_LEVELS.includes(a)) throw new FederationError(`Unknown fidelity: ${a}`);
  if (!FIDELITY_LEVELS.includes(b)) throw new FederationError(`Unknown fidelity: ${b}`);
  return FIDELITY_RANK[a] <= FIDELITY_RANK[b] ? a : b;
}

function isFidelityAllowed(requested, maxAllowed) {
  return FIDELITY_RANK[requested] <= FIDELITY_RANK[maxAllowed];
}

/**
 * Apply fidelity downgrade to a set of memory records.
 * Target STCKY has already done local retrieval; this is the membrane.
 * Records NEVER leave as-is unless fidelity === 'raw'.
 */
function applyFidelity(records, fidelity, { question } = {}) {
  if (!Array.isArray(records)) records = [];

  switch (fidelity) {
    case 'deny':
      return { fidelity, answer: null, records: [] };

    case 'existence':
      return {
        fidelity,
        answer: records.length > 0
          ? 'Something is known about this topic.'
          : 'Nothing is known about this topic.',
        records: [],
      };

    case 'yes_no': {
      // A real implementation calls the LLM with the records + question.
      // The handler is responsible for that; this function returns shape only.
      return {
        fidelity,
        answer: records.length > 0 ? 'yes' : 'no',
        records: [],
        requires_reasoning: true,
      };
    }

    case 'summary':
      return {
        fidelity,
        answer: null, // handler synthesizes from records
        records: [],
        requires_reasoning: true,
        reasoning_input: records.map(r => ({ category: r.category, key: r.key, value: r.value })),
      };

    case 'cited':
      return {
        fidelity,
        answer: null, // handler synthesizes
        records: [],
        requires_reasoning: true,
        citations: records.map(r => ({ category: r.category, key: r.key })),
        reasoning_input: records.map(r => ({ category: r.category, key: r.key, value: r.value })),
      };

    case 'redacted': {
      // Conservative default: strip anything that looks sensitive.
      // Policy should let owners define their own redaction rules in later versions.
      const SENSITIVE_FIELDS = ['password', 'apiKey', 'ssn', 'dob', 'phone', 'address'];
      const redacted = records.map(r => {
        const safe = { category: r.category, key: r.key, tags: r.tags, updatedAt: r.updatedAt };
        let value = r.value || '';
        for (const field of SENSITIVE_FIELDS) {
          const re = new RegExp(`${field}[^\\s]*`, 'gi');
          value = value.replace(re, `[${field.toUpperCase()}_REDACTED]`);
        }
        safe.value = value;
        return safe;
      });
      return { fidelity, answer: null, records: redacted };
    }

    case 'raw':
      return { fidelity, answer: null, records };

    default:
      throw new FederationError(`Unknown fidelity: ${fidelity}`);
  }
}

// ============================================================
// POLICY GRAMMAR + EVALUATOR
// ============================================================

/**
 * A policy document lives in the `federation_policies` collection, keyed by user.
 *
 * Shape (v0.1):
 * {
 *   userId: ObjectId,
 *   rules: [
 *     {
 *       id: string,                    // human-readable rule id, e.g. "allow-terry-chamber-summary"
 *       source_stcky: string | '*',    // who can ask: their cleo_-prefix id, or '*' for anyone authenticated
 *       from_identity: string | '*',   // the AI agent asking (e.g. 'chaos', 'eli', '*')
 *       domains: string[] | ['*'],     // memory domains this rule applies to
 *       categories: string[] | ['*'],  // memory categories this rule applies to
 *       purposes: string[] | ['*'],    // stated purposes this rule applies to
 *       max_fidelity: string,          // ceiling on fidelity returnable under this rule
 *       expires_at: ISO date | null,
 *       log: true,                     // always log; v0.1 does not allow silent access
 *     }
 *   ],
 *   default_action: 'deny',            // v0.1 is deny-by-default
 *   updated_at: Date,
 * }
 */

function validateRule(rule) {
  if (!rule || typeof rule !== 'object') throw new FederationError('Rule must be object');
  if (!rule.id || typeof rule.id !== 'string') throw new FederationError('Rule.id required');
  if (!rule.max_fidelity || !FIDELITY_LEVELS.includes(rule.max_fidelity)) {
    throw new FederationError(`Rule.max_fidelity must be one of: ${FIDELITY_LEVELS.join(', ')}`);
  }
  for (const field of ['source_stcky', 'from_identity']) {
    if (!rule[field] || typeof rule[field] !== 'string') {
      throw new FederationError(`Rule.${field} required (string or '*')`);
    }
  }
  for (const field of ['domains', 'categories', 'purposes']) {
    if (!Array.isArray(rule[field]) || rule[field].length === 0) {
      throw new FederationError(`Rule.${field} required (array, use ['*'] for any)`);
    }
  }
  return true;
}

function matchesArray(needle, haystack) {
  if (!Array.isArray(haystack)) return false;
  if (haystack.includes('*')) return true;
  return haystack.includes(needle);
}

/**
 * Evaluate a federation request against a policy document.
 * Returns { allowed: bool, max_fidelity, matched_rule_id, reason }.
 *
 * Request shape:
 *   { source_stcky, from_identity, requested_fidelity, domain, category, purpose }
 */
function evaluatePolicy(policy, request) {
  const now = new Date();

  if (!policy || !Array.isArray(policy.rules) || policy.rules.length === 0) {
    return { allowed: false, max_fidelity: 'deny', matched_rule_id: null, reason: 'no_policy_rules' };
  }

  for (const rule of policy.rules) {
    if (rule.expires_at && new Date(rule.expires_at) < now) continue;

    const sourceMatch = rule.source_stcky === '*' || rule.source_stcky === request.source_stcky;
    const identityMatch = rule.from_identity === '*' || rule.from_identity === request.from_identity;
    const domainMatch = matchesArray(request.domain || '*', rule.domains);
    const categoryMatch = matchesArray(request.category || '*', rule.categories);
    const purposeMatch = matchesArray(request.purpose || '*', rule.purposes);

    if (sourceMatch && identityMatch && domainMatch && categoryMatch && purposeMatch) {
      // Matched. Fidelity = min(requested, rule.max_fidelity).
      const requested = request.requested_fidelity || 'summary';
      if (!FIDELITY_LEVELS.includes(requested)) {
        return { allowed: false, max_fidelity: 'deny', matched_rule_id: rule.id, reason: 'invalid_requested_fidelity' };
      }
      const granted = minFidelity(requested, rule.max_fidelity);
      if (granted === 'deny') {
        return { allowed: false, max_fidelity: 'deny', matched_rule_id: rule.id, reason: 'rule_denies' };
      }
      return { allowed: true, max_fidelity: granted, matched_rule_id: rule.id, reason: 'rule_matched' };
    }
  }

  return { allowed: false, max_fidelity: 'deny', matched_rule_id: null, reason: 'no_matching_rule' };
}

// ============================================================
// FEDERATION REQUEST SHAPE
// ============================================================

/**
 * Generate a trace_id for a federation exchange.
 * Format: fed_<shortuuid>. Used across ask → answer pair for audit.
 */
function generateTraceId() {
  return 'fed_' + crypto.randomBytes(8).toString('hex');
}

/**
 * Validate a federation request envelope.
 * Extends the agent-message envelope with federation-required fields.
 */
function validateFederationRequest(request) {
  if (!request || typeof request !== 'object') {
    throw new FederationError('Federation request required', 'REQUEST_MISSING');
  }
  const required = ['source_stcky', 'target_user', 'question', 'requested_fidelity', 'purpose'];
  for (const field of required) {
    if (!request[field]) {
      throw new FederationError(`Federation request.${field} required`, 'REQUEST_INVALID');
    }
  }
  if (!FIDELITY_LEVELS.includes(request.requested_fidelity)) {
    throw new FederationError(
      `requested_fidelity must be one of: ${FIDELITY_LEVELS.join(', ')}`,
      'REQUEST_FIDELITY_INVALID'
    );
  }
  return true;
}

module.exports = {
  // Constants
  FEDERATION_VERSION,
  FIDELITY_LEVELS,
  FIDELITY_RANK,
  MESSAGE_TYPES,
  MESSAGE_STATUSES,
  FEDERATION_TYPES,
  FederationError,

  // Envelope
  validateEnvelope,
  renderMessageValue,
  parseMessageValue,
  renderTags,
  generateMessageKey,

  // Fidelity
  minFidelity,
  isFidelityAllowed,
  applyFidelity,

  // Policy
  validateRule,
  evaluatePolicy,

  // Federation requests
  validateFederationRequest,
  generateTraceId,
};
