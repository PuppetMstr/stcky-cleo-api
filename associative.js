/**
 * STCKY Associative Recall v5.1.0 — HYBRID CROSS-COLLECTION SEARCH
 *
 * v5.1.0 (2026-04-22):
 *   - Added objectsVectorSearch against `objects` collection (Blob Door v0.1)
 *     using objects_vector_index (3072-dim, text-embedding-3-large).
 *   - Response now includes `objects: [...]` alongside existing `memories: [...]`.
 *     Existing clients that read only `memories` keep working unchanged.
 *   - Query is embedded twice (small + large) so we can search both indexes
 *     without dimension-mismatch errors. Fires in parallel.
 *   - Partial failure is tolerated: if either collection search fails, the
 *     other still returns results and the caller sees which path succeeded.
 *
 * v5.0.0:
 *   - Hybrid retrieval: Vector search + keyword fallback on memories.
 *   - Temporal NOW scoring for recency and relevance.
 */

const { getDb, auth, cors, ObjectId } = require('./_lib/auth');
const { embed } = require('./_lib/embeddings');

const MEMORIES_VECTOR_INDEX = 'memory_vector_index';
const OBJECTS_VECTOR_INDEX  = 'objects_vector_index';

// --------------------------------------------------------------------------
// Temporal scoring (unchanged from v5.0.0 for memories).
// For objects, scoring uses `timestamp` (event time) and `ingested_at`.
// --------------------------------------------------------------------------

function calculateTemporalScore(memory, now) {
  let score = 0;
  const hoursSinceUpdate = (now - new Date(memory.updatedAt)) / (1000 * 60 * 60);
  if (hoursSinceUpdate < 24) score += 30;
  else if (hoursSinceUpdate < 168) score += 20;
  else if (hoursSinceUpdate < 720) score += 10;

  if (memory.relevantDate) {
    const hoursToRelevant = Math.abs(now - new Date(memory.relevantDate)) / (1000 * 60 * 60);
    if (hoursToRelevant < 24) score += 30;
    else if (hoursToRelevant < 168) score += 20;
    else if (hoursToRelevant < 720) score += 10;
  }

  if (memory.accessCount > 10) score += 10;
  else if (memory.accessCount > 5) score += 5;

  return score;
}

function calculateObjectTemporalScore(obj, now) {
  // Objects use `timestamp` (event/client time) primarily, with ingested_at as fallback.
  let score = 0;
  const anchorTime = obj.timestamp || obj.ingested_at || obj.server_ingest_timestamp;
  if (anchorTime) {
    const hoursSince = (now - new Date(anchorTime)) / (1000 * 60 * 60);
    if (hoursSince < 24) score += 30;
    else if (hoursSince < 168) score += 20;
    else if (hoursSince < 720) score += 10;
  }
  return score;
}

// --------------------------------------------------------------------------
// Memory search paths (unchanged).
// --------------------------------------------------------------------------

async function memoryVectorSearch(db, userId, queryEmbedding, limit) {
  try {
    const pipeline = [
      {
        $vectorSearch: {
          index: MEMORIES_VECTOR_INDEX,
          path: 'embedding',
          queryVector: queryEmbedding,
          numCandidates: limit * 20,
          limit: limit * 2,
          filter: { userId: userId }
        }
      },
      {
        $project: {
          _id: 1,
          category: 1, key: 1, value: 1, tags: 1,
          domain: 1, anchor: 1, relevantDate: 1,
          createdAt: 1, updatedAt: 1, accessCount: 1,
          vectorScore: { $meta: 'vectorSearchScore' }
        }
      }
    ];
    return await db.collection('memories').aggregate(pipeline).toArray();
  } catch (error) {
    console.log('[ASSOCIATIVE] Memory vector search failed:', error.message);
    return null;
  }
}

async function memoryKeywordSearch(db, userId, queryTerms, limit) {
  const searchConditions = queryTerms.map(term => ({
    $or: [
      { key:      { $regex: term, $options: 'i' } },
      { value:    { $regex: term, $options: 'i' } },
      { tags:     { $regex: term, $options: 'i' } },
      { category: { $regex: term, $options: 'i' } }
    ]
  }));

  const searchQuery = {
    userId: userId,
    ...(searchConditions.length > 0 ? { $or: searchConditions.map(c => c.$or).flat() } : {})
  };

  return await db.collection('memories')
    .find(searchQuery)
    .limit(limit * 3)
    .toArray();
}

