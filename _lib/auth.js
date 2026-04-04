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

async function auth(req) {
  const db = await getDb();
  
  // Check query param (for GET requests via MCP)
  const apiKeyParam = req.query?.apiKey;
  if (apiKeyParam) {
    return await db.collection('users').findOne({ apiKey: apiKeyParam });
  }
  
  // Check X-API-Key header
  const apiKey = req.headers['x-api-key'];
  if (apiKey) {
    return await db.collection('users').findOne({ apiKey });
  }
  
  // Check Bearer token
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  
  const token = authHeader.replace('Bearer ', '');
  
  // API key format (cleo_)
  if (token.startsWith('cleo_')) {
    return await db.collection('users').findOne({ apiKey: token });
  }
  
  // OAuth access token (stcky_)
  if (token.startsWith('stcky_') && !token.startsWith('stcky_code_') && !token.startsWith('stcky_refresh_')) {
    try {
      const decoded = JSON.parse(Buffer.from(token.replace('stcky_', ''), 'base64').toString());
      if (decoded.type !== 'access') return null;
      return await db.collection('users').findOne({ _id: new ObjectId(decoded.userId) });
    } catch (e) {
      return null;
    }
  }
  
  // Fallback: try as API key
  return await db.collection('users').findOne({ apiKey: token });
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
}

module.exports = { getDb, auth, cors, ObjectId };
