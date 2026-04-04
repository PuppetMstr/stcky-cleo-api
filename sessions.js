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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
}

async function auth(req) {
  const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  if (!apiKey) return null;
  const db = await getDb();
  const user = await db.collection('users').findOne({ apiKey });
  return user;
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await auth(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const db = await getDb();
  const sessions = db.collection('sessions');

  try {
    if (req.method === 'POST') {
      const { tags } = req.body;
      const session = {
        userId: user._id,
        status: 'in_progress',
        tags: tags || '',
        summary: '',
        decisions: '',
        pending: '',
        startedAt: new Date(),
        endedAt: null
      };
      const result = await sessions.insertOne(session);
      return res.status(200).json({ success: true, sessionId: result.insertedId.toString(), message: 'Session started' });
    }

    if (req.method === 'PUT') {
      const { sessionId, summary, decisions, pending } = req.body;
      if (!sessionId || !summary) return res.status(400).json({ error: 'sessionId and summary required' });
      
      await sessions.updateOne(
        { _id: new ObjectId(sessionId), userId: user._id },
        { $set: { status: 'completed', summary: summary || '', decisions: decisions || '', pending: pending || '', endedAt: new Date() } }
      );
      return res.status(200).json({ success: true, message: 'Session ended' });
    }

    if (req.method === 'GET') {
      const { limit = '5' } = req.query;
      const results = await sessions.find({ userId: user._id }).sort({ startedAt: -1 }).limit(parseInt(limit)).toArray();
      return res.status(200).json({ sessions: results, count: results.length });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Sessions error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
