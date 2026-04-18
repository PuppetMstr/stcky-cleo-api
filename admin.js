const { MongoClient, ObjectId } = require('mongodb');

const uri = process.env.MONGODB_URI;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'stcky_admin_2026';

let client;

async function getDb() {
  if (!client) {
    client = new MongoClient(uri);
    await client.connect();
  }
  return client.db('cleo');
}

// Regular user auth (for /api/me)
async function auth(req) {
  const db = await getDb();
  
  const apiKeyParam = req.query?.apiKey;
  if (apiKeyParam) {
    return await db.collection('users').findOne({ apiKey: apiKeyParam });
  }
  
  const apiKey = req.headers['x-api-key'];
  if (apiKey) {
    return await db.collection('users').findOne({ apiKey });
  }
  
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  
  const token = authHeader.replace('Bearer ', '');
  
  if (token.startsWith('cleo_')) {
    return await db.collection('users').findOne({ apiKey: token });
  }
  
  if (token.startsWith('stcky_') && !token.startsWith('stcky_code_') && !token.startsWith('stcky_refresh_')) {
    try {
      const decoded = JSON.parse(Buffer.from(token.replace('stcky_', ''), 'base64').toString());
      if (decoded.type !== 'access') return null;
      return await db.collection('users').findOne({ _id: new ObjectId(decoded.userId) });
    } catch (e) {
      return null;
    }
  }
  
  return await db.collection('users').findOne({ apiKey: token });
}

