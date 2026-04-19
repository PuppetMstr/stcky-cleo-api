// _lib/federation.js
//
// STCKY Federation — foundational primitives
// Version: 0.1-lock (April 19, 2026, post-Chaos architect review)
//
// Philosophy (per Chaos's architect take Apr 19):
//   "The unit of sharing is not the memory record. It is the answer surface."
// Target STCKY reasons over its own memory locally. Raw records do not
// cross the wire unless policy explicitly authorizes fidelity=raw.
//
// CHANGES FROM v0.1 INITIAL (per Chaos's lock-state review):
//   - from_identity, trace_id, thread are now REQUIRED on federation requests.
//     source_stcky is the server/instance; from_identity is the acting agent.
//     These are distinct concepts and the protocol names both.
//   - Fidelity split into three distinct concepts:
//       requested_fidelity  — what caller asked for
//       allowed_fidelity    — what policy permits (ceiling)
//       delivered_fidelity  — what actually came back
//     Never conflated in responses or audit.
//   - Policy rule grammar reserves three keys for v0.2:
//       contexts, retention, redaction_profile
//   - Added FEDERATION_EVENT_TYPES extending v1.0 event vocabulary.
//   - Boundary clarifications on fidelity rungs (existence doesn't leak counts;
//     cited is narrower than raw forever; yes_no requires confidence threshold;
//     summary is non-attributive by default).
//
// This module owns: envelope schema, fidelity ladder, policy grammar, request shape.
// It does NOT own I/O (DB, HTTP). Handlers own that. This is pure logic.

const crypto = require('crypto');

// ============================================================
// CONSTANTS
// ============================================================

const FEDERATION_VERSION = '0.1-lock';

// Fidelity ladder — rungs ordered from most restrictive to least.
// Per Chaos: cited is NARROWER than raw forever. Cited is not "raw with quotes."
const FIDELITY_LEVELS = [
  'deny',       // 0: refuse outright
  'existence',  // 1: "relevant material exists" / "no relevant material" (no counts)
  'yes_no',     // 2: boolean answer, confidence threshold required
  'summary',    // 3: synthesized paraphrase, non-attributive by default
  'cited',      // 4: answer + local evidence handles/refs (NOT raw excerpts)
  'redacted',   // 5: record contents with policy-driven redaction applied
  'raw',        // 6: raw records (v0.2: requires category/domain allowlist)
];
const FIDELITY_RANK = Object.fromEntries(FIDELITY_LEVELS.map((f, i) => [f, i]));

const MESSAGE_TYPES = new Set(['brief', 'response', 'question', 'decision', 'handoff']);
const MESSAGE_STATUSES = new Set(['open', 'answered', 'closed']);
const FEDERATION_TYPES = new Set(['federation_ask', 'federation_answer', 'federation_denied']);

// Federation event_types — extend v1.0 event log vocabulary per Chaos Q4.
// Single events collection, these names make audit queries filterable.
const FEDERATION_EVENT_TYPES = new Set([
  'federation_ask',
  'federation_answer',
  'federation_deny',
  'policy_change',
]);

// Reserved policy keys (v0.2). Validator accepts but does not enforce.
const RESERVED_POLICY_KEYS = ['contexts', 'retention', 'redaction_profile'];

