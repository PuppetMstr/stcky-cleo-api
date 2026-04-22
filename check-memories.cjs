// check-memories.cjs
//
// Read-only diagnostic: groups memories by userId, counts each group, and
// joins each group to the user's email. Useful for spotting orphaned memories
// (memories whose userId doesn't match any user record) and for understanding
// which accounts have volume.
//
// Usage:
//   set MONGODB_URI=mongodb+srv://...
//   node check-memories.cjs
// Or:
//   node check-memories.cjs "mongodb+srv://..."
//
// Reads only. No writes.

const { MongoClient } = require('mongodb');

const uri = process.argv[2] || process.env.MONGODB_URI;
if (!uri) {
  console.error('ERROR: MongoDB URI required.');
  console.error('  set MONGODB_URI=<full-uri>   then: node check-memories.cjs');
  console.error('  Or:  node check-memories.cjs "<full-uri>"');
  process.exit(1);
}

async function run() {
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db('cleo');

    const counts = await db.collection('memories').aggregate([
      { $group: { _id: '$userId', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]).toArray();

    console.log('Memories by userId:');
    for (const c of counts) {
      const user = await db.collection('users').findOne({ _id: c._id });
      console.log(
        '-',
        c.count, 'memories',
        '| userId:', c._id,
        '| email:', user?.email || 'NO USER FOUND'
      );
    }
  } finally {
    await client.close();
  }
}

run().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