// --------------------------------------------------------------------------
// Object search paths (new in v5.1.0).
// Objects are stored by /api/ingest in the `objects` collection with 3072-dim
// embeddings. We search them in parallel with memories and return a separate
// result array so the caller can distinguish raw ingested content from
// curated memories.
// --------------------------------------------------------------------------

async function objectsVectorSearch(db, userId, queryEmbedding, limit) {
  try {
    const pipeline = [
      {
        $vectorSearch: {
          index: OBJECTS_VECTOR_INDEX,
          path: 'embedding',
          queryVector: queryEmbedding,
          numCandidates: limit * 20,
          limit: limit * 2,
          filter: { userId: userId }
        }
      },
      {
        $project: {
          _id: 1,
          object_id: 1,
          content: 1,
          content_length: 1,
          source_type: 1,
          source: 1,
          speaker: 1,
          session_id: 1,
          turn_index: 1,
          trace_id: 1,
          client: 1,
          timestamp: 1,
          ingested_at: 1,
          parent_object_id: 1,
          chunk_index: 1,
          vectorScore: { $meta: 'vectorSearchScore' }
        }
      }
    ];
    return await db.collection('objects').aggregate(pipeline).toArray();
  } catch (error) {
    console.log('[ASSOCIATIVE] Objects vector search failed:', error.message);
    return null;
  }
}

async function objectsKeywordSearch(db, userId, queryTerms, limit) {
  if (queryTerms.length === 0) return [];

  const searchConditions = queryTerms.map(term => ({
    $or: [
      { content: { $regex: term, $options: 'i' } },
      { source:  { $regex: term, $options: 'i' } },
      { speaker: { $regex: term, $options: 'i' } }
    ]
  }));

  return await db.collection('objects')
    .find({
      userId: userId,
      $or: searchConditions.map(c => c.$or).flat()
    })
    .limit(limit * 3)
    .toArray();
}

// --------------------------------------------------------------------------
// Merge + rank (memory side, unchanged).
// --------------------------------------------------------------------------

function mergeAndRankMemories(vectorResults, keywordResults, queryTerms, now) {
  const seen = new Set();
  const merged = [];

  if (vectorResults) {
    for (const m of vectorResults) {
      const id = m._id.toString();
      if (!seen.has(id)) {
        seen.add(id);
        m.vectorScore = m.vectorScore || 0;
        m.keywordScore = 0;
        merged.push(m);
      }
    }
  }

  if (keywordResults) {
    for (const m of keywordResults) {
      const id = m._id.toString();
      if (!seen.has(id)) {
        seen.add(id);
        m.vectorScore = 0;
        m.keywordScore = calculateKeywordScore(m, queryTerms, ['key', 'value', 'tags', 'category']);
        merged.push(m);
      } else {
        const existing = merged.find(x => x._id.toString() === id);
        if (existing) {
          existing.keywordScore = calculateKeywordScore(m, queryTerms, ['key', 'value', 'tags', 'category']);
        }
      }
    }
  }

  for (const m of merged) {
    const temporalScore = calculateTemporalScore(m, now);
    const normalizedVector = (m.vectorScore || 0) * 50;
    const keywordPart = m.keywordScore || 0;
    m.relevanceScore = Math.round(normalizedVector + keywordPart + temporalScore);
  }

  merged.sort((a, b) => b.relevanceScore - a.relevanceScore);
  return merged;
}

// --------------------------------------------------------------------------
// Merge + rank (object side, new).
// --------------------------------------------------------------------------

function mergeAndRankObjects(vectorResults, keywordResults, queryTerms, now) {
  const seen = new Set();
  const merged = [];

  if (vectorResults) {
    for (const o of vectorResults) {
      const id = o._id.toString();
      if (!seen.has(id)) {
        seen.add(id);
        o.vectorScore = o.vectorScore || 0;
        o.keywordScore = 0;
        merged.push(o);
      }
    }
  }

  if (keywordResults) {
    for (const o of keywordResults) {
      const id = o._id.toString();
      if (!seen.has(id)) {
        seen.add(id);
        o.vectorScore = 0;
        o.keywordScore = calculateKeywordScore(o, queryTerms, ['content', 'source', 'speaker']);
        merged.push(o);
      } else {
        const existing = merged.find(x => x._id.toString() === id);
        if (existing) {
          existing.keywordScore = calculateKeywordScore(o, queryTerms, ['content', 'source', 'speaker']);
        }
      }
    }
  }

  for (const o of merged) {
    const temporalScore = calculateObjectTemporalScore(o, now);
    const normalizedVector = (o.vectorScore || 0) * 50;
    const keywordPart = o.keywordScore || 0;
    o.relevanceScore = Math.round(normalizedVector + keywordPart + temporalScore);
  }

  merged.sort((a, b) => b.relevanceScore - a.relevanceScore);
  return merged;
}

