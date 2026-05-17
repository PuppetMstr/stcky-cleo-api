const { MongoClient, ObjectId } = require('mongodb');

const uri = process.env.MONGODB_URI;
let client;
let lastHealthy = 0; // ms timestamp of last successful ping; 0 = never

// MongoClient options tuned for Vercel serverless. Defaults are wrong for
// our shape:
//   - serverSelectionTimeoutMS default = 30000ms, but Vercel function
//     timeout is ~10s -- a stuck client makes the whole function time out
//     waiting for server selection instead of failing fast and letting
//     Vercel route the next call to a fresh Lambda. Set to 5s.
//   - maxPoolSize default = 100; serverless instances are short-lived and
//     handle low concurrency per Lambda. 100 connections × N warm Lambdas
//     can hit Atlas connection caps. Cap at 10.
//   - maxIdleTimeMS default = 0 (never close idle). Upstream NATs / load
//     balancers may silently drop sockets that have been idle for a few
//     minutes, leaving the driver holding zombie connections that
//     topologyClosed/close events don't always catch. Evict idle after 60s.
const MONGO_OPTS = {
  serverSelectionTimeoutMS: 5000,
  maxPoolSize: 10,
  maxIdleTimeMS: 60000,
};

// Re-ping at most every HEALTH_CHECK_INTERVAL_MS milliseconds. Inside the
// window we trust the cached client; outside we send a cheap `ping` command
// before reuse. This catches zombie clients that the topologyClosed/close
// event listeners miss (e.g. socket death from idle timeout upstream of the
// driver, network partition not raising a server-level event).
const HEALTH_CHECK_INTERVAL_MS = 30000;

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
 *
 * Patch (2026-05-17, Eli): health-check ping at most every 30s, plus
 * explicit MongoClient options tuned for Vercel serverless. Closes the
 * cascade pattern where a warm Lambda would 401 across all endpoints
 * after the cached client's socket died without firing topologyClosed/
 * close events. Driven by finding/reference-cleo-api-lib-auth-js-source-
 * 2026-05-17 (auth.js had no liveness check between cached-client reuse
 * and findOne against it).
 */
async function getDb() {
  const now = Date.now();

  if (client) {
    if (now - lastHealthy < HEALTH_CHECK_INTERVAL_MS) {
      // Recent ping was good. Trust the cached client.
      return client.db('cleo');
    }
    // Stale ping window -- verify the cached client is still alive
    // before handing it out. Cheap (~1-5ms) and catches zombies.
    try {
      await client.db('cleo').command({ ping: 1 });
      lastHealthy = now;
      return client.db('cleo');
    } catch (err) {
      console.log('[GETDB] cached client failed ping, rebuilding:', err.name, err.message);
      try { await client.close(); } catch {}
      client = null;
      lastHealthy = 0;
    }
  }

  const c = new MongoClient(uri, MONGO_OPTS);

  // If the topology closes (network loss, server-side kill, etc.), drop
  // the reference so the next getDb() call builds a fresh client.
  c.on('topologyClosed', () => {
    if (client === c) {
      console.log('[GETDB] topologyClosed event, nulling client');
      client = null;
      lastHealthy = 0;
    }
  });
  c.on('close', () => {
    if (client === c) {
      console.log('[GETDB] close event, nulling client');
      client = null;
      lastHealthy = 0;
    }
  });

  try {
    await c.connect();
    client = c;
    lastHealthy = now;
  } catch (err) {
    // Connect failed -- do NOT assign `c` to `client`. Leave `client` null
    // so the next request tries fresh. Attempt best-effort cleanup.
    try { await c.close(); } catch {}
    throw err;
  }

  return client.db('cleo');
}

async function auth(req) {
  let db;
  try {
    db = await getDb();
  } catch (err) {
    // Surface the infrastructure failure mode clearly. Without this log,
    // a Mongo connect failure became an opaque 401 indistinguishable from
    // "valid key not in DB". Now Vercel logs say which it was.
    console.log('[AUTH] getDb failed:', err.name, err.message);
    return null;
  }

  const users = db.collection('users');

  // Wrapper that distinguishes thrown-error null from not-found null.
  // Both return null to the caller (preserves existing behavior) but the
  // log surfaces which path we took. Critical for diagnosing cascade
  // events vs legitimate auth failures.
  async function lookup(filter, context) {
    try {
      return await users.findOne(filter);
    } catch (err) {
      console.log(`[AUTH] findOne ERROR (${context}):`, err.name, err.message);
      return null;
    }
  }

  // Check query param (for GET requests via MCP)
  const apiKeyParam = req.query && req.query.apiKey;
  if (apiKeyParam) {
    const user = await lookup({ apiKey: apiKeyParam }, 'query.apiKey');
    if (user) return user;
  }

  // Check X-API-Key header
  const apiKey = req.headers['x-api-key'];
  if (apiKey) {
    const user = await lookup({ apiKey }, 'x-api-key header');
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
    const user = await lookup({ apiKey: token }, 'cleo_ bearer');
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

      const user = await lookup({ _id: new ObjectId(decoded.userId) }, 'stcky_ oauth');
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
  const user = await lookup({ apiKey: token }, 'fallback');
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
