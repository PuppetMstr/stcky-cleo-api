const { getDb, auth, cors, ObjectId } = require('./_lib/auth');

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await auth(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const db = await getDb();

    if (req.method === 'POST') {
      const { query, projectId } = req.body;
      if (!query) return res.status(400).json({ error: 'query required' });

      let scopeQuery;
      if (projectId) {
        const project = await db.collection('projects').findOne({
          _id: new ObjectId(projectId),
          $or: [{ ownerId: user._id }, { memberIds: user._id }]
        });
        if (!project) return res.status(403).json({ error: 'No access to this project' });
        scopeQuery = { projectId: new ObjectId(projectId) };
      } else {
        scopeQuery = { userId: user._id };
      }

      const { type, memoryId, edgeType, searchTerm, depth = 1 } = query;

      switch (type) {
        case 'connections': {
          if (!memoryId) return res.status(400).json({ error: 'memoryId required' });
          const objId = new ObjectId(memoryId);
          const edgeQuery = { ...scopeQuery, $or: [{ fromId: objId }, { toId: objId }] };
          if (edgeType) edgeQuery.edgeType = edgeType;

          const edges = await db.collection('edges').find(edgeQuery).toArray();
          const connectedIds = new Set();
          edges.forEach(e => {
            if (!e.fromId.equals(objId)) connectedIds.add(e.fromId.toString());
            if (!e.toId.equals(objId)) connectedIds.add(e.toId.toString());
          });

          const connectedMemories = await db.collection('memories')
            .find({ _id: { $in: Array.from(connectedIds).map(id => new ObjectId(id)) } })
            .toArray();

          return res.json({ edges, connectedMemories, count: connectedMemories.length });
        }

        case 'experts': {
          if (!searchTerm) return res.status(400).json({ error: 'searchTerm required' });

          const memories = await db.collection('memories')
            .find({
              ...scopeQuery,
              $or: [
                { key: { $regex: searchTerm, $options: 'i' } },
                { value: { $regex: searchTerm, $options: 'i' } },
                { tags: { $regex: searchTerm, $options: 'i' } }
              ]
            })
            .limit(50).toArray();

          const memoryIds = memories.map(m => m._id);
          const edges = await db.collection('edges')
            .find({ ...scopeQuery, toId: { $in: memoryIds }, edgeType: 'knows_about' })
            .toArray();

          const expertiseCount = {};
          edges.forEach(e => {
            const userId = e.fromId.toString();
            expertiseCount[userId] = (expertiseCount[userId] || 0) + e.weight;
          });

          const expertIds = Object.keys(expertiseCount).map(id => new ObjectId(id));
          const experts = await db.collection('users')
            .find({ _id: { $in: expertIds } })
            .project({ _id: 1, email: 1, name: 1 })
            .toArray();

          const rankedExperts = experts
            .map(u => ({ ...u, expertiseScore: expertiseCount[u._id.toString()] }))
            .sort((a, b) => b.expertiseScore - a.expertiseScore);

          return res.json({ query: searchTerm, matchingMemories: memories.length, experts: rankedExperts });
        }

        case 'related': {
          if (!memoryId) return res.status(400).json({ error: 'memoryId required' });

          const startId = new ObjectId(memoryId);
          const visited = new Set([startId.toString()]);
          let frontier = [startId];

          for (let d = 0; d < Math.min(depth, 3); d++) {
            if (frontier.length === 0) break;
            const edges = await db.collection('edges')
              .find({
                ...scopeQuery,
                $or: [{ fromId: { $in: frontier } }, { toId: { $in: frontier } }],
                edgeType: { $in: ['relates_to', 'depends_on', 'references'] }
              }).toArray();

            const nextFrontier = [];
            for (const edge of edges) {
              const otherId = frontier.some(f => f.equals(edge.fromId)) ? edge.toId : edge.fromId;
              if (!visited.has(otherId.toString())) {
                visited.add(otherId.toString());
                nextFrontier.push(otherId);
              }
            }
            frontier = nextFrontier;
          }

          visited.delete(startId.toString());
          const memories = await db.collection('memories')
            .find({ _id: { $in: Array.from(visited).map(id => new ObjectId(id)) } })
            .toArray();

          return res.json({ startMemoryId: memoryId, depth, relatedMemories: memories, count: memories.length });
        }

        default:
          return res.status(400).json({ error: 'Unknown query type', validTypes: ['connections', 'experts', 'related'] });
      }
    }

    if (req.method === 'GET') {
      const { projectId } = req.query;
      let scopeQuery;
      if (projectId) {
        const project = await db.collection('projects').findOne({
          _id: new ObjectId(projectId),
          $or: [{ ownerId: user._id }, { memberIds: user._id }]
        });
        if (!project) return res.status(403).json({ error: 'No access to this project' });
        scopeQuery = { projectId: new ObjectId(projectId) };
      } else {
        scopeQuery = { userId: user._id };
      }

      const totalEdges = await db.collection('edges').countDocuments(scopeQuery);
      const typeCounts = await db.collection('edges').aggregate([
        { $match: scopeQuery },
        { $group: { _id: '$edgeType', count: { $sum: 1 } } }
      ]).toArray();

      return res.json({ totalEdges, byType: Object.fromEntries(typeCounts.map(t => [t._id, t.count])) });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('Graph error:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
};
