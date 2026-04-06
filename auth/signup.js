const { MongoClient } = require('mongodb');
const crypto = require('crypto');

const uri = process.env.MONGODB_URI;

async function getDb() {
  const client = new MongoClient(uri);
  await client.connect();
  return { client, db: client.db('cleo') };
}

function generateApiKey() {
  return 'cleo_' + crypto.randomBytes(16).toString('hex');
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  const { email, password, profile } = req.body;
  
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }
  
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  
  let client;
  
  try {
    const connection = await getDb();
    client = connection.client;
    const db = connection.db;
    
    // Check for existing user
    const existing = await db.collection('users').findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(409).json({ error: 'Email already registered' });
    }
    
    const apiKey = generateApiKey();
    const now = new Date();
    
    // Create user
    const user = {
      email: email.toLowerCase(),
      passwordHash: hashPassword(password),
      apiKey,
      plan: 'free',
      memoryCount: 0,
      memoryLimit: 100,
      projectLimit: 3,
      createdAt: now,
      updatedAt: now
    };
    
    const userResult = await db.collection('users').insertOne(user);
    const userId = userResult.insertedId;
    
    // If profile data provided, save as form-fill-profile memory
    if (profile && typeof profile === 'object') {
      // Build clean profile object
      const formFillProfile = {
        firstName: profile.firstName || '',
        lastName: profile.lastName || '',
        email: email.toLowerCase(),
        phone: profile.phone || '',
        company: profile.company || '',
        title: profile.title || '',
        city: profile.city || '',
        state: profile.state || '',
        zip: profile.zip || '',
        country: profile.country || 'United States'
      };
      
      // Save to memories collection
      const memory = {
        userId,
        category: 'preference',
        key: 'form-fill-profile',
        value: JSON.stringify(formFillProfile),
        tags: 'guardian,form-fill,profile',
        source: 'signup',
        importanceScore: 8,
        stabilityScore: 9,
        createdAt: now,
        updatedAt: now
      };
      
      await db.collection('memories').insertOne(memory);
      
      // Increment memory count
      await db.collection('users').updateOne(
        { _id: userId },
        { $inc: { memoryCount: 1 } }
      );
    }
    
    res.json({
      success: true,
      email: user.email,
      apiKey: user.apiKey,
      plan: user.plan,
      limits: {
        memories: user.memoryLimit,
        projects: user.projectLimit
      }
    });
    
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ error: 'Signup failed' });
  } finally {
    if (client) {
      await client.close();
    }
  }
};
