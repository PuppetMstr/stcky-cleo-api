// C:\Stcky\cleo-api\maintenance-head.js
//
// POST /api/maintenance/backfill-head
//
// ===========================================================================
// GIVE EVERY EXISTING OBJECT ITS `head`, FROM INSIDE THE API.
//
// WHY THIS EXISTS RATHER THAN A LOCAL SCRIPT: the first attempt was
// backfill-head.cjs, run from Steven's machine. It could not find a Mongo URI
// because there isn't one on that machine -- the connection string lives in
// Vercel's environment, where it belongs. The obvious next step was
// `vercel env pull`, which would have copied live production database
// credentials onto a laptop to solve a convenience problem. That is a bad
// trade and it is permanent: a pulled .env tends to stay pulled.
//
// The API already holds the connection. So the work happens here.
//
// WHAT IT DOES: finds objects belonging to the CALLING USER that have no
// `head` field, sets head = first 200 chars of content, in batches, until
// either nothing is left or the time budget runs out. Then reports how many
// remain so the caller knows whether to call again.
//
// SAFETY:
//   * Scoped to the authenticated user by the same auth() every other door
//     uses. It cannot touch another user's pool.
//   * It only ADDS a field. Never modifies content, never deletes, never
//     touches an object that already has a head.
//   * Idempotent and resumable. Call it as many times as you like.
//   * Bounded by a wall-clock budget so it returns a real answer instead of
//     dying at the function timeout -- the failure mode that killed the drip
//     twice. A cron that survives doing four is worth more than one that
//     dies doing twelve.
//   * GET with ?stats=1 reports totals and changes nothing.
//
// The read door stays correct throughout: /v1/read count mode keeps a
// { head: null } fallback branch alive, so a half-backfilled pool returns the
// same numbers as a finished one. Only the speed changes.
// ===========================================================================

const { getDb, auth, cors } = require('./_lib/auth');
const { HEAD_CHARS } = require('./_lib/objects');

const DEFAULT_BATCH = 300;
const MAX_BATCH = 1000;
const BUDGET_MS = 20000;   // well inside the function ceiling, with room to write the reply

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await auth(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const db = await getDb();
  const objects = db.collection('objects');
  const mine = { userId: user._id };
  const missingFilter = { ...mine, head: { $exists: false } };

  try {
    // ---- Read-only report ----
    if (req.method === 'GET') {
      const [total, missing] = await Promise.all([
        objects.countDocuments(mine),
        objects.countDocuments(missingFilter),
      ]);
      return res.status(200).json({
        mode: 'stats',
        total,
        missing_head: missing,
        done: missing === 0,
        head_chars: HEAD_CHARS,
        note: 'Nothing was written. POST to this same path to backfill.',
      });
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Use GET for stats, POST to backfill.' });
    }

    const body = req.body || {};
    const batch = Math.max(1, Math.min(parseInt(body.batch) || DEFAULT_BATCH, MAX_BATCH));

    const startedMissing = await objects.countDocuments(missingFilter);
    const t0 = Date.now();
    let updated = 0;
    let budgetSpent = false;

    while (true) {
      if (Date.now() - t0 > BUDGET_MS) { budgetSpent = true; break; }

      const docs = await objects
        .find(missingFilter, { projection: { _id: 1, content: 1 } })
        .limit(batch)
        .toArray();
      if (!docs.length) break;

      const ops = docs.map((d) => ({
        updateOne: {
          filter: { _id: d._id },
          update: { $set: { head: String(d.content || '').slice(0, HEAD_CHARS) } },
        },
      }));
      const r = await objects.bulkWrite(ops, { ordered: false });
      updated += r.modifiedCount || 0;
    }

    const remaining = await objects.countDocuments(missingFilter);

    // The index is created by ensureObjectIndexes on ingest cold start, but
    // createIndex is idempotent and cheap when it already exists -- so say so
    // out loud here rather than leave the caller wondering whether the win is
    // actually wired up.
    let index_ready = false;
    try {
      await objects.createIndex(
        { userId: 1, head: 1, ingested_at: 1 },
        { name: 'userId_head_ingested_at' }
      );
      index_ready = true;
    } catch (e) {
      index_ready = false;
    }

    return res.status(200).json({
      mode: 'backfill',
      started_missing: startedMissing,
      updated_this_call: updated,
      remaining,
      done: remaining === 0,
      budget_spent: budgetSpent,
      elapsed_ms: Date.now() - t0,
      index_ready,
      read_this: remaining === 0
        ? 'COMPLETE. Every object of yours now carries a head and can be counted from the index.'
        : 'NOT FINISHED -- ' + remaining + ' objects still lack a head. POST again to continue. ' +
          'Counts from /v1/read mode=count are CORRECT meanwhile; only slower, because those ' +
          'records still fall through to the content scan.',
    });
  } catch (err) {
    console.error('[maintenance/backfill-head] error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
};