function getAction(url) {
  if (url.includes('/api/me')) return 'me';
  if (url.includes('/admin/upgrade')) return 'upgrade';
  if (url.includes('/admin/email-export')) return 'email-export';
  return 'users';
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key, X-Admin-Secret');
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = getAction(req.url);

  // ============ ME (User Profile) ============
  if (action === 'me') {
    const user = await auth(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const db = await getDb();

    // GET - Return user profile
    if (req.method === 'GET') {
      return res.json({
        id: user._id,
        email: user.email,
        name: user.name,
        timezone: user.timezone || 'UTC',
        tier: user.tier || 'free',
        memoryLimit: user.memoryLimit || 100,
        createdAt: user.createdAt,
        lastSeen: user.lastSeen
      });
    }

    // PUT - Update user preferences
    if (req.method === 'PUT') {
      const { timezone, name } = req.body;
      
      const updates = {};
      
      if (timezone) {
        try {
          Intl.DateTimeFormat(undefined, { timeZone: timezone });
          updates.timezone = timezone;
        } catch (e) {
          return res.status(400).json({ error: 'Invalid timezone: ' + timezone });
        }
      }
      
      if (name) {
        updates.name = name;
      }
      
      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'No valid fields to update' });
      }
      
      updates.updatedAt = new Date();
      
      await db.collection('users').updateOne(
        { _id: user._id },
        { $set: updates }
      );
      
      return res.json({
        success: true,
        updated: Object.keys(updates).filter(k => k !== 'updatedAt'),
        timezone: updates.timezone || user.timezone || 'UTC'
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ============ UPGRADE (POST only) ============
  if (action === 'upgrade') {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed. Use POST.' });
    }

    const { email, tier, secret } = req.body;

    if (secret !== ADMIN_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!email || !tier) {
      return res.status(400).json({ error: 'Missing email or tier' });
    }

    const tierLimits = {
      free: { memories: 100, projects: 3 },
      pro: { memories: 10000, projects: 50 },
      team: { memories: 100000, projects: 500 }
    };

    if (!tierLimits[tier]) {
      return res.status(400).json({ error: 'Invalid tier. Use: free, pro, or team' });
    }

    try {
      const db = await getDb();
      const user = await db.collection('users').findOne({ email });

      if (!user) {
        return res.status(404).json({ error: 'User not found', email });
      }

      const now = new Date().toISOString();
      await db.collection('users').updateOne(
        { email },
        {
          $set: {
            plan: tier,
            tier: tier,
            memoryLimit: tierLimits[tier].memories,
            maxMemories: tierLimits[tier].memories,
            maxProjects: tierLimits[tier].projects,
            tierUpdatedAt: now,
            tierSource: 'admin_override',
            tierNotes: `Upgraded by admin on ${now}`
          }
        }
      );

      const updatedUser = await db.collection('users').findOne({ email });

      return res.status(200).json({
        success: true,
        message: `User upgraded to ${tier}`,
        user: {
          email: updatedUser.email,
          plan: updatedUser.plan,
          memoryLimit: updatedUser.memoryLimit,
          maxProjects: updatedUser.maxProjects,
          tierUpdatedAt: updatedUser.tierUpdatedAt
        }
      });

    } catch (error) {
      console.error('Admin upgrade error:', error);
      return res.status(500).json({ error: 'Server error', details: error.message });
    }
  }

  // ============ GET-only admin routes below ============
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const adminSecret = req.query.secret || req.headers['x-admin-secret'];
  if (!adminSecret || adminSecret !== ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const db = await getDb();

    // ============ EMAIL EXPORT ============
    if (action === 'email-export') {
      const segment = req.query.segment || 'all';
      const format = req.query.format || 'json';
      const inactiveDays = parseInt(req.query.inactiveDays) || 14;
      const powerMemories = parseInt(req.query.powerMemories) || 50;

      const now = new Date();
      let query = {};

      switch (segment) {
        case 'free': query.plan = { $in: ['free', null] }; break;
        case 'paid': query.plan = { $in: ['pro', 'team'] }; break;
        case 'inactive':
          const inactiveDate = new Date(now);
          inactiveDate.setDate(inactiveDate.getDate() - inactiveDays);
          query.$or = [{ lastLoginAt: { $lt: inactiveDate } }, { lastLoginAt: null }];
          break;
        case 'new':
          const newDate = new Date(now);
          newDate.setDate(newDate.getDate() - 7);
          query.createdAt = { $gte: newDate };
          break;
        case 'churn_risk':
          const churnDate = new Date(now);
          churnDate.setDate(churnDate.getDate() - 7);
          query.plan = { $in: ['free', null] };
          query.$or = [{ lastLoginAt: { $lt: churnDate } }, { lastLoginAt: null }];
          break;
      }

      const users = await db.collection('users').find(query).sort({ createdAt: -1 }).toArray();
      const userIds = users.map(u => u._id);
      const memoryCounts = await db.collection('memories').aggregate([
        { $match: { userId: { $in: userIds } } },
        { $group: { _id: '$userId', count: { $sum: 1 } } }
      ]).toArray();

      const memoryCountMap = {};
      memoryCounts.forEach(m => { memoryCountMap[m._id.toString()] = m.count; });

      let filteredUsers = users.map(u => ({
        email: u.email,
        plan: u.plan || 'free',
        memoryCount: memoryCountMap[u._id.toString()] || 0,
        createdAt: u.createdAt,
        lastLoginAt: u.lastLoginAt || null,
        daysSinceSignup: Math.floor((now - new Date(u.createdAt)) / (1000 * 60 * 60 * 24)),
        daysSinceLogin: u.lastLoginAt ? Math.floor((now - new Date(u.lastLoginAt)) / (1000 * 60 * 60 * 24)) : null
      }));

      if (segment === 'power') filteredUsers = filteredUsers.filter(u => u.memoryCount >= powerMemories);
      if (segment === 'churn_risk') filteredUsers = filteredUsers.filter(u => u.memoryCount < 20);

      if (format === 'csv') {
        const header = 'email,plan,memoryCount,createdAt,lastLoginAt,daysSinceSignup,daysSinceLogin';
        const rows = filteredUsers.map(u =>
          `${u.email},${u.plan},${u.memoryCount},${u.createdAt?.toISOString() || ''},${u.lastLoginAt?.toISOString() || ''},${u.daysSinceSignup},${u.daysSinceLogin || ''}`
        );
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="stcky-users-${segment}.csv"`);
        return res.send([header, ...rows].join('\n'));
      }

      return res.json({ segment, count: filteredUsers.length, exportedAt: now.toISOString(), users: filteredUsers });
    }

    // ============ USERS LIST ============
    const query = {};
    if (req.query.plan) query.plan = req.query.plan;

    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const sortField = req.query.sort || 'createdAt';
    const sortOrder = req.query.order === 'asc' ? 1 : -1;

    const users = await db.collection('users').find(query).sort({ [sortField]: sortOrder }).limit(limit).toArray();
    const userIds = users.map(u => u._id);
    const memoryCounts = await db.collection('memories').aggregate([
      { $match: { userId: { $in: userIds } } },
      { $group: { _id: '$userId', count: { $sum: 1 } } }
    ]).toArray();

    const memoryCountMap = {};
    memoryCounts.forEach(m => { memoryCountMap[m._id.toString()] = m.count; });

    const totalUsers = await db.collection('users').countDocuments();
    const totalFree = await db.collection('users').countDocuments({ plan: { $in: ['free', null] } });
    const totalPro = await db.collection('users').countDocuments({ plan: 'pro' });
    const totalTeam = await db.collection('users').countDocuments({ plan: 'team' });

    const formattedUsers = users.map(u => ({
      email: u.email,
      plan: u.plan || 'free',
      memoryCount: memoryCountMap[u._id.toString()] || 0,
      memoryLimit: u.memoryLimit || 100,
      stripeCustomerId: u.stripeCustomerId || null,
      paypalSubscriberId: u.paypalSubscriberId || null,
      subscriptionStatus: u.subscriptionStatus || null,
      paymentProvider: u.paymentProvider || null,
      createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt || null
    }));

    res.json({
      users: formattedUsers,
      count: users.length,
      stats: { total: totalUsers, free: totalFree, pro: totalPro, team: totalTeam }
    });
  } catch (error) {
    console.error('Admin error:', error);
    res.status(500).json({ error: 'Failed to process admin request' });
  }
};