// Reserved envelope keys (v0.2+). Pass-through so v0.2 callers aren't rejected.
const RESERVED_ENVELOPE_KEYS = [
  'reply_mode', 'capability_id', 'ttl_seconds', 'deadline_at',
  'client_version', 'policy_context',
];

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

  if (!/^[a-z0-9_-]+-\d{4}-\d{2}-\d{2}$/.test(meta.thread)) {
    throw new FederationError(
      `META.thread '${meta.thread}' must match <topic>-<YYYY-MM-DD>`,
      'ENVELOPE_THREAD_INVALID'
    );
  }

  // Federation-type messages require trace_id, source_stcky, target_stcky.
  if (FEDERATION_TYPES.has(meta.type)) {
    for (const field of ['source_stcky', 'target_stcky', 'trace_id']) {
      if (!meta[field] || typeof meta[field] !== 'string') {
        throw new FederationError(
          `META.${field} required on federation-type messages`,
          'ENVELOPE_FEDERATION_FIELD_MISSING'
        );
      }
    }
  }

  const normalized = {
    from: meta.from,
    to: meta.to,
    thread: meta.thread,
    type: meta.type,
    status: meta.status,
    replyTo: meta.replyTo || null,
    summary: meta.summary || null,
    source_stcky: meta.source_stcky || null,
    target_stcky: meta.target_stcky || null,
    requested_fidelity: meta.requested_fidelity || null,
    allowed_fidelity: meta.allowed_fidelity || null,
    delivered_fidelity: meta.delivered_fidelity || null,
    purpose: meta.purpose || null,
    trace_id: meta.trace_id || null,
  };

  for (const key of RESERVED_ENVELOPE_KEYS) {
    if (key in meta) normalized[key] = meta[key];
  }

  return normalized;
}

function renderMessageValue(meta, body) {
  const normalized = validateEnvelope(meta);
  if (typeof body !== 'string' || body.length === 0) {
    throw new FederationError('BODY required and must be non-empty string', 'BODY_MISSING');
  }
  return `META\n${JSON.stringify(normalized, null, 2)}\n\nBODY\n${body}`;
}

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

function renderTags(meta, extraTags = []) {
  const parts = [
    meta.from,
    meta.to,
    meta.thread.replace(/-\d{4}-\d{2}-\d{2}$/, ''),
    `thread:${meta.thread}`,
    `type:${meta.type}`,
    `status:${meta.status}`,
    ...extraTags,
  ];
  return parts.filter(Boolean).join(',');
}

function generateMessageKey(meta, date = new Date()) {
  const ts = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return `${meta.thread}-${ts}-${meta.from}-to-${meta.to}`;
}

// ============================================================
// FIDELITY LADDER
// ============================================================

function minFidelity(a, b) {
  if (!FIDELITY_LEVELS.includes(a)) throw new FederationError(`Unknown fidelity: ${a}`);
  if (!FIDELITY_LEVELS.includes(b)) throw new FederationError(`Unknown fidelity: ${b}`);
  return FIDELITY_RANK[a] <= FIDELITY_RANK[b] ? a : b;
}

function isFidelityAllowed(requested, maxAllowed) {
  return FIDELITY_RANK[requested] <= FIDELITY_RANK[maxAllowed];
}

/**
 * Apply fidelity downgrade to retrieved records.
 * This is the membrane. Raw records only cross when fidelity === 'raw'.
 *
 * Boundary clarifications per Chaos:
 * - existence: no counts leak
 * - yes_no: must require confidence; v0.2 LLM returns insufficient_confidence if unclear
 * - summary: non-attributive (no record refs in answer)
 * - cited: answer + evidence HANDLES only (never raw excerpts); narrower than raw forever
 * - redacted: v0.1 regex bootstrap; v0.2 policy-driven redaction_profile
 * - raw: v0.2 requires category/domain allowlist
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
          ? 'Relevant material exists.'
          : 'No relevant material.',
        records: [],
      };

    case 'yes_no':
      return {
        fidelity,
        answer: records.length > 0 ? 'yes' : 'no',
        records: [],
        requires_reasoning: true,
        confidence_threshold_required: true,
      };

    case 'summary':
      return {
        fidelity,
        answer: null,
        records: [],
        requires_reasoning: true,
        attribution: 'none',
        reasoning_input: records.map(r => ({ category: r.category, key: r.key, value: r.value })),
      };

    case 'cited':
      return {
        fidelity,
        answer: null,
        records: [],
        requires_reasoning: true,
        attribution: 'handles_only',
        citations: records.map(r => ({ category: r.category, key: r.key })),
        reasoning_input: records.map(r => ({ category: r.category, key: r.key, value: r.value })),
      };

    case 'redacted': {
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
      return { fidelity, answer: null, records: redacted, redaction_mode: 'v0.1-regex-bootstrap' };
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
  // Reserved v0.2 keys: accept but don't enforce (light type check only).
  if ('contexts' in rule && !Array.isArray(rule.contexts)) {
    throw new FederationError('Rule.contexts must be array when present (reserved v0.2)');
  }
  if ('retention' in rule && (typeof rule.retention !== 'object' || rule.retention === null)) {
    throw new FederationError('Rule.retention must be object when present (reserved v0.2)');
  }
  if ('redaction_profile' in rule && typeof rule.redaction_profile !== 'string') {
    throw new FederationError('Rule.redaction_profile must be string when present (reserved v0.2)');
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
 * Returns { allowed, allowed_fidelity, matched_rule_id, reason }.
 */
