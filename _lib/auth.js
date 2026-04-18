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
    const user = await db.collection('users').findOne({ apiKey: apiKeyParam });
    if (user) return user;
  }
  
  // Check X-API-Key header
  const apiKey = req.headers['x-api-key'];
  if (apiKey) {
    const user = await db.collection('users').findOne({ apiKey });
    if (user) return user;
  }
  
  // Check Bearer token
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.log('[AUTH] No valid auth header found');
    return null;
  }
  
  const token = authHeader.replace('Bearer ', '');
  
  // API key format (cleo_)
  if (token.startsWith('cleo_')) {
    const user = await db.collection('users').findOne({ apiKey: token });
    if (user) return user;
    console.log('[AUTH] cleo_ token not found in database');
    return null;
  }
  
  // OAuth access token (stcky_) - NOT code or refresh
  if (token.startsWith('stcky_') && !token.startsWith('stcky_code_') && !token.startsWith('stcky_refresh_')) {
    try {
      const decoded = JSON.parse(Buffer.from(token.replace('stcky_', ''), 'base64').toString());
      
      // Accept tokens with type='access' OR no type field (backwards compat)
      if (decoded.type && decoded.type !== 'access') {
        console.log('[AUTH] OAuth token has wrong type:', decoded.type);
        return null;
      }
      
      if (!decoded.userId) {
        console.log('[AUTH] OAuth token missing userId');
        return null;
      }
      
      const user = await db.collection('users').findOne({ _id: new ObjectId(decoded.userId) });
      if (!user) {
        console.log('[AUTH] OAuth token userId not found:', decoded.userId);
        return null;
      }
      
      return user;
    } catch (e) {
      console.log('[AUTH] OAuth token parse error:', e.message);
      return null;
    }
  }
  
  // Reject code and refresh tokens
  if (token.startsWith('stcky_code_') || token.startsWith('stcky_refresh_')) {
    console.log('[AUTH] Received code/refresh token instead of access token');
    return null;
  }
  
  // Fallback: try as API key
  const user = await db.collection('users').findOne({ apiKey: token });
  if (user) return user;
  
  console.log('[AUTH] No matching auth method found');
  return null;
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
}

module.exports = { getDb, auth, cors, ObjectId };
