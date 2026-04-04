const { MongoClient, ObjectId } = require('mongodb');

const uri = process.env.MONGODB_URI;
let client;

async function getDb() {
  if (!client) {
    client = new MongoClient(uri);
    await client.connect();
  }
  return client.db('cleo');
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
}

async function auth(req) {
  const token = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  if (!token) return null;
  const db = await getDb();
  
  let user = null;
  
  // Handle OAuth access tokens (stcky_xxx)
  if (token.startsWith('stcky_')) {
    try {
      const decoded = JSON.parse(Buffer.from(token.replace('stcky_', ''), 'base64').toString());
      if (decoded.userId) {
        user = await db.collection('users').findOne({ _id: new ObjectId(decoded.userId) });
      }
    } catch (e) {
      // Invalid token format
      return null;
    }
  } else {
    // Handle direct API keys (cleo_xxx)
    user = await db.collection('users').findOne({ apiKey: token });
  }
  
  if (user) {
    await db.collection('users').updateOne(
      { _id: user._id },
      { $set: { lastSeen: new Date() } }
    );
  }
  return user;
}

// Determine action from URL path
function getAction(url) {
  if (url.includes('/memory/list')) return 'list';
  if (url.includes('/memory/search')) return 'search';
  if (url.includes('/memory/upcoming')) return 'upcoming';
  return 'crud';
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await auth(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const db = await getDb();
  const action = getAction(req.url);

  try {
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
      const { category, key, value, tags, source, relevantDate, projectId } = req.body;
      
      if (!category || !key || !value) {
        return res.status(400).json({ error: 'category, key, and value required' });
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
            upgrade: 'Upgrade to Pro for more memories'
          });
        }
      }
      
      const now = new Date();
      const findQuery = projectObjId 
        ? { projectId: projectObjId, category, key }
        : { userId: user._id, category, key };
      
      const existing = await db.collection('memories').findOne(findQuery);
      
      const memory = {
        category,
        key,
        value,
        tags: tags || '',
        source: source || '',
        relevantDate: relevantDate ? new Date(relevantDate) : null,
        createdAt: existing ? existing.createdAt : now,
        updatedAt: now,
        accessCount: existing ? (existing.accessCount || 0) + 1 : 1,
        createdBy: user._id
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
      
      return res.json({ 
        success: true, 
        memory: {
          category: memory.category,
          key: memory.key,
          value: memory.value,
          tags: memory.tags,
          projectId: projectId || null,
          updatedAt: memory.updatedAt
        }
      });
    }
    
    if (req.method === 'DELETE') {
      const { category, key, projectId } = req.query;
      
      if (!category || !key) {
        return res.status(400).json({ error: 'category and key required' });
      }
      
      let deleteQuery;
      if (projectId) {
        const project = await db.collection('projects').findOne({
          _id: new ObjectId(projectId),
          $or: [{ ownerId: user._id }, { memberIds: user._id }]
        });
        if (!project) return res.status(403).json({ error: 'No access to this project' });
        deleteQuery = { projectId: new ObjectId(projectId), category, key };
      } else {
        deleteQuery = { userId: user._id, category, key };
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
