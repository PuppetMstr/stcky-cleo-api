// growbotik-reserve.js
//
// GET /api/growbotik/reserve?limit=500&after=<email>
//
// ONE JOB: hand the mailer its own leads, out of its own table, in one query,
// with no ceiling.
//
// =============================================================================
// WHAT THIS REPLACES, AND WHY IT IS THE WHOLE POINT
//
// queue-feeder builds its reserve by asking the RANKED search door 54 narrow
// questions -- "LEAD roofing Anaheim", "LEAD plumbing Long Beach" -- and taking
// the top 60 of each. Every receipt since Jul 21 has ended with the same
// confession, in the machine's own words:
//
//     read : 54/54 lead queries answered, 54 HIT THE 60-RECORD CEILING
//            -- THE RESERVE NUMBER IS A FLOOR, NOT A TOTAL.
//
// On Aug 4 that cost the campaign its morning: the feeder found 291 leads,
// checked 240, found ZERO clean, and loaded nothing -- while 1,281 SENDABLE,
// verified, never-touched addresses sat in the pool it could not see. Not a bug
// in the feeder. THE CONSEQUENCE OF ASKING A SIMILARITY ENGINE AN EXACT
// QUESTION. Ranking answers "what is most like this". It cannot answer "show me
// all of them", and when every question comes back full, the number you get is
// the size of the cap, not the size of the reserve.
//
// This endpoint answers the actual question -- give me the leads -- against an
// indexed table of 3,213 rows. No rotation matrix, no 24-of-176 slice, no
// ceiling, no floor. It pages by email so a caller can walk the whole set and
// KNOW it has the whole set.
//
// AND IT REPLACES 54 ROUND TRIPS WITH ONE. The drip's ranked calls were
// measured on Aug 4 at 33 to 41 SECONDS EACH. This is an indexed find.
// =============================================================================
//
// WHAT IT DOES NOT DO, deliberately:
//
//   IT DOES NOT PARSE. It returns each lead's own text exactly as the record
//   wrote it. The feeder's parser -- the ONLY parser -- derives business, trade,
//   city and verdict at read time, as it always has. A second reader of the same
//   records is what cost 819 leads on Jul 19, when one copy knew the webhook
//   dialect and the other knew the prose one and neither knew it was blind.
//
//   IT DOES NOT DECIDE WHO IS SENDABLE. The grades are law and they live in the
//   text. This hands over rows; the feeder applies the trade gate, the
//   suppression list, the touched roster and verifyUncontacted exactly as it
//   does today. Nothing about who gets mailed changes in this file.
//
//   IT DOES NOT KNOW WHO HAS BEEN CONTACTED. Contact is a fact about the SEND
//   ledger, and the send ledger has not moved yet. The feeder's own database
//   verification remains the gate that stops anybody being written to twice.
//
// Author: Eli -- Aug 5 2026
// =============================================================================

const { MongoClient } = require('mongodb');
const { auth, cors } = require('./_lib/auth');

const MONGODB_URI = process.env.MONGODB_URI;
const GB_DB = 'growbotik';

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

  const caller = await auth(req);
  if (!caller) return res.status(401).json({ error: 'unauthorized' });
  if (caller.tier !== 'founder') return res.status(403).json({ error: 'founder tier required' });
  if (!MONGODB_URI) return res.status(503).json({ error: 'MONGODB_URI not set' });

  const started = Date.now();
  const limit = Math.max(1, Math.min(2000, parseInt(req.query.limit || '500', 10)));
  const after = (req.query.after || '').toLowerCase();

  try {
    const c = await client();
    const leads = c.db(GB_DB).collection('leads');

    // PAGED BY EMAIL, WHICH IS UNIQUE AND INDEXED. A cursor on a unique key
    // cannot skip a row or hand one back twice, which a skip/offset walk can do
    // the moment anything is inserted mid-walk.
    const q = after ? { email: { $gt: after } } : {};
    const rows = await leads.find(q, {
      projection: { _id: 0, email: 1, raw: 1, head: 1, scraped_at: 1 },
    }).sort({ email: 1 }).limit(limit).toArray();

    const total = await leads.countDocuments({});
    const remaining = await leads.countDocuments(
      rows.length ? { email: { $gt: rows[rows.length - 1].email } } : q
    );

    return res.status(200).json({
      leads: rows,
      returned: rows.length,
      total_in_table: total,
      remaining,
      next_after: remaining > 0 && rows.length ? rows[rows.length - 1].email : null,
      complete: remaining === 0,
      ms: Date.now() - started,
      // THE HONESTY LINE, in the response rather than in a comment about the
      // response. Every other read door in this system has had to learn to say
      // whether its answer was whole; this one says it from the first day.
      read_this: remaining === 0
        ? 'COMPLETE. Every lead in the table after this cursor was returned. This is a TOTAL, not a floor.'
        : 'PARTIAL. ' + remaining + ' more leads exist after this page. Call again with ?after=' +
          (rows.length ? rows[rows.length - 1].email : '') +
          ' until complete is true. This page is a FLOOR, not the reserve.',
    });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
