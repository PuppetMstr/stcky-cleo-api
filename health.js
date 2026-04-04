const { getDb, auth, cors } = require('./_lib/auth');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const isDeep = req.url.includes('/deep') || req.query.deep === 'true';
  const version = '4.5.0';

  // Shallow health - just confirms server is running
  if (!isDeep) {
    return res.status(200).json({
      status: 'ok',
      version,
      functions: 12,
      endpoints: [
        'GET /api/health',
        'GET /api/health/deep',
        'GET/POST/DELETE /api/memory',
        'GET/POST /api/memory/list',
        'GET /api/memory/search',
        'GET /api/memory/upcoming',
        'GET/POST /api/associative',
        'GET/POST /api/enrich',
        'GET/POST /api/sessions',
        'GET/POST/PUT/DELETE /api/projects',
        'GET/POST/PUT/DELETE /api/teams',
        'GET/POST/DELETE /api/edges',
        'GET/POST /api/graph',
        'GET/POST /api/oauth/authorize',
        'POST /api/oauth/token',
        'GET /api/admin/users',
        'GET /api/admin/email-export',
        'POST /api/stripe/checkout',
        'POST /api/stripe/webhook'
      ],
      enterprise: ['projects', 'teams', 'edges', 'graph'],
      timestamp: new Date().toISOString()
    });
  }

  // Deep health - actually tests auth, db, read, write
  const checks = {
    auth: { status: 'pending', ms: 0 },
    database: { status: 'pending', ms: 0 },
    read: { status: 'pending', ms: 0 },
    write: { status: 'pending', ms: 0 }
  };

  let overallStatus = 'ok';
  const startTime = Date.now();

  try {
    // Check 1: Auth
    const authStart = Date.now();
    const user = await auth(req);
    checks.auth.ms = Date.now() - authStart;
    
    if (!user) {
      checks.auth.status = 'fail';
      checks.auth.error = 'No valid API key provided';
      overallStatus = 'unhealthy';
    } else {
      checks.auth.status = 'ok';
      checks.auth.userId = user._id.toString().slice(-6); // Last 6 chars only
    }

    // Check 2: Database connection
    const dbStart = Date.now();
    const db = await getDb();
    checks.database.ms = Date.now() - dbStart;
    checks.database.status = 'ok';

    // Check 3: Read canary memory
    if (user) {
      const readStart = Date.now();
      const canary = await db.collection('memories').findOne({
        userId: user._id,
        key: '_health_canary'
      });
      checks.read.ms = Date.now() - readStart;
      checks.read.status = 'ok';
      checks.read.canaryExists = !!canary;
      
      // Check 4: Write test (create/update canary)
      const writeStart = Date.now();
      await db.collection('memories').updateOne(
        { userId: user._id, key: '_health_canary' },
        { 
          $set: { 
            userId: user._id,
            category: 'system',
            key: '_health_canary',
            value: `Health check at ${new Date().toISOString()}`,
            updatedAt: new Date()
          },
          $setOnInsert: {
            createdAt: new Date()
          }
        },
        { upsert: true }
      );
      checks.write.ms = Date.now() - writeStart;
      checks.write.status = 'ok';
    } else {
      checks.read.status = 'skip';
      checks.read.reason = 'No auth';
      checks.write.status = 'skip';
      checks.write.reason = 'No auth';
    }

  } catch (err) {
    overallStatus = 'unhealthy';
    const failedCheck = Object.keys(checks).find(k => checks[k].status === 'pending');
    if (failedCheck) {
      checks[failedCheck].status = 'fail';
      checks[failedCheck].error = err.message;
    }
  }

  const totalMs = Date.now() - startTime;

  const response = {
    status: overallStatus,
    version,
    checks,
    totalMs,
    timestamp: new Date().toISOString()
  };

  const httpStatus = overallStatus === 'ok' ? 200 : 503;
  return res.status(httpStatus).json(response);
};
