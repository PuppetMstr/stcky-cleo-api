// C:\Stcky\api\admin\upgrade.js
// Admin endpoint to upgrade a user to Pro tier (founder override)
// POST /api/admin/upgrade with { email, tier, secret }

const { MongoClient } = require('mongodb');

const ADMIN_SECRET = process.env.ADMIN_SECRET || 'stcky_admin_2026';
const MONGODB_URI = process.env.MONGODB_URI;

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  const { email, tier, secret } = req.body;
  
  // Validate admin secret
  if (secret !== ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  if (!email || !tier) {
    return res.status(400).json({ error: 'Missing email or tier' });
  }
  
  // Valid tiers and their limits
  const tierLimits = {
    free: { memories: 100, projects: 3 },
    pro: { memories: 10000, projects: 50 },
    team: { memories: 100000, projects: 500 }
  };
  
  if (!tierLimits[tier]) {
    return res.status(400).json({ error: 'Invalid tier. Use: free, pro, or team' });
  }
  
  let client;
  try {
    client = new MongoClient(MONGODB_URI);
    await client.connect();
    const db = client.db('cleo');
    
    // Find user by email
    const user = await db.collection('users').findOne({ email });
    
    if (!user) {
      return res.status(404).json({ error: 'User not found', email });
    }
    
    // Update user tier
    const now = new Date().toISOString();
    const result = await db.collection('users').updateOne(
      { email },
      {
        $set: {
          tier: tier,
          maxMemories: tierLimits[tier].memories,
          maxProjects: tierLimits[tier].projects,
          tierUpdatedAt: now,
          tierSource: 'admin_override',
          tierNotes: `Upgraded by admin on ${now}`
        }
      }
    );
    
    if (result.modifiedCount === 0) {
      return res.status(500).json({ error: 'Failed to update user' });
    }
    
    // Fetch updated user
    const updatedUser = await db.collection('users').findOne({ email });
    
    return res.status(200).json({
      success: true,
      message: `User upgraded to ${tier}`,
      user: {
        email: updatedUser.email,
        tier: updatedUser.tier,
        maxMemories: updatedUser.maxMemories,
        maxProjects: updatedUser.maxProjects,
        tierUpdatedAt: updatedUser.tierUpdatedAt
      }
    });
    
  } catch (error) {
    console.error('Admin upgrade error:', error);
    return res.status(500).json({ error: 'Server error', details: error.message });
  } finally {
    if (client) await client.close();
  }
};
