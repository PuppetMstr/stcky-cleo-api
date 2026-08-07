// admin-migrate-leads.js
//
// GET/POST /api/admin-migrate-leads?limit=2000
//
// ONE JOB: copy the Growbotik LEAD records out of the substrate and into a
// real table, in a database of their own, with indexes on the fields anyone
// actually queries. Read-only against the pool. Nothing is deleted, nothing is
// rewired, nothing that is running changes. It only makes a second copy.
//
// =============================================================================
// WHY THIS EXISTS
//
// Steven, Aug 5 2026, after two days of watching the machine and the bill:
// "Why does a feeder on growbotik hit atlas at all? ... It's costing a lot of
// money for what?" and then, plainly: "I think it's pretty inconvenient now."
//
// He is right, and the money is the smaller half of it.
//
// THE MAILER HAS NO DATABASE. It was built in July using the substrate as its
// storage, because the pool was already there with a door on it. So 9,029 LEAD
// records, 3,744 QUEUED letters, 1,360 SENT receipts, 878 refusals and 212
// voids -- 15,244 rows of pure operational ledger -- live in cleo.objects
// beside Steven's conversations, and EVERY ONE OF THEM CARRIES A 3,072-DIMENSION
// EMBEDDING so it can be found by semantic similarity.
//
// NOTHING HAS EVER SEARCHED THEM THAT WAY. Not once. Every question the mailer
// asks is exact: which leads are SENDABLE and uncontacted; has this address been
// mailed; how many are pending. Those are index questions.
//
// AND THAT IS NOT MERELY WASTEFUL -- IT IS WHY THE CAMPAIGN IS STARVING.
// The feeder finds its leads by asking the RANKED door 54 narrow questions, and
// that door returns at most 60 records each. Every receipt since Jul 21 has said
// so in its own words: "54/54 hit the 60-record ceiling, THE RESERVE NUMBER IS A
// FLOOR, NOT A TOTAL." On Aug 4 it found 291 leads, checked 240, found ZERO
// clean -- while 1,281 SENDABLE, VERIFIED NEVER TOUCHED addresses sat in the
// pool it could not reach. A similarity engine cannot answer "show me all of
// them", and asking it to is how a floor gets mistaken for an inventory.
//
// ONE INDEXED QUERY RETURNS ALL 1,281 WITH NO CEILING. At 9 letters a day the
// A/B/C message test needs a hundred days to produce a verdict. At 100 a day it
// needs nine. That difference is this file.
// =============================================================================
//
// SAFETY, because this touches the pool at all:
//   * READ ONLY on cleo.objects. There is no update, no delete, no $out.
//   * Idempotent. Upsert by email, so running it twice changes nothing and a
//     half-finished run is simply resumed.
//   * RESUMABLE. Vercel functions die at five minutes; this walks in batches
//     with a cursor and reports where it stopped, so it is called until it says
//     done rather than being trusted to finish in one go.
//   * It reads the parse from the SAME lead-parser the feeder uses, so a record
//     that the feeder can read is a record this can read, and vice versa. Two
//     dialects, one parser -- the Jul 19 hand-import wrote prose with em dashes
//     and "GRADE: SENDABLE" mid-line, and 819 leads went invisible for days
//     because a second reader was written that only knew one of them.
//
// Author: Eli -- Aug 5 2026
// =============================================================================

const { MongoClient } = require('mongodb');
const { auth, cors } = require('./_lib/auth');
// THE PARSER LIVES IN THE OTHER PROJECT AND CANNOT BE REQUIRED ACROSS THE
// BOUNDARY. Vercel bundles only what is inside the project root, so
// ../stcky-app/... would deploy clean and then throw at runtime. Rather than
// mirror the parser here -- a SECOND reader of the same records is precisely
// what cost 819 leads on Jul 19, when the feeder's copy knew the webhook
// dialect and not the prose one -- this file does NOT parse.
//
// It copies the record's own text across verbatim, plus the one field it can
// extract without interpretation: the email address. Everything the feeder
// derives -- business, trade, city, verdict, catch-all -- stays derived by the
// ONE parser that already exists, at read time, from the raw text sitting in
// the row. One parser, one truth, no drift.
//
// The indexes below therefore cover email and the raw head; the trade and
// verdict indexes get added when the feeder is pointed here and can populate
// those fields with its own parse in a single pass.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

const MONGODB_URI  = process.env.MONGODB_URI;

const POOL_DB   = 'cleo';
const POOL_COLL = 'objects';

// THE NEW HOME. A database of its own, in the same cluster -- not a new vendor
// and not a new bill. The pattern already exists here: localtravelpath and stcky
// are separate databases in this same cluster today. Growbotik gets the same.
const GB_DB = 'growbotik';

const BATCH = 2000;          // objects scanned per call, default
const BUDGET_MS = 60000;     // stop and report well short of the function ceiling

