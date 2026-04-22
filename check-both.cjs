// check-both.cjs
//
// Read-only diagnostic: counts users and memories in BOTH the `cleo` and
// `stcky` databases on the cluster. Useful for verifying which db is the
// canonical one and spotting drift between them.
//
// Usage:
//   set MONGODB_URI=mongodb+srv://...   (omit /cleo suffix is fine; this script names its own dbs)
//   node check-both.cjs
// Or:
//   node check-both.cjs "mongodb+srv://..."
//
// Reads only. No writes.

const { MongoClient } = require('mongodb');

const uri = process.argv[2] || process.env.MONGODB_URI;
if (!uri) {
  console.error('ERROR: MongoDB URI required.');
  console.error('  set MONGODB_URI=<full-uri>   then: node check-both.cjs');
  console.error('  Or:  node check-both.cjs "<full-uri>"');
  process.exit(1);
}

async function run() {
  const client = new MongoClient(uri);
  try {
    await client.connect();

    const cleoCount = await client.db('cleo').collection('memories').countDocuments();
    const stckyCount = await client.db('stcky').collection('memories').countDocuments();
    const cleoUsers = await client.db('cleo').collection('users').countDocuments();
    const stckyUsers = await client.db('stcky').collection('users').countDocuments();

    console.log('CLEO db  — users:', cleoUsers,  '| memories:', cleoCount);
    console.log('STCKY db — users:', stckyUsers, '| memories:', stckyCount);
  } finally {
    await client.close();
  }
}

run().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
