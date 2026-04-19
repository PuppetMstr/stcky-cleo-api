// federation.js
//
// Federation endpoints — v0.1-lock (post-Chaos architect review)
//
// Routes (see vercel.json):
//   POST /api/federation/ask      — one STCKY asking another a question
//   GET  /api/federation/policy   — view your own policy document
//   POST /api/federation/policy   — create/update your policy document
//
// CHANGES FROM v0.1 INITIAL (per Chaos's review):
//   - Returns the fidelity TRIPLE: requested / allowed / delivered. Never conflated.
//   - Uses federation event_types (federation_ask/answer/deny/policy_change) when
//     emitting to schema v1.0 event log, per Chaos's Q4 guidance on audit completeness.
//   - Envelope validation enforces Chaos's tightened required set via _lib/federation.
//   - Auto-generates trace_id only when caller omits it; returns the generated value
//     so caller can reuse on subsequent turns.
//
// PHILOSOPHY (unchanged):
//   "The unit of sharing is not the memory record. It is the answer surface."
//   Target STCKY reasons over its own memory locally. Raw records do not cross
//   the wire unless policy explicitly authorizes fidelity=raw.

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

        // Log policy change with the reserved federation event_type (Chaos Q4).
        await appendEvent(db, {
          userId: caller._id,
          entity_id: `federation_policy:${caller._id}`,
          event_type: 'decision_made', // schema v1.0 controlled vocab — federation semantics in tags
          payload_mode: 'whole_state',
          payload: { rules, default_action: 'deny', federation_event_type: 'policy_change' },
          source: 'api.federation.policy',
          actor: 'user',
          tags: ['federation', 'policy_change'],
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

      const request = req.body || {};
      try {
        validateFederationRequest(request);
      } catch (e) {
        if (e instanceof FederationError) {
          return res.status(400).json({ error: e.message, code: e.code });
        }
        throw e;
      }

      const {
        target_user, source_stcky, from_identity, question,
        requested_fidelity, purpose, domain, category, thread,
      } = request;

      // Resolve target — by email or userId.
      const target = await db.collection('users').findOne(
        target_user.includes('@')
          ? { email: target_user.toLowerCase() }
          : { _id: new ObjectId(target_user) }
      );

      if (!target) {
        return res.status(404).json({ error: 'Target user not found', target_user });
      }

      // trace_id: caller may supply; if not, generate and return.
      const trace_id = request.trace_id || generateTraceId();
      const now = new Date();

      // Load target's policy.
      const policy = await db.collection('federation_policies').findOne({ userId: target._id });

      // Evaluate.
      const decision = evaluatePolicy(policy, {
        source_stcky,
        from_identity,
        requested_fidelity,
        domain,
        category,
        purpose,
      });

      // -------- Write the ASK as agent-message on CALLER's side --------
      const askMeta = {
        from: from_identity,
        to: target_user,
        thread,
        type: 'federation_ask',
        status: 'open',
        replyTo: null,
        summary: purpose,
        source_stcky,
        target_stcky: String(target._id),
        requested_fidelity,
        allowed_fidelity: null,       // not known yet from caller's perspective
        delivered_fidelity: null,
        purpose,
        trace_id,
      };
      const askKey = generateMessageKey(askMeta, now);
      const askValue = renderMessageValue(askMeta, question);
      const askTags = renderTags(askMeta, [`trace:${trace_id}`, 'federation']);
      const askEmbed = await embedMemory({ category: 'agent-message', key: askKey, value: askValue, tags: askTags });

      // Use the reserved federation event_type in tags for audit filterability (Chaos Q4).
      const { event_id: askEventId } = await appendEvent(db, {
        userId: caller._id,
        entity_id: `memory:agent-message:${askKey}`,
        event_type: 'memory_created',
        payload_mode: 'whole_state',
        payload: {
          category: 'agent-message', key: askKey, value: askValue, tags: askTags, meta: askMeta,
          federation_event_type: 'federation_ask',
          trace_id,
          requested_fidelity,
          source_stcky,
          acting_identity: from_identity,
          target_user,
        },
        source: 'api.federation.ask',
        actor: from_identity,
        tags: ['federation', 'federation_ask', `trace:${trace_id}`],
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
          to: from_identity,
          thread,
          type: 'federation_denied',
          status: 'closed',
          replyTo: askKey,
          summary: `Denied: ${decision.reason}`,
          source_stcky: String(target._id),
          target_stcky: source_stcky,
          requested_fidelity,
          allowed_fidelity: 'deny',
          delivered_fidelity: 'deny',
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
          payload: {
            category: 'agent-message', key: denyKey, value: denyValue, tags: denyTags, meta: denyMeta,
            decision,
            federation_event_type: 'federation_deny',
            trace_id,
            rule_id: decision.matched_rule_id,
            source_stcky,
            acting_identity: from_identity,
            target_user,
            requested_fidelity,
            actual_fidelity: 'deny',
          },
          source: 'api.federation.ask',
          actor: 'stcky',
          tags: ['federation', 'federation_deny', `trace:${trace_id}`],
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

        console.log(`[FEDERATION] DENY ${from_identity} → ${target.email} [${trace_id}] reason=${decision.reason}`);

        return res.status(200).json({
          allowed: false,
          requested_fidelity,
          allowed_fidelity: 'deny',
          delivered_fidelity: 'deny',
          reason: decision.reason,
          matched_rule_id: decision.matched_rule_id,
          trace_id,
          ask_key: askKey,
          answer_key: denyKey,
        });
      }

      // -------- ALLOWED PATH --------
      const allowed_fidelity = decision.allowed_fidelity;

      // Local retrieval (v0.1: regex; v0.2: semantic via embeddings).
      const targetQuery = { userId: target._id };
      if (domain) targetQuery.domain = domain;
      if (category) targetQuery.category = category;
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

      // Apply fidelity. delivered_fidelity equals allowed_fidelity for v0.1 —
      // a v0.2 handler may deliver lower than allowed (e.g. insufficient_confidence downgrade).
      const fidelityResult = applyFidelity(records, allowed_fidelity, { question });
      const delivered_fidelity = fidelityResult.fidelity;

      // Build answer body.
      let answerBody;
      if (fidelityResult.answer) {
        answerBody = fidelityResult.answer;
      } else if (fidelityResult.requires_reasoning) {
        answerBody = `[fidelity=${delivered_fidelity}] Local retrieval returned ${records.length} candidate records. `
          + `Synthesis stub — v0.2 will call target's LLM with records + question. `
          + `Question: "${question}"`;
        if (fidelityResult.citations) {
          answerBody += `\nCitations: ${fidelityResult.citations.map(c => `${c.category}/${c.key}`).join(', ')}`;
        }
      } else if (fidelityResult.records.length > 0) {
        answerBody = `Retrieved ${fidelityResult.records.length} record(s) at fidelity=${delivered_fidelity}.`;
      } else {
        answerBody = `No records matched at fidelity=${delivered_fidelity}.`;
      }

      const answerMeta = {
        from: 'stcky',
        to: from_identity,
        thread,
        type: 'federation_answer',
        status: 'answered',
        replyTo: askKey,
        summary: `Answer at fidelity=${delivered_fidelity}`,
        source_stcky: String(target._id),
        target_stcky: source_stcky,
        requested_fidelity,
        allowed_fidelity,
        delivered_fidelity,
        purpose,
        trace_id,
      };
      const answerKey = generateMessageKey(answerMeta, new Date());
      const answerValue = renderMessageValue(answerMeta, answerBody);
      const answerTags = renderTags(answerMeta, [`trace:${trace_id}`, 'federation', `fidelity:${delivered_fidelity}`]);
      const answerEmbed = await embedMemory({ category: 'agent-message', key: answerKey, value: answerValue, tags: answerTags });

      const { event_id: answerEventId } = await appendEvent(db, {
        userId: target._id,
        entity_id: `memory:agent-message:${answerKey}`,
        event_type: 'memory_created',
        payload_mode: 'whole_state',
        payload: {
          category: 'agent-message', key: answerKey, value: answerValue, tags: answerTags, meta: answerMeta,
          federation_event_type: 'federation_answer',
          trace_id,
          rule_id: decision.matched_rule_id,
          source_stcky,
          acting_identity: from_identity,
          target_user,
          requested_fidelity,
          allowed_fidelity,
          delivered_fidelity,
          record_count: records.length,
        },
        source: 'api.federation.ask',
        actor: 'stcky',
        tags: ['federation', 'federation_answer', `trace:${trace_id}`, `fidelity:${delivered_fidelity}`],
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

      console.log(`[FEDERATION] ALLOW ${from_identity} → ${target.email} [${trace_id}] req=${requested_fidelity} allowed=${allowed_fidelity} delivered=${delivered_fidelity} records=${records.length}`);

      return res.status(200).json({
        allowed: true,
        requested_fidelity,
        allowed_fidelity,
        delivered_fidelity,
        matched_rule_id: decision.matched_rule_id,
        trace_id,
        ask_key: askKey,
        answer_key: answerKey,
        answer: answerBody,
        records: fidelityResult.records,
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
