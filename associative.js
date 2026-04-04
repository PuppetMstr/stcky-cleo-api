const { getDb, auth, cors } = require('./_lib/auth');
const { ObjectId } = require('mongodb');

function calculateScore(memory, queryTerms, now) {
  let score = 0;
  const text = `${memory.category} ${memory.key} ${memory.value} ${memory.tags || ''}`.toLowerCase();
  
  for (const term of queryTerms) {
    if (text.includes(term.toLowerCase())) score += 40 / queryTerms.length;
  }
  
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
  
  return Math.round(score);
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await auth(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const db = await getDb();
  
  // Track lastSeen for relationship warmth
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
    
    const searchConditions = queryTerms.map(term => ({
      $or: [
        { key: { $regex: term, $options: 'i' } },
        { value: { $regex: term, $options: 'i' } },
        { tags: { $regex: term, $options: 'i' } },
        { category: { $regex: term, $options: 'i' } }
      ]
    }));

    // Build search query - personal or project scoped
    let searchQuery;
    
    if (projectId) {
      // Verify project access
      const project = await db.collection('projects').findOne({
        _id: new ObjectId(projectId),
        $or: [
          { ownerId: user._id },
          { memberIds: user._id }
        ]
      });
      if (!project) {
        return res.status(403).json({ error: 'No access to this project' });
      }
      searchQuery = {
        projectId: new ObjectId(projectId),
        ...(searchConditions.length > 0 ? { $or: searchConditions.map(c => c.$or).flat() } : {})
      };
    } else {
      searchQuery = {
        userId: user._id,
        ...(searchConditions.length > 0 ? { $or: searchConditions.map(c => c.$or).flat() } : {})
      };
    }

    const results = await db.collection('memories').find(searchQuery).limit(limit * 3).toArray();
    const scored = results.map(m => ({ ...m, relevanceScore: calculateScore(m, queryTerms, now) }));
    scored.sort((a, b) => b.relevanceScore - a.relevanceScore);

    return res.status(200).json({ 
      now: now.toISOString(),
      lastSeen: previousLastSeen,
      memories: scored.slice(0, limit), 
      count: Math.min(scored.length, limit),
      query,
      projectId: projectId || null
    });
  } catch (err) {
    console.error('Associative error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
