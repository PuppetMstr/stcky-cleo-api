const { getDb, auth, cors, ObjectId } = require('./_lib/auth');
const { embedMemory } = require('./_lib/embeddings');
const {
  appendEvent,
  entityHistory,
  stateAsOf,
  changesSince,
  ensureIndexes,
} = require('./_lib/events');

// Run once per cold start — Mongo createIndex is idempotent, so safe to re-call.
let _indexesReady = null;
async function ensureEventIndexes(db) {
  if (!_indexesReady) _indexesReady = ensureIndexes(db).catch((e) => {
    console.error('[events] ensureIndexes failed:', e.message);
    _indexesReady = null; // retry next call
  });
  return _indexesReady;
}

function getAction(url) {
  if (url.includes('/memory/history')) return 'history';
  if (url.includes('/memory/as-of')) return 'as-of';
  if (url.includes('/memory/changes')) return 'changes';
  if (url.includes('/memory/list')) return 'list';
  if (url.includes('/memory/search')) return 'search';
  if (url.includes('/memory/upcoming')) return 'upcoming';
  if (url.includes('/memory/anchors')) return 'anchors';
  return 'crud';
}

// Derive source string when client doesn't provide one.
// Matches v1.0 dotted convention: provider.interface.conversation_id
function deriveSource(req, user, explicit) {
  if (explicit && typeof explicit === 'string' && explicit.includes('.')) return explicit;
  const tail = user && user._id ? String(user._id).slice(-6) : 'anon';
  return `api.rest.user_${tail}`;
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await auth(req);
  if (!user) {
    console.log('[MEMORY AUTH] Failed - no user found for token');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const db = await getDb();
  await ensureEventIndexes(db);

  const action = getAction(req.url);

  await db.collection('users').updateOne(
    { _id: user._id },
    { $set: { lastSeen: new Date() } }
  );

  try {
    // ============ HISTORY (new) ============
    if (action === 'history') {
      const { category, key } = req.method === 'POST' ? req.body : req.query;
      if (!category || !key) {
        return res.status(400).json({ error: 'category and key required' });
      }
      const entity_id = `memory:${category}:${key}`;
      const events = await entityHistory(db, { userId: user._id, entity_id });
      return res.json({ entity_id, events, count: events.length });
    }

    // ============ AS-OF (new, counterfactual) ============
    if (action === 'as-of') {
      const { category, key, timestamp } = req.method === 'POST' ? req.body : req.query;
      if (!category || !key || !timestamp) {
        return res.status(400).json({ error: 'category, key, and timestamp required' });
      }
      const entity_id = `memory:${category}:${key}`;
      const snapshot = await stateAsOf(db, { userId: user._id, entity_id, asOf: timestamp });
      if (!snapshot) return res.status(404).json({ error: 'No events for this entity at/before given timestamp' });
      return res.json({ entity_id, ...snapshot });
    }

    // ============ CHANGES SINCE (new, delta) ============
    if (action === 'changes') {
      const { since, category, key, event_type, limit } = req.method === 'POST' ? req.body : req.query;
      if (!since) return res.status(400).json({ error: 'since timestamp required' });
      const entity_id = category && key ? `memory:${category}:${key}` : undefined;
      const events = await changesSince(db, {
        userId: user._id, since, entity_id, event_type, limit: limit || 100,
      });
      return res.json({ since, events, count: events.length });
    }

    // ============ LIST ============
    if (action === 'list') {
      const { category, limit = '50', projectId } = req.method === 'POST' ? req.body : req.query;

      let query;
      if (projectId) {
        const project = await db.collection('projects').findOne({
          _id: new ObjectId(projectId),
          $or: [{ ownerId: user._id }, { memberIds: user._id }]
        });
        if (!project) return res.status(403).json({ error: 'No access to this project' });
        query = { projectId: new ObjectId(projectId) };
      } else {
        query = { userId: user._id };
      }

      if (category) query.category = category;

      const results = await db.collection('memories')
        .find(query)
        .sort({ updatedAt: -1 })
        .limit(parseInt(limit))
        .toArray();

      return res.json({ memories: results, count: results.length, projectId: projectId || null });
    }

    // ============ SEARCH ============
    if (action === 'search') {
      const { query, limit = '20', projectId } = req.query;
      if (!query) return res.status(400).json({ error: 'query parameter required' });

      let baseQuery;
      if (projectId) {
        const project = await db.collection('projects').findOne({
          _id: new ObjectId(projectId),
          $or: [{ ownerId: user._id }, { memberIds: user._id }]
        });
        if (!project) return res.status(403).json({ error: 'No access to this project' });
        baseQuery = { projectId: new ObjectId(projectId) };
      } else {
        baseQuery = { userId: user._id };
      }

      const searchQuery = {
        ...baseQuery,
        $or: [
          { key: { $regex: query, $options: 'i' } },
          { value: { $regex: query, $options: 'i' } },
          { tags: { $regex: query, $options: 'i' } },
          { category: { $regex: query, $options: 'i' } }
        ]
      };

      const results = await db.collection('memories')
        .find(searchQuery)
        .sort({ updatedAt: -1 })
        .limit(parseInt(limit))
        .toArray();

      return res.json({ memories: results, count: results.length, projectId: projectId || null });
    }

    // ============ UPCOMING ============
    if (action === 'upcoming') {
      const { days = '7', limit = '10', projectId } = req.query;

      const now = new Date();
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + parseInt(days));

      let baseQuery;
      if (projectId) {
        const project = await db.collection('projects').findOne({
          _id: new ObjectId(projectId),
          $or: [{ ownerId: user._id }, { memberIds: user._id }]
        });
        if (!project) return res.status(403).json({ error: 'No access to this project' });
        baseQuery = { projectId: new ObjectId(projectId) };
      } else {
        baseQuery = { userId: user._id };
      }

      const results = await db.collection('memories')
        .find({
          ...baseQuery,
          relevantDate: { $gte: now, $lte: futureDate }
        })
        .sort({ relevantDate: 1 })
        .limit(parseInt(limit))
        .toArray();

      return res.json({
        memories: results,
        count: results.length,
        window: { from: now.toISOString(), to: futureDate.toISOString() },
        projectId: projectId || null
      });
    }

    // ============ ANCHORS ============
    if (action === 'anchors') {
      const { domains, limit = '10', projectId } = req.query;

      if (!domains) {
        return res.status(400).json({ error: 'domains parameter required (comma-separated)' });
      }

      const domainList = domains.split(',').map(d => d.trim().toLowerCase());

      let baseQuery;
      if (projectId) {
        const project = await db.collection('projects').findOne({
          _id: new ObjectId(projectId),
          $or: [{ ownerId: user._id }, { memberIds: user._id }]
        });
        if (!project) return res.status(403).json({ error: 'No access to this project' });
        baseQuery = { projectId: new ObjectId(projectId) };
      } else {
        baseQuery = { userId: user._id };
      }

      const results = await db.collection('memories')
        .find({
          ...baseQuery,
          domain: { $in: domainList },
          anchor: true
        })
        .sort({ updatedAt: -1 })
        .limit(parseInt(limit))
        .toArray();

      return res.json({
        memories: results,
        count: results.length,
        domains: domainList,
        projectId: projectId || null
      });
    }

    // ============ CRUD (GET/POST/DELETE) ============
    if (req.method === 'GET') {
      const { category, key, searchTerm, projectId } = req.query;

      const query = { userId: user._id };

      if (projectId) {
        const project = await db.collection('projects').findOne({
          _id: new ObjectId(projectId),
          $or: [{ ownerId: user._id }, { memberIds: user._id }]
        });
        if (!project) return res.status(403).json({ error: 'No access to this project' });
        query.projectId = new ObjectId(projectId);
        delete query.userId;
      }

      if (category) query.category = category;
      if (key) query.key = key;
      if (searchTerm) {
        query.$or = [
          { key: { $regex: searchTerm, $options: 'i' } },
          { value: { $regex: searchTerm, $options: 'i' } },
          { tags: { $regex: searchTerm, $options: 'i' } },
          { category: { $regex: searchTerm, $options: 'i' } }
        ];
      }

      const memories = await db.collection('memories')
        .find(query)
        .sort({ updatedAt: -1 })
        .limit(50)
        .toArray();

      return res.json({ memories });
    }

    if (req.method === 'POST') {
      const {
        category,
        key,
        value,
        tags,
        source,
        relevantDate,
        projectId,
        domain,
        anchor,
        // v1.0 event-aware fields (all optional, safe defaults applied):
        actor: actorIn,
        causation_id,
      } = req.body;

      if (!category || !key || !value) {
        return res.status(400).json({ error: 'category, key, and value required' });
      }

      const validDomains = ['medical', 'financial', 'family', 'legal', 'travel', 'work', 'personal'];
      if (domain && !validDomains.includes(domain.toLowerCase())) {
        return res.status(400).json({ error: 'Invalid domain', validDomains });
      }

      let projectObjId = null;
      if (projectId) {
        const project = await db.collection('projects').findOne({
          _id: new ObjectId(projectId),
          $or: [{ ownerId: user._id }, { memberIds: user._id }]
        });
        if (!project) return res.status(403).json({ error: 'No access to this project' });
        projectObjId = new ObjectId(projectId);
      }

      if (!projectId) {
        const memoryCount = await db.collection('memories').countDocuments({ userId: user._id });
        const limit = user.memoryLimit || 100;
        const existing = await db.collection('memories').findOne({ userId: user._id, category, key });

        if (!existing && memoryCount >= limit) {
          return res.status(403).json({
            error: 'Memory limit reached',
            limit,
            current: memoryCount,
            upgrade: 'Upgrade to Pro for more memories',
            upgradeUrl: 'https://stcky.ai/pricing.html'
          });
        }
      }

      const now = new Date();
      const findQuery = projectObjId
        ? { projectId: projectObjId, category, key }
        : { userId: user._id, category, key };

      const existing = await db.collection('memories').findOne(findQuery);

      // Generate embedding
      const embeddingData = await embedMemory({ category, key, value, tags });

      // --- Phase 0: append event BEFORE snapshot write ---
      // The events collection is the audit trail. `memories` collection stays as-is
      // (now playing the role of materialized snapshot).
      const entity_id = `memory:${category}:${key}`;
      const event_type = existing ? 'memory_updated' : 'memory_created';
      const actor = actorIn || 'user';
      const derivedSource = deriveSource(req, user, source);

      const { event_id, prev_event_id } = await appendEvent(db, {
        userId: user._id,
        projectId: projectObjId,
        entity_id,
        event_type,
        payload_mode: 'whole_state',
        payload: {
          category, key, value,
          tags: tags || '',
          domain: domain ? domain.toLowerCase() : null,
          anchor: anchor === true || anchor === 'true' || false,
          relevantDate: relevantDate || null,
        },
        source: derivedSource,
        actor,
        tags: typeof tags === 'string' ? tags.split(',').map(t => t.trim()).filter(Boolean) : (tags || []),
        causationId: causation_id || null,
      });

      const memory = {
        category,
        key,
        value,
        tags: tags || '',
        source: source || '',
        relevantDate: relevantDate ? new Date(relevantDate) : null,
        domain: domain ? domain.toLowerCase() : null,
        anchor: anchor === true || anchor === 'true' || false,
        // Embedding fields (v5.0)
        embedding: embeddingData?.embedding || null,
        embeddingModel: embeddingData?.model || null,
        embeddingDims: embeddingData?.dims || null,
        // Timestamps
        createdAt: existing ? existing.createdAt : now,
        updatedAt: now,
        lastAccessedAt: now,
        accessCount: existing ? (existing.accessCount || 0) + 1 : 1,
        createdBy: user._id,
        // Phase 0 additions — chain the snapshot back to the event log.
        last_event_id: event_id,
        first_event_id: existing ? (existing.first_event_id || event_id) : event_id,
        version_count: existing ? ((existing.version_count || 1) + 1) : 1,
        schema_version: '1.0',
      };

      if (projectObjId) {
        memory.projectId = projectObjId;
      } else {
        memory.userId = user._id;
      }

      if (existing) {
        await db.collection('memories').updateOne({ _id: existing._id }, { $set: memory });
        memory._id = existing._id;
      } else {
        const result = await db.collection('memories').insertOne(memory);
        memory._id = result.insertedId;
      }

      const hasEmbedding = !!embeddingData;
      console.log(`[MEMORY] Stored: [${category}] ${key} | embedding: ${hasEmbedding ? embeddingData.model : 'none'} | event: ${event_id} v${memory.version_count}`);

      return res.json({
        success: true,
        memory: {
          category: memory.category,
          key: memory.key,
          value: memory.value,
          tags: memory.tags,
          domain: memory.domain,
          anchor: memory.anchor,
          embedded: hasEmbedding,
          embeddingModel: memory.embeddingModel,
          projectId: projectId || null,
          updatedAt: memory.updatedAt,
          version_count: memory.version_count,
          last_event_id: memory.last_event_id,
        }
      });
    }

    if (req.method === 'DELETE') {
      const { category, key, projectId } = req.query;

      if (!category || !key) {
        return res.status(400).json({ error: 'category and key required' });
      }

      let deleteQuery;
      let projectObjId = null;
      if (projectId) {
        const project = await db.collection('projects').findOne({
          _id: new ObjectId(projectId),
          $or: [{ ownerId: user._id }, { memberIds: user._id }]
        });
        if (!project) return res.status(403).json({ error: 'No access to this project' });
        projectObjId = new ObjectId(projectId);
        deleteQuery = { projectId: projectObjId, category, key };
      } else {
        deleteQuery = { userId: user._id, category, key };
      }

      // Phase 0 — log the deletion as a field_patch event before removing the doc.
      // Preserves audit trail: you can always reconstruct what the memory used to be.
      try {
        const entity_id = `memory:${category}:${key}`;
        await appendEvent(db, {
          userId: user._id,
          projectId: projectObjId,
          entity_id,
          event_type: 'memory_updated',
          payload_mode: 'field_patch',
          payload: { field: 'deleted', new_value: true },
          source: deriveSource(req, user, null),
          actor: 'user',
        });
      } catch (e) {
        console.error('[MEMORY DELETE] event log failed (non-fatal):', e.message);
      }

      const result = await db.collection('memories').deleteOne(deleteQuery);
      return res.json({ success: true, deleted: result.deletedCount > 0 });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (error) {
    console.error('Memory error:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
};
