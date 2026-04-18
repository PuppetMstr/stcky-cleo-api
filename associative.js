/**
 * STCKY Associative Recall v5.0.0 - SEMANTIC SEARCH
 * 
 * Hybrid retrieval: Vector search + keyword fallback
 * Temporal NOW scoring for recency and relevance
 */

const { getDb, auth, cors, ObjectId } = require('./_lib/auth');
const { embed } = require('./_lib/embeddings');

const VECTOR_INDEX_NAME = 'memory_vector_index';

function calculateTemporalScore(memory, now) {
  let score = 0;
  
  // Recency score
  const hoursSinceUpdate = (now - new Date(memory.updatedAt)) / (1000 * 60 * 60);
  if (hoursSinceUpdate < 24) score += 30;
  else if (hoursSinceUpdate < 168) score += 20;
  else if (hoursSinceUpdate < 720) score += 10;
  
  // Relevance date proximity
  if (memory.relevantDate) {
    const hoursToRelevant = Math.abs(now - new Date(memory.relevantDate)) / (1000 * 60 * 60);
    if (hoursToRelevant < 24) score += 30;
    else if (hoursToRelevant < 168) score += 20;
    else if (hoursToRelevant < 720) score += 10;
  }
  
  // Access frequency boost
  if (memory.accessCount > 10) score += 10;
  else if (memory.accessCount > 5) score += 5;
  
  return score;
}

async function vectorSearch(db, userId, queryEmbedding, limit) {
  try {
    const pipeline = [
      {
        $vectorSearch: {
          index: VECTOR_INDEX_NAME,
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
          category: 1,
          key: 1,
          value: 1,
          tags: 1,
          domain: 1,
          anchor: 1,
          relevantDate: 1,
          createdAt: 1,
          updatedAt: 1,
          accessCount: 1,
          vectorScore: { $meta: 'vectorSearchScore' }
        }
      }
    ];
    
    const results = await db.collection('memories').aggregate(pipeline).toArray();
    return results;
  } catch (error) {
    // Vector index might not exist yet
    console.log('[ASSOCIATIVE] Vector search failed, using keyword fallback:', error.message);
    return null;
  }
}

async function keywordSearch(db, userId, queryTerms, limit) {
  const searchConditions = queryTerms.map(term => ({
    $or: [
      { key: { $regex: term, $options: 'i' } },
      { value: { $regex: term, $options: 'i' } },
      { tags: { $regex: term, $options: 'i' } },
      { category: { $regex: term, $options: 'i' } }
    ]
  }));

  const searchQuery = {
    userId: userId,
    ...(searchConditions.length > 0 ? { $or: searchConditions.map(c => c.$or).flat() } : {})
  };

  const results = await db.collection('memories')
    .find(searchQuery)
    .limit(limit * 3)
    .toArray();
    
  return results;
}

function mergeAndRank(vectorResults, keywordResults, queryTerms, now) {
  const seen = new Set();
  const merged = [];
  
  // Add vector results with their scores
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
  
  // Add keyword results
  if (keywordResults) {
    for (const m of keywordResults) {
      const id = m._id.toString();
      if (!seen.has(id)) {
        seen.add(id);
        m.vectorScore = 0;
        m.keywordScore = calculateKeywordScore(m, queryTerms);
        merged.push(m);
      } else {
        // Already have from vector, add keyword boost
        const existing = merged.find(x => x._id.toString() === id);
        if (existing) {
          existing.keywordScore = calculateKeywordScore(m, queryTerms);
        }
      }
    }
  }
  
  // Calculate final scores
  for (const m of merged) {
    const temporalScore = calculateTemporalScore(m, now);
    // Normalize vector score (0-1) to 0-50 range
    const normalizedVector = (m.vectorScore || 0) * 50;
    // Keyword score already 0-40
    const keywordPart = m.keywordScore || 0;
    
    m.relevanceScore = Math.round(normalizedVector + keywordPart + temporalScore);
  }
  
  // Sort by relevance
  merged.sort((a, b) => b.relevanceScore - a.relevanceScore);
  
  return merged;
}

function calculateKeywordScore(memory, queryTerms) {
  let score = 0;
  const text = `${memory.category} ${memory.key} ${memory.value} ${memory.tags || ''}`.toLowerCase();
  
  for (const term of queryTerms) {
    if (text.includes(term.toLowerCase())) {
      score += 40 / queryTerms.length;
    }
  }
  
  return Math.round(score);
}

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
  
  let query, limit, projectId;
  if (req.method === 'POST') {
    query = req.body.query;
    limit = req.body.limit || 10;
    projectId = req.body.projectId;
  } else if (req.method === 'GET') {
    query = req.query.query;
    limit = parseInt(req.query.limit) || 10;
    projectId = req.query.projectId;
  } else {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!query) return res.status(400).json({ error: 'query parameter required' });

  try {
    const now = new Date();
    const queryTerms = query.split(/\s+/).filter(t => t.length > 2);
    
    // Embed the query for vector search
    const queryEmbedding = await embed(query, 'small');
    
    let vectorResults = null;
    let keywordResults = null;
    let searchMethod = 'keyword';
    
    // Try vector search if we have an embedding
    if (queryEmbedding?.embedding) {
      vectorResults = await vectorSearch(db, user._id, queryEmbedding.embedding, limit);
      if (vectorResults && vectorResults.length > 0) {
        searchMethod = 'hybrid';
      }
    }
    
    // Always do keyword search as fallback/supplement
    keywordResults = await keywordSearch(db, user._id, queryTerms, limit);
    
    // Merge and rank results
    const ranked = mergeAndRank(vectorResults, keywordResults, queryTerms, now);
    const results = ranked.slice(0, limit);
    
    // Update access counts
    const ids = results.map(m => m._id);
    if (ids.length > 0) {
      await db.collection('memories').updateMany(
        { _id: { $in: ids } },
        { 
          $inc: { accessCount: 1 },
          $set: { lastAccessedAt: now }
        }
      );
    }

    return res.status(200).json({ 
      now: now.toISOString(),
      lastSeen: previousLastSeen,
      searchMethod,
      memories: results, 
      count: results.length,
      query,
      projectId: projectId || null
    });
  } catch (err) {
    console.error('Associative error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
