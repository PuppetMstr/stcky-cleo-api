const { MongoClient, ObjectId } = require('mongodb');

const uri = process.env.MONGODB_URI;
let client;

/**
 * Get the cleo DB handle, maintaining a module-scoped MongoClient across
 * warm Lambda invocations.
 *
 * Fix (2026-04-22): if connect() throws, null out `client` so the next
 * request retries cleanly. Previously a failed connect left `client` holding
 * a dead object, so every subsequent `findOne` on that warm Lambda threw
 * "MongoTopologyClosedError: Topology is closed" until Vercel cycled the
 * instance. Surfaced during the morning MongoDB password rotation when
 * early requests hit the URI before the new password propagated.
 *
 * Also listens for topology-level close events so we rebuild the client
 * if the driver loses the connection mid-lifetime.
 */
async function getDb() {
  if (!client) {
    const c = new MongoClient(uri);

    // If the topology closes (network loss, server-side kill, etc.), drop
    // the reference so the next getDb() call builds a fresh client.
    c.on('topologyClosed', () => {
      if (client === c) client = null;
    });
    c.on('close', () => {
      if (client === c) client = null;
    });

    try {
      await c.connect();
      client = c;
    } catch (err) {
      // Connect failed — do NOT assign `c` to `client`. Leave `client` null
      // so the next request tries fresh. Attempt best-effort cleanup.
      try { await c.close(); } catch {}
      throw err;
    }
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