function evaluatePolicy(policy, request) {
  const now = new Date();

  if (!policy || !Array.isArray(policy.rules) || policy.rules.length === 0) {
    return { allowed: false, allowed_fidelity: 'deny', matched_rule_id: null, reason: 'no_policy_rules' };
  }

  for (const rule of policy.rules) {
    if (rule.expires_at && new Date(rule.expires_at) < now) continue;

    const sourceMatch = rule.source_stcky === '*' || rule.source_stcky === request.source_stcky;
    const identityMatch = rule.from_identity === '*' || rule.from_identity === request.from_identity;
    const domainMatch = matchesArray(request.domain || '*', rule.domains);
    const categoryMatch = matchesArray(request.category || '*', rule.categories);
    const purposeMatch = matchesArray(request.purpose || '*', rule.purposes);

    if (sourceMatch && identityMatch && domainMatch && categoryMatch && purposeMatch) {
      const requested = request.requested_fidelity || 'summary';
      if (!FIDELITY_LEVELS.includes(requested)) {
        return { allowed: false, allowed_fidelity: 'deny', matched_rule_id: rule.id, reason: 'invalid_requested_fidelity' };
      }
      const granted = minFidelity(requested, rule.max_fidelity);
      if (granted === 'deny') {
        return { allowed: false, allowed_fidelity: 'deny', matched_rule_id: rule.id, reason: 'rule_denies' };
      }
      return { allowed: true, allowed_fidelity: granted, matched_rule_id: rule.id, reason: 'rule_matched' };
    }
  }

  return { allowed: false, allowed_fidelity: 'deny', matched_rule_id: null, reason: 'no_matching_rule' };
}

// ============================================================
// FEDERATION REQUEST SHAPE
// ============================================================

function generateTraceId() {
  return 'fed_' + crypto.randomBytes(8).toString('hex');
}

/**
 * Validate a federation request envelope.
 *
 * v0.1-lock required fields (Chaos Q1):
 *   source_stcky, target_user, from_identity, question,
 *   requested_fidelity, purpose, thread
 *
 * trace_id is auto-generated by the handler if the caller omits it,
 * and returned for the caller to reuse in subsequent turns. In v0.2
 * signed cross-instance mode, caller MUST provide it.
 */
function validateFederationRequest(request) {
  if (!request || typeof request !== 'object') {
    throw new FederationError('Federation request required', 'REQUEST_MISSING');
  }
  const required = [
    'source_stcky', 'target_user', 'from_identity',
    'question', 'requested_fidelity', 'purpose', 'thread',
  ];
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
  if (!/^[a-z0-9_-]+-\d{4}-\d{2}-\d{2}$/.test(request.thread)) {
    throw new FederationError(
      `thread '${request.thread}' must match <topic>-<YYYY-MM-DD>`,
      'REQUEST_THREAD_INVALID'
    );
  }
  return true;
}

module.exports = {
  FEDERATION_VERSION,
  FIDELITY_LEVELS,
  FIDELITY_RANK,
  MESSAGE_TYPES,
  MESSAGE_STATUSES,
  FEDERATION_TYPES,
  FEDERATION_EVENT_TYPES,
  RESERVED_POLICY_KEYS,
  RESERVED_ENVELOPE_KEYS,
  FederationError,

  validateEnvelope,
  renderMessageValue,
  parseMessageValue,
  renderTags,
  generateMessageKey,

  minFidelity,
  isFidelityAllowed,
  applyFidelity,

  validateRule,
  evaluatePolicy,

  validateFederationRequest,
  generateTraceId,
};
