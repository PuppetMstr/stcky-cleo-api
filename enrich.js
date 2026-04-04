const { MongoClient } = require('mongodb');

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
}

async function auth(req) {
  const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  if (!apiKey) return null;
  const db = await getDb();
  const user = await db.collection('users').findOne({ apiKey });
  return user;
}

function extractEntities(message) {
  const entities = [];
  const properNouns = message.match(/\b[A-Z][a-zA-Z]*(?:\s+[A-Z][a-zA-Z]*)*\b/g) || [];
  entities.push(...properNouns.filter(n => n.length > 2));
  const projectPatterns = message.match(/\b[a-z]+[-_][a-z]+[-_a-z]*\b/gi) || [];
  entities.push(...projectPatterns);
  const acronyms = message.match(/\b[A-Z]{2,6}\b/g) || [];
  entities.push(...acronyms);
  const common = ['The', 'This', 'That', 'What', 'When', 'Where', 'How', 'Can', 'Could', 'Would', 'Should', 'Will', 'Did', 'Does', 'Has', 'Have', 'Been', 'Being', 'Are', 'Were', 'Was', 'Is'];
  return [...new Set(entities)].filter(e => !common.includes(e));
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await auth(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const db = await getDb();
  
  let message;
  if (req.method === 'POST') message = req.body.message;
  else if (req.method === 'GET') message = req.query.message;
  else return res.status(405).json({ error: 'Method not allowed' });

  if (!message) return res.status(400).json({ error: 'message parameter required' });

  try {
    const entities = extractEntities(message);
    
    if (entities.length === 0) {
      return res.status(200).json({ entities: [], memories: [], message: 'No entities detected' });
    }

    const searchConditions = entities.map(entity => ({
      $or: [
        { key: { $regex: entity, $options: 'i' } },
        { value: { $regex: entity, $options: 'i' } },
        { tags: { $regex: entity, $options: 'i' } }
      ]
    }));

    const results = await db.collection('memories')
      .find({ userId: user._id, $or: searchConditions.map(c => c.$or).flat() })
      .sort({ updatedAt: -1 })
      .limit(10)
      .toArray();

    return res.status(200).json({ entities, memories: results, count: results.length });
  } catch (err) {
    console.error('Enrich error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
