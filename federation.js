// federation.js
//
// Federation endpoints — v0.1
//
// Routes (see vercel.json):
//   POST /api/federation/ask      — one STCKY asking another a question
//   GET  /api/federation/policy   — view your own policy document
//   POST /api/federation/policy   — create/update your policy document
//
// PHILOSOPHY (from Chaos's architect take, Apr 19 2026):
//   "The unit of sharing is not the memory record. It is the answer surface."
//   Target STCKY reasons over its own memory locally. Raw records do not cross
//   the wire unless policy explicitly authorizes fidelity=raw.
//
// AUDIT:
//   Every ask writes an 'federation_ask' agent-message to the caller's STCKY.
//   Every response writes an 'federation_answer' or 'federation_denied' to the target's STCKY.
//   Both write events to the schema v1.0 event log.
//   trace_id pairs the two for reconstruction.
//
// LIMITS (v0.1):
//   - Same-server federation only (one MongoDB cluster).
//   - Future: cross-STCKY-instance federation via signed HTTP.
//   - "source_stcky" is the caller's user identity; in v0.2 this becomes a
//     real STCKY-instance identifier.

const { getDb, auth, cors, ObjectId } = require('./_lib/auth');
const { appendEvent, ensureIndexes } = require('./_lib/events');
const { embedMemory } = require('./_lib/embeddings');
const {
  validateFederationRequest,
  validateRule,
  evaluatePolicy,
  applyFidelity,
  generateTraceId,
  renderMessageValue,
  renderTags,
  generateMessageKey,
  FIDELITY_LEVELS,
  FederationError,
} = require('./_lib/federation');

let _indexesReady = null;
async function ensureEventIndexes(db) {
  if (!_indexesReady) _indexesReady = ensureIndexes(db).catch((e) => {
    console.error('[federation] ensureIndexes failed:', e.message);
    _indexesReady = null;
  });
  return _indexesReady;
}

