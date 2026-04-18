const { getDb, auth, cors, ObjectId } = require('./_lib/auth');

/**
 * /api/me - User profile endpoint
 * GET: Returns user profile including timezone
 * PUT: Updates user preferences (timezone, etc.)
 */
module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

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
      // Validate timezone
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
};
