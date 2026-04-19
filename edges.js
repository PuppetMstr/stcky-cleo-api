const { getDb, auth, cors, ObjectId } = require('./_lib/auth');

const EDGE_TYPES = [
  'knows_about',    // user -> memory (expertise)
  'created',        // user -> memory (authorship)
  'relates_to',     // memory -> memory (semantic link)
  'depends_on',     // memory -> memory (dependency)
  'supersedes',     // memory -> memory (newer version)
  'works_on',       // user -> project
  'owns',           // user -> project/team
  'tagged_with',    // memory -> tag
  'references'      // memory -> external resource
];

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await auth(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const db = await getDb();

    if (req.method === 'GET') {
      const { fromId, toId, edgeType, projectId } = req.query;
      const query = {};

      if (projectId) {
        const project = await db.collection('projects').findOne({
          _id: new ObjectId(projectId),
          $or: [{ ownerId: user._id }, { memberIds: user._id }]
        });
        if (!project) return res.status(403).json({ error: 'No access to this project' });
        query.projectId = new ObjectId(projectId);
      } else {
        query.userId = user._id;
      }

      if (fromId) query.fromId = new ObjectId(fromId);
      if (toId) query.toId = new ObjectId(toId);
      if (edgeType) query.edgeType = edgeType;

      const edges = await db.collection('edges').find(query).sort({ createdAt: -1 }).limit(100).toArray();
      return res.json({ edges, count: edges.length });
    }

    if (req.method === 'POST') {
      const { fromId, fromType, toId, toType, edgeType, weight, metadata, projectId } = req.body;

      if (!fromId || !toId || !edgeType) return res.status(400).json({ error: 'fromId, toId, and edgeType required' });
      if (!EDGE_TYPES.includes(edgeType)) return res.status(400).json({ error: 'Invalid edgeType', validTypes: EDGE_TYPES });

      let projectObjId = null;
      if (projectId) {
        const project = await db.collection('projects').findOne({
          _id: new ObjectId(projectId),
          $or: [{ ownerId: user._id }, { memberIds: user._id }]
        });
        if (!project) return res.status(403).json({ error: 'No access to this project' });
        projectObjId = new ObjectId(projectId);
      }

      const now = new Date();
      const edge = {
        fromId: new ObjectId(fromId),
        fromType: fromType || 'memory',
        toId: new ObjectId(toId),
        toType: toType || 'memory',
        edgeType,
        weight: weight || 1.0,
        metadata: metadata || {},
        createdBy: user._id,
        createdAt: now
      };

      if (projectObjId) edge.projectId = projectObjId;
      else edge.userId = user._id;

      const existing = await db.collection('edges').findOne({
        fromId: edge.fromId, toId: edge.toId, edgeType: edge.edgeType,
        ...(projectObjId ? { projectId: projectObjId } : { userId: user._id })
      });

      if (existing) {
        await db.collection('edges').updateOne({ _id: existing._id }, { $set: { weight: edge.weight, metadata: edge.metadata, updatedAt: now } });
        return res.json({ success: true, updated: true, edgeId: existing._id });
      }

      const result = await db.collection('edges').insertOne(edge);
      return res.json({ success: true, edgeId: result.insertedId, edge: { ...edge, _id: result.insertedId } });
    }

    if (req.method === 'DELETE') {
      const { id, projectId } = req.query;
      if (!id) return res.status(400).json({ error: 'id required' });

      let deleteQuery = { _id: new ObjectId(id) };
      if (projectId) {
        const project = await db.collection('projects').findOne({
          _id: new ObjectId(projectId),
          $or: [{ ownerId: user._id }, { memberIds: user._id }]
        });
        if (!project) return res.status(403).json({ error: 'No access to this project' });
        deleteQuery.projectId = new ObjectId(projectId);
      } else {
        deleteQuery.userId = user._id;
      }

      const result = await db.collection('edges').deleteOne(deleteQuery);
      return res.json({ success: true, deleted: result.deletedCount > 0 });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('Edges error:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
};