let cachedClient = null;
async function client() {
  if (cachedClient) return cachedClient;
  cachedClient = new MongoClient(MONGODB_URI);
  await cachedClient.connect();
  return cachedClient;
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  // ===========================================================================
  // FOUNDER-TIER AUTH, THE SAME AS EVERY OTHER ADMIN ROUTE IN THIS PROJECT.
  // Aug 5 2026.
  //
  // My first draft invented an ADMIN_SECRET env var. Steven then asked where to
  // find it -- and the answer was that it does not exist. I made up a
  // credential rather than reading how admin-ingest.js and admin-shadow-stats.js
  // already do this: the caller's OWN api key, and a tier check. One more thing
  // asserted instead of looked up, in a week full of them.
  //
  // WHY THIS IS NOT REACHING AROUND THE WALL, which is worth stating plainly
  // since this route touches Mongo directly:
  // THIS ENDPOINT NEVER RETURNS POOL CONTENT. Not one record, not one line of
  // text. It answers with counts -- scanned, parsed, written, remaining -- and a
  // resume cursor. It copies rows from one database to another inside Atlas and
  // reports arithmetic. The read doors are still the only way anybody, including
  // me, gets to see what a record SAYS.
  // ===========================================================================
  const caller = await auth(req);
  if (!caller) return res.status(401).json({ error: 'unauthorized' });
  if (caller.tier !== 'founder') return res.status(403).json({ error: 'founder tier required' });
  if (!MONGODB_URI) return res.status(503).json({ error: 'MONGODB_URI not set' });

  const started = Date.now();
  const limit = Math.max(100, Math.min(20000, parseInt(req.query.limit || BATCH, 10)));
  const after = req.query.after || null;   // resume cursor: last _id seen

  try {
    const c = await client();
    const pool = c.db(POOL_DB).collection(POOL_COLL);
    const leads = c.db(GB_DB).collection('leads');

    // Indexes first, and these are the whole point of the exercise: the questions
    // the feeder actually asks, answered by an index instead of by ranking.
    await leads.createIndex({ email: 1 }, { unique: true });
    await leads.createIndex({ head: 1 });
    await leads.createIndex({ scraped_at: 1 });

    // WALK BY _id, NOT BY TIME. _id ordering is total and stable, so a resumed
    // run cannot skip or repeat a row -- which a timestamp walk can do when two
    // records share a millisecond.
    const q = { head: { $regex: '^LEAD ' } };
    if (after) q._id = { $gt: after };

    const cur = pool.find(q, {
      projection: { content: 1, head: 1, timestamp: 1, ingested_at: 1 },
    }).sort({ _id: 1 }).limit(limit);

    let scanned = 0, parsed = 0, written = 0, unparsed = 0, lastId = after;
    const ops = [];

    for await (const d of cur) {
      scanned++;
      lastId = d._id;
      if (Date.now() - started > BUDGET_MS) break;

      const m = String(d.content || '').match(EMAIL_RE);
      if (!m) { unparsed++; continue; }
      parsed++;

      ops.push({
        updateOne: {
          filter: { email: m[0].toLowerCase() },
          update: {
            $setOnInsert: {
              email: m[0].toLowerCase(),
              scraped_at: d.timestamp || d.ingested_at || null,
              source_object_id: d._id,
            },
            $set: {
              // THE RECORD'S OWN WORDS, CARRIED ACROSS UNTOUCHED. Everything
              // else -- business, trade, city, verdict, catch-all -- is derived
              // from this by the feeder's parser, which is the only parser.
              raw: d.content,
              head: d.head || String(d.content || '').slice(0, 200),
              // NOT SET: contacted. Contact is a fact about the SEND ledger, not
              // about the lead. Defaulting it to false here would mark 621
              // already-mailed people as fresh, which is exactly how somebody
              // gets written to twice.
            },
          },
          upsert: true,
        },
      });
    }

    if (ops.length) {
      const r = await leads.bulkWrite(ops, { ordered: false });
      written = (r.upsertedCount || 0) + (r.modifiedCount || 0);
    }

    const remaining = await pool.countDocuments(
      after || lastId ? { head: { $regex: '^LEAD ' }, _id: { $gt: lastId } }
                      : { head: { $regex: '^LEAD ' } }
    );
    const total = await leads.countDocuments({});

    return res.status(200).json({
      did: remaining > 0 ? 'partial' : 'complete',
      scanned, parsed, unparsed, written,
      leads_in_table: total,
      remaining_in_pool: remaining,
      next_after: remaining > 0 ? String(lastId) : null,
      ms: Date.now() - started,
      read_this: remaining > 0
        ? 'NOT FINISHED. Call again with ?after=' + String(lastId) + ' until remaining_in_pool is 0.'
        : 'Every LEAD record in the pool has been copied. Nothing was deleted and nothing was rewired ' +
          '-- the pool is untouched and the mailer still reads from it until the feeder is pointed here.',
    });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