function getAction(url) {
  if (url.includes('/federation/ask')) return 'ask';
  if (url.includes('/federation/policy')) return 'policy';
  return null;
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const caller = await auth(req);
  if (!caller) return res.status(401).json({ error: 'Unauthorized' });

  const action = getAction(req.url);
  if (!action) return res.status(404).json({ error: 'Unknown federation endpoint' });

  const db = await getDb();
  await ensureEventIndexes(db);

  try {
    // ============================================================
    // POLICY MANAGEMENT
    // ============================================================
    if (action === 'policy') {
      if (req.method === 'GET') {
        const policy = await db.collection('federation_policies').findOne({ userId: caller._id });
        if (!policy) {
          return res.json({
            userId: caller._id,
            rules: [],
            default_action: 'deny',
            note: 'No policy defined. Default is deny-all; create rules to allow federation requests.',
          });
        }
        return res.json(policy);
      }

      if (req.method === 'POST') {
        const { rules } = req.body || {};
        if (!Array.isArray(rules)) {
          return res.status(400).json({ error: 'rules array required' });
        }

        // Validate each rule.
        for (const rule of rules) {
          try {
            validateRule(rule);
          } catch (e) {
            return res.status(400).json({
              error: `Invalid rule: ${e.message}`,
              rule_id: rule?.id || null,
            });
          }
        }

        const now = new Date();
        const doc = {
          userId: caller._id,
          rules,
          default_action: 'deny',
          updated_at: now,
        };
        await db.collection('federation_policies').updateOne(
          { userId: caller._id },
          { $set: doc, $setOnInsert: { created_at: now } },
          { upsert: true }
        );

        // Log policy change as an event (policy itself is an audit-worthy change).
        await appendEvent(db, {
          userId: caller._id,
          entity_id: `federation_policy:${caller._id}`,
          event_type: 'decision_made',
          payload_mode: 'whole_state',
          payload: { rules, default_action: 'deny' },
          source: 'api.federation.policy',
          actor: 'user',
          tags: ['federation', 'policy'],
        });

        return res.json({ success: true, rules, default_action: 'deny', updated_at: now });
      }

      return res.status(405).json({ error: 'Method not allowed' });
    }

    // ============================================================
    // FEDERATION ASK
    // ============================================================
    if (action === 'ask') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

      // Validate the federation request.
      const request = req.body || {};
      try {
        validateFederationRequest(request);
      } catch (e) {
        if (e instanceof FederationError) {
          return res.status(400).json({ error: e.message, code: e.code });
        }
        throw e;
      }

      // Resolve target user — either by email or userId.
      const { target_user, source_stcky, from_identity, question, requested_fidelity,
              purpose, domain, category, thread } = request;

      const target = await db.collection('users').findOne(
        target_user.includes('@')
          ? { email: target_user.toLowerCase() }
          : { _id: new ObjectId(target_user) }
      );

      if (!target) {
        return res.status(404).json({ error: 'Target user not found', target_user });
      }

      // Generate trace_id to pair ask ↔ answer.
      const trace_id = generateTraceId();
      const now = new Date();
      const threadId = thread || `federation-${now.toISOString().slice(0, 10)}`;
      const sourceIdentity = from_identity || 'unknown';

      // Load target's policy document.
      const policy = await db.collection('federation_policies').findOne({ userId: target._id });

      // Evaluate policy.
      const decision = evaluatePolicy(policy, {
        source_stcky: source_stcky || String(caller._id),
        from_identity: sourceIdentity,
        requested_fidelity,
        domain,
        category,
        purpose,
      });

      // -------- Write the ASK as agent-message on caller's side --------
      const askMeta = {
        from: sourceIdentity,
        to: target_user,
        thread: threadId,
        type: 'federation_ask',
        status: 'open',
        replyTo: null,
        summary: purpose,
        source_stcky: source_stcky || String(caller._id),
        target_stcky: String(target._id),
        requested_fidelity,
        purpose,
        trace_id,
      };
      const askKey = generateMessageKey(askMeta, now);
      const askValue = renderMessageValue(askMeta, question);
      const askTags = renderTags(askMeta, [`trace:${trace_id}`, 'federation']);
      const askEmbed = await embedMemory({ category: 'agent-message', key: askKey, value: askValue, tags: askTags });

      const { event_id: askEventId } = await appendEvent(db, {
        userId: caller._id,
        entity_id: `memory:agent-message:${askKey}`,
        event_type: 'memory_created',
        payload_mode: 'whole_state',
        payload: { category: 'agent-message', key: askKey, value: askValue, tags: askTags, meta: askMeta },
        source: 'api.federation.ask',
        actor: sourceIdentity,
        tags: ['federation', 'ask', `trace:${trace_id}`],
      });

      await db.collection('memories').insertOne({
        userId: caller._id,
        category: 'agent-message',
        key: askKey,
        value: askValue,
        tags: askTags,
        source: 'api.federation.ask',
        embedding: askEmbed?.embedding || null,
        embeddingModel: askEmbed?.model || null,
        embeddingDims: askEmbed?.dims || null,
        createdAt: now,
        updatedAt: now,
        lastAccessedAt: now,
        accessCount: 1,
        createdBy: caller._id,
        last_event_id: askEventId,
        first_event_id: askEventId,
        version_count: 1,
        schema_version: '1.0',
      });

      // -------- DENIED PATH --------
      if (!decision.allowed) {
        const denyMeta = {
          from: 'stcky',
          to: sourceIdentity,
          thread: threadId,
          type: 'federation_denied',
          status: 'closed',
          replyTo: askKey,
          summary: `Denied: ${decision.reason}`,
          source_stcky: String(target._id),
          target_stcky: source_stcky || String(caller._id),
          requested_fidelity,
          purpose,
          trace_id,
        };
        const denyKey = generateMessageKey(denyMeta, new Date());
        const denyBody = `Request denied by target policy.\nReason: ${decision.reason}\nMatched rule: ${decision.matched_rule_id || 'none'}`;
        const denyValue = renderMessageValue(denyMeta, denyBody);
        const denyTags = renderTags(denyMeta, [`trace:${trace_id}`, 'federation']);
        const denyEmbed = await embedMemory({ category: 'agent-message', key: denyKey, value: denyValue, tags: denyTags });

        const { event_id: denyEventId } = await appendEvent(db, {
          userId: target._id,
          entity_id: `memory:agent-message:${denyKey}`,
          event_type: 'decision_made',
          payload_mode: 'whole_state',
          payload: { category: 'agent-message', key: denyKey, value: denyValue, tags: denyTags, meta: denyMeta, decision },
          source: 'api.federation.ask',
          actor: 'stcky',
          tags: ['federation', 'denied', `trace:${trace_id}`],
          causationId: askKey,
        });

        await db.collection('memories').insertOne({
          userId: target._id,
          category: 'agent-message',
          key: denyKey,
          value: denyValue,
          tags: denyTags,
          source: 'api.federation.ask',
          embedding: denyEmbed?.embedding || null,
          embeddingModel: denyEmbed?.model || null,
          embeddingDims: denyEmbed?.dims || null,
          createdAt: new Date(),
          updatedAt: new Date(),
          lastAccessedAt: new Date(),
          accessCount: 1,
          createdBy: target._id,
          last_event_id: denyEventId,
          first_event_id: denyEventId,
          version_count: 1,
          schema_version: '1.0',
        });

        console.log(`[FEDERATION] DENY ${sourceIdentity} → ${target.email} [${trace_id}] reason=${decision.reason}`);

        return res.status(200).json({
          allowed: false,
          fidelity: 'deny',
          reason: decision.reason,
          matched_rule_id: decision.matched_rule_id,
          trace_id,
          ask_key: askKey,
          answer_key: denyKey,
        });
      }

      // -------- ALLOWED PATH --------
      // Retrieve target's memories locally (respecting scope: domain, category).
      const targetQuery = { userId: target._id };
      if (domain) targetQuery.domain = domain;
      if (category) targetQuery.category = category;
      // Simple text match on question keywords — v0.1 uses regex; v0.2 will use embeddings.
      const keywords = question.split(/\s+/).filter(w => w.length > 3).slice(0, 5);
      if (keywords.length > 0) {
        targetQuery.$or = keywords.flatMap(w => [
          { key: { $regex: w, $options: 'i' } },
          { value: { $regex: w, $options: 'i' } },
          { tags: { $regex: w, $options: 'i' } },
        ]);
      }
      const records = await db.collection('memories')
        .find(targetQuery)
        .sort({ updatedAt: -1 })
        .limit(20)
        .toArray();

      // Apply fidelity ladder. This is the membrane.
      const fidelityResult = applyFidelity(records, decision.max_fidelity, { question });

      // Build answer body. For fidelity levels requiring reasoning (summary/cited/yes_no),
      // v0.1 returns a structural stub; v0.2 will call the LLM for synthesis.
      let answerBody;
      if (fidelityResult.answer) {
        answerBody = fidelityResult.answer;
      } else if (fidelityResult.requires_reasoning) {
        answerBody = `[fidelity=${fidelityResult.fidelity}] Local retrieval returned ${records.length} candidate records. `
          + `Synthesis stub — v0.2 will call target's LLM with records + question. `
          + `Question: "${question}"`;
        if (fidelityResult.citations) {
          answerBody += `\nCitations: ${fidelityResult.citations.map(c => `${c.category}/${c.key}`).join(', ')}`;
        }
      } else if (fidelityResult.records.length > 0) {
        // fidelity=raw or fidelity=redacted: records themselves are the answer.
        answerBody = `Retrieved ${fidelityResult.records.length} record(s) at fidelity=${fidelityResult.fidelity}.`;
      } else {
        answerBody = `No records matched at fidelity=${fidelityResult.fidelity}.`;
      }

      const answerMeta = {
        from: 'stcky',
        to: sourceIdentity,
        thread: threadId,
        type: 'federation_answer',
        status: 'answered',
        replyTo: askKey,
        summary: `Answer at fidelity=${fidelityResult.fidelity}`,
        source_stcky: String(target._id),
        target_stcky: source_stcky || String(caller._id),
        requested_fidelity,
        purpose,
        trace_id,
      };
      const answerKey = generateMessageKey(answerMeta, new Date());
      const answerValue = renderMessageValue(answerMeta, answerBody);
      const answerTags = renderTags(answerMeta, [`trace:${trace_id}`, 'federation', `fidelity:${fidelityResult.fidelity}`]);
      const answerEmbed = await embedMemory({ category: 'agent-message', key: answerKey, value: answerValue, tags: answerTags });

      const { event_id: answerEventId } = await appendEvent(db, {
        userId: target._id,
        entity_id: `memory:agent-message:${answerKey}`,
        event_type: 'memory_created',
        payload_mode: 'whole_state',
        payload: {
          category: 'agent-message',
          key: answerKey,
          value: answerValue,
          tags: answerTags,
          meta: answerMeta,
          fidelity: fidelityResult.fidelity,
          record_count: records.length,
        },
        source: 'api.federation.ask',
        actor: 'stcky',
        tags: ['federation', 'answer', `trace:${trace_id}`, `fidelity:${fidelityResult.fidelity}`],
        causationId: askKey,
      });

      await db.collection('memories').insertOne({
        userId: target._id,
        category: 'agent-message',
        key: answerKey,
        value: answerValue,
        tags: answerTags,
        source: 'api.federation.ask',
        embedding: answerEmbed?.embedding || null,
        embeddingModel: answerEmbed?.model || null,
        embeddingDims: answerEmbed?.dims || null,
        createdAt: new Date(),
        updatedAt: new Date(),
        lastAccessedAt: new Date(),
        accessCount: 1,
        createdBy: target._id,
        last_event_id: answerEventId,
        first_event_id: answerEventId,
        version_count: 1,
        schema_version: '1.0',
      });

      console.log(`[FEDERATION] ALLOW ${sourceIdentity} → ${target.email} [${trace_id}] fidelity=${fidelityResult.fidelity} records=${records.length}`);

      return res.status(200).json({
        allowed: true,
        fidelity: fidelityResult.fidelity,
        matched_rule_id: decision.matched_rule_id,
        trace_id,
        ask_key: askKey,
        answer_key: answerKey,
        answer: answerBody,
        // Records (only populated when fidelity allows — redacted/raw).
        records: fidelityResult.records,
        // Citations (only populated when fidelity=cited).
        citations: fidelityResult.citations || [],
        record_count: records.length,
      });
    }

    return res.status(404).json({ error: 'Unknown federation endpoint' });
  } catch (error) {
    console.error('Federation error:', error);
    if (error instanceof FederationError) {
      return res.status(400).json({ error: error.message, code: error.code });
    }
    return res.status(500).json({ error: 'Internal server error', details: error.message });
  }
};
