// C:\Stcky\cleo-api\backfill-head.cjs
// ===========================================================================
// SUPERSEDED Jul 28 2026 by POST /api/maintenance/backfill-head.
//
// This script needs a Mongo connection string on the local machine, and there
// isn't one -- the URI lives in Vercel's environment, which is correct. The
// only way to run this locally is `vercel env pull`, which copies live
// production database credentials onto a laptop to save a few keystrokes.
// Not worth it, and a pulled .env tends to stay pulled.
//
// The maintenance endpoint does the same work inside the API, where the
// connection already exists, scoped to the calling user by the same auth()
// every other door uses. Use that.
//
// This file is kept, not deleted, for the case where someone is already
// holding a URI legitimately (a migration, a restore, a local Mongo). It
// still works if MONGODB_URI is set in the environment.
// ===========================================================================
// ORIGINAL NOTES BELOW.
// ===========================================================================
// BACKFILL `head` ONTO EVERY OBJECT WRITTEN BEFORE JUL 28 2026.
//
// WHY: /v1/read mode=count answers "does a record start with this prefix" --
// the question every prior-contact, opt-out, bounce and drip-confirmation gate
// in this system is really asking. It used to ask it of `content`, which is
// unindexed and holds whole email bodies, so each question read the entire
// collection. Seven of those per address, 15s apiece, is what starved the
// drip's confirmation budget and left it reporting "database confirmation
// failed" for nine hours against a pool that knew the answer.
//
// Objects now carry `head` (first 200 chars) and an index on
// { userId, head, ingested_at }. New writes get it automatically. This script
// gives it to everything already in the pool.
//
// SAFETY:
//   * It only ADDS a field. It never modifies content, never deletes, never
//     touches an object that already has a head.
//   * The read door keeps a { head: null } fallback branch live, so counts are
//     CORRECT while this runs, not just after. You can stop it and restart it
//     at any point; it resumes on whatever is still missing.
//   * Idempotent. Running it twice is a no-op the second time.
//
// RUN:
//   cd /d C:\Stcky\cleo-api
//   node backfill-head.cjs
//
// Add --dry to count what would change without writing anything.
// ===========================================================================

const path = require('path');
const fs = require('fs');
const { MongoClient } = require('mongodb');

const HEAD_CHARS = 200;
const BATCH = 500;
const DRY = process.argv.includes('--dry');

// Find the Mongo connection string.
//
// FIXED TWICE Jul 28 2026. v1 looked only for `.env.local`. v2 looked in the
// right files but only for four guessed KEY NAMES, and cleo-api names it
// something else -- so the script listed the very file holding the value and
// declared it absent. Guessing a name is the same mistake as guessing a path.
//
// v3 STOPS GUESSING AND READS THE VALUE. A Mongo URI announces itself:
// mongodb:// or mongodb+srv://. So take any KEY=VALUE line whose value looks
// like one. The key can be called whatever it likes.
//
// It prints the KEY NAME it used and never the value, and if nothing matches
// it lists the key names it did see -- names only -- so the next run is
// informed rather than blind.
const MONGO_SHAPE = /^mongodb(\+srv)?:\/\//i;

function loadUri() {
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string' && MONGO_SHAPE.test(v.trim())) {
      console.log(`connection from: environment variable ${k}`);
      return v.trim();
    }
  }

  const files = [
    path.join(__dirname, '.env'),
    path.join(__dirname, '.env.local'),
    path.join(__dirname, '..', '.env'),
    path.join(__dirname, '..', '.env.local'),
  ];

  const seen = [];
  for (const p of files) {
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      const key = m[1];
      const val = m[2].trim().replace(/^["']|["']$/g, '');
      seen.push(key + '  (' + path.basename(p) + ')');
      if (MONGO_SHAPE.test(val)) {
        console.log(`connection from: ${p}  (key ${key})`);
        return val;
      }
    }
  }

  console.error('No value starting with mongodb:// or mongodb+srv:// in any of:');
  for (const p of files) console.error('  ' + p + (fs.existsSync(p) ? '' : '   (no such file)'));
  if (seen.length) {
    console.error('\nKeys present in those files (names only, no values):');
    for (const s of seen) console.error('  ' + s);
  }
  return null;
}

(async () => {
  const uri = loadUri();
  if (!uri) {
    console.error('\nNo Mongo URI available.');
    console.error('Pull it from Vercel:   vercel env pull .env.local');
    console.error('or set it for one run: set MONGODB_URI=...   then  node backfill-head.cjs');
    process.exit(1);
  }

  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
  await client.connect();
  const db = client.db();
  const objects = db.collection('objects');

  const total = await objects.countDocuments({});
  const missing = await objects.countDocuments({ head: { $exists: false } });
  console.log('objects total   :', total);
  console.log('missing head    :', missing);

  if (DRY) {
    console.log('\n--dry: nothing written.');
    await client.close();
    return;
  }

  if (missing === 0) {
    console.log('\nNothing to backfill.');
  } else {
    let done = 0;
    const t0 = Date.now();
    while (true) {
      const batch = await objects
        .find({ head: { $exists: false } }, { projection: { _id: 1, content: 1 } })
        .limit(BATCH)
        .toArray();
      if (!batch.length) break;

      const ops = batch.map((d) => ({
        updateOne: {
          filter: { _id: d._id },
          update: { $set: { head: String(d.content || '').slice(0, HEAD_CHARS) } },
        },
      }));
      const r = await objects.bulkWrite(ops, { ordered: false });
      done += r.modifiedCount || 0;
      const pct = Math.round((done / missing) * 100);
      console.log(`  ${done}/${missing}  (${pct}%)`);
    }
    console.log(`\nbackfilled ${done} objects in ${Math.round((Date.now() - t0) / 1000)}s`);
  }

  // The API creates this index on cold start too, but do it here so the win is
  // available the moment the backfill finishes rather than on the next deploy.
  console.log('\nensuring index userId_head_ingested_at ...');
  const name = await objects.createIndex(
    { userId: 1, head: 1, ingested_at: 1 },
    { name: 'userId_head_ingested_at' }
  );
  console.log('index ready:', name);

  const stillMissing = await objects.countDocuments({ head: { $exists: false } });
  console.log('\nremaining without head:', stillMissing);
  console.log(stillMissing === 0
    ? 'COMPLETE. Every object can now be counted from the index.'
    : 'NOT COMPLETE -- re-run. The read door is still correct meanwhile.');

  await client.close();
})().catch((e) => {
  console.error('backfill failed:', e && e.message || e);
  process.exit(1);
});
