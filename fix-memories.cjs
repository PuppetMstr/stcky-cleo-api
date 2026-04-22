// fix-memories.cjs
//
// One-shot utility: reassigns memory documents from an OLD userId to a NEW
// userId. Used historically when a user account got recreated (new _id) and
// existing memories needed to be re-homed to the new account.
//
// ⚠️  This script WRITES. Only run with explicit intent. Review the OLD_USER_ID
// and NEW_USER_ID constants below before each run — they are intentionally NOT
// accepted as argv to force the operator to open this file and confirm.
//
// Usage:
//   1. Open this file. Edit OLD_USER_ID and NEW_USER_ID to match the intended reassignment.
//   2. set MONGODB_URI=mongodb+srv://...
//   3. node fix-memories.cjs
//
// Writes: .updateMany on the `memories` collection in `cleo` db. Logs count modified.

const { MongoClient, ObjectId } = require('mongodb');

// ------------------------------------------------------------------
// EDIT THESE TWO LINES BEFORE RUNNING.
const OLD_USER_ID = '69b200d63d46e7f86b53d8fa';
const NEW_USER_ID = '69daac3717bf200a6d8e4060';
// ------------------------------------------------------------------

const uri = process.argv[2] || process.env.MONGODB_URI;
if (!uri) {
  console.error('ERROR: MongoDB URI required.');
  console.error('  set MONGODB_URI=<full-uri>   then: node fix-memories.cjs');
  process.exit(1);
}

async function run() {
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db('cleo');

    const result = await db.collection('memories').updateMany(
      { userId: new ObjectId(OLD_USER_ID) },
      { $set: { userId: new ObjectId(NEW_USER_ID) } }
    );

    console.log('Reassigned', result.modifiedCount, 'memories');
    console.log('  from userId:', OLD_USER_ID);
    console.log('  to   userId:', NEW_USER_ID);
  } finally {
    await client.close();
  }
}

run().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