// Generic keyword score — works for any doc shape by passing in the fields to scan.
function calculateKeywordScore(doc, queryTerms, fields) {
  if (!queryTerms || queryTerms.length === 0) return 0;
  let score = 0;
  const parts = fields.map(f => String(doc[f] ?? '')).join(' ').toLowerCase();
  for (const term of queryTerms) {
    if (parts.includes(term.toLowerCase())) {
      score += 40 / queryTerms.length;
    }
  }
  return Math.round(score);
}

// --------------------------------------------------------------------------
// Handler
// --------------------------------------------------------------------------

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await auth(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const db = await getDb();

  // Track lastSeen
  const previousLastSeen = user.lastSeen || null;
  await db.collection('users').updateOne(
    { _id: user._id },
    { $set: { lastSeen: new Date() } }
  );

  let query, limit, projectId, includeObjects, includeMemories;
  if (req.method === 'POST') {
    query = req.body.query;
    limit = req.body.limit || 10;
    projectId = req.body.projectId;
    includeObjects  = req.body.includeObjects  !== false; // default ON
    includeMemories = req.body.includeMemories !== false; // default ON
  } else if (req.method === 'GET') {
    query = req.query.query;
    limit = parseInt(req.query.limit) || 10;
    projectId = req.query.projectId;
    includeObjects  = req.query.includeObjects  !== 'false';
    includeMemories = req.query.includeMemories !== 'false';
  } else {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!query) return res.status(400).json({ error: 'query parameter required' });

  try {
    const now = new Date();
    const queryTerms = query.split(/\s+/).filter(t => t.length > 2);

    // Embed the query at both sizes. Run in parallel. If either fails we
    // still proceed with the one that succeeded.
    const [smallEmbed, largeEmbed] = await Promise.all([
      includeMemories ? embed(query, 'small') : Promise.resolve(null),
      includeObjects  ? embed(query, 'large') : Promise.resolve(null),
    ]);

    // Kick off all searches in parallel.
    const memoryTasks = [];
    if (includeMemories) {
      if (smallEmbed?.embedding) {
        memoryTasks.push(memoryVectorSearch(db, user._id, smallEmbed.embedding, limit));
      } else {
        memoryTasks.push(Promise.resolve(null));
      }
      memoryTasks.push(memoryKeywordSearch(db, user._id, queryTerms, limit));
    } else {
      memoryTasks.push(Promise.resolve(null), Promise.resolve([]));
    }

    const objectTasks = [];
    if (includeObjects) {
      if (largeEmbed?.embedding) {
        objectTasks.push(objectsVectorSearch(db, user._id, largeEmbed.embedding, limit));
      } else {
        objectTasks.push(Promise.resolve(null));
      }
      objectTasks.push(objectsKeywordSearch(db, user._id, queryTerms, limit));
    } else {
      objectTasks.push(Promise.resolve(null), Promise.resolve([]));
    }

    const [memVec, memKw, objVec, objKw] = await Promise.all([...memoryTasks, ...objectTasks]);

    const rankedMemories = includeMemories
      ? mergeAndRankMemories(memVec, memKw, queryTerms, now).slice(0, limit)
      : [];
    const rankedObjects  = includeObjects
      ? mergeAndRankObjects(objVec, objKw, queryTerms, now).slice(0, limit)
      : [];

    // Update access counts on returned memories (keeps existing behavior).
    const memIds = rankedMemories.map(m => m._id);
    if (memIds.length > 0) {
      await db.collection('memories').updateMany(
        { _id: { $in: memIds } },
        { $inc: { accessCount: 1 }, $set: { lastAccessedAt: now } }
      );
    }

    // Search method summary.
    const searchMethod = {
      memories: memVec && memVec.length > 0 ? 'hybrid' : (memKw && memKw.length > 0 ? 'keyword' : 'none'),
      objects:  objVec && objVec.length > 0 ? 'hybrid' : (objKw && objKw.length > 0 ? 'keyword' : 'none'),
    };

    return res.status(200).json({
      now: now.toISOString(),
      lastSeen: previousLastSeen,
      searchMethod,
      memories: rankedMemories,
      count: rankedMemories.length,
      objects: rankedObjects,
      objects_count: rankedObjects.length,
      query,
      projectId: projectId || null,
    });
  } catch (err) {
    console.error('Associative error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
