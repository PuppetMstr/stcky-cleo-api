// check.cjs
//
// Read-only diagnostic: prints the current user record for the founder email.
// Useful for verifying user state (apiKey, tier, memoryLimit, etc.) without
// going through the API.
//
// Usage:
//   set MONGODB_URI=mongodb+srv://...
//   node check.cjs
// Or:
//   node check.cjs "mongodb+srv://..."
//
// Reads only. No writes.

const { MongoClient } = require('mongodb');

const uri = process.argv[2] || process.env.MONGODB_URI;
if (!uri) {
  console.error('ERROR: MongoDB URI required.');
  console.error('  Either:  set MONGODB_URI=<full-uri>   then: node check.cjs');
  console.error('  Or:      node check.cjs "<full-uri>"');
  process.exit(1);
}

async function run() {
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const user = await client.db('cleo').collection('users').findOne({
      email: 'stevengwinstead@gmail.com'
    });
    if (!user) {
      console.log('No user found.');
      return;
    }
    console.log('Found user:', JSON.stringify(user, null, 2));
  } finally {
    await client.close();
  }
}

run().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
