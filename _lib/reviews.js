// C:\Stcky\cleo-api\_lib\reviews.js — WHAT PEOPLE SAY
// =============================================================================
// Steven, Aug 2 2026, describing the whole feature in one breath and correcting
// three days of my overbuilding:
//
//   "Orange dot. Want to know more? Tap. It goes and looks. It comes back and
//    says: people have a hard time getting their money out."
//
// That is the entire specification. One sentence, in the words customers used,
// added to the panel Guardian already opens. Not a score. Not a dossier. Not
// investment analysis. Not "this domain has never appeared in your records."
//
// THE PROBLEM IT SOLVES, and it has a face: a man standing on an orange dot with
// his card out. Today the only thing Guardian can tell him is "never seen this
// before" -- a dead end wearing a warning label. Paul does not know Trustpilot
// exists. He cannot tell a pig-butchering review from a billing complaint. He is
// the person this line is for.
//
// WHY THIS IS NOT A SECOND PRODUCT. Everything else in STCKY runs on the user's
// own pool and gets better because the pool grew. This does not: what customers
// say about a plumber is the same for Steven, for Sharon, for Paul. That makes it
// an INGEST PATH, not a product -- something that goes out, gathers, and pours
// what it found in. Same shape as the mail sweep. The pool still answers; this
// only feeds it.
//
// THREE RULES, and they are load-bearing:
//
//   1. IT NEVER MOVES THE DOT. Research adds information; it must never turn
//      caution green or caution red. The moment this produces a grade we have
//      built a blocklist with extra steps, which is the thing Guardian exists
//      not to be. guardian.js decides the level and never reads this.
//
//   2. IT IS NEVER FETCHED AT THE MOMENT OF THE TAP. The person is standing
//      there with a card out. Anything they wait for, they skip. So the line is
//      either ALREADY CACHED when the panel opens, or the panel simply does not
//      have that line. No spinner, ever, and no loading state to render.
//
//   3. IT REPORTS WHAT WAS SAID, NEVER A VERDICT. "People say it's tough getting
//      your money out" is a finding. "This company is risky" is a judgment, and
//      judgment belongs on the other side of the wall.
//
// THE CACHE IS PER-DOMAIN AND SHARED, deliberately. This holds no user data --
// it is public review material, identical for everyone -- so one person's lookup
// pays for every later reader on that domain. That is what makes it affordable
// at $9/mo: the first visitor to alinea-invest.com costs a few cents, the next
// three thousand cost nothing.
// =============================================================================
'use strict';

const MODEL = 'claude-sonnet-4-6';
const PRICE = { 'claude-sonnet-4-6': { in: 3.00, out: 15.00 } };

const COLL      = 'domain_reviews';
const FRESH_MS  = 90 * 24 * 60 * 60 * 1000;  // a finding older than 90 days is re-gathered
const RETRY_MS  = 10 * 60 * 1000;            // a FAILED or still-claimed look is retried after this
const READ_MS   = 900;                       // cache read budget -- it sits in front of a page load
const GATHER_MS = 90000;                     // the background gather may take its time; nobody waits on it

// -----------------------------------------------------------------------------
// THE READ. One indexed lookup, tight budget, and it fails SILENT -- a cache miss
// and a broken database must look identical to the caller, because in both cases
// the honest answer is the same: this panel does not have that line today.
// -----------------------------------------------------------------------------
async function reviewLine(db, domain) {
  if (!db || !domain) return null;
  try {
    const doc = await db.collection(COLL).findOne({ _id: domain });
    if (!doc || !doc.line) return null;
    if (Date.now() - new Date(doc.gathered_at).getTime() > FRESH_MS) return null;
    return { line: doc.line, sources: doc.sources || [], gathered_at: doc.gathered_at };
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Has anyone already looked, recently, whether or not they found anything? A
// domain where the search came back EMPTY is still a domain that has been looked
// at, and re-searching it on every visit is how a per-domain cost becomes a
// per-visit cost. So an empty result is written down too.
// -----------------------------------------------------------------------------
async function alreadyLooked(db, domain) {
  try {
    const doc = await db.collection(COLL).findOne({ _id: domain }, { projection: { gathered_at: 1, status: 1 } });
    if (!doc) return false;
    const age = Date.now() - new Date(doc.gathered_at).getTime();

    // A FAILED LOOK IS NOT A LOOK, AND A CLAIM IS NOT A RESULT.
    //
    // The claim is written BEFORE the model is called, so two people landing on
    // the same page do not both pay. But that claim also made `gathered_at`
    // fresh -- so a gather that crashed, timed out, or came back unparseable
    // would leave a doc that looked exactly like a completed one, and the domain
    // would never be tried again for ninety days. One bad minute would have
    // poisoned a domain for a quarter, invisibly.
    //
    // So: only a FINISHED look counts as a look. Anything still claimed or
    // failed is retried after a short cooldown -- long enough not to hammer a
    // broken door, short enough that a transient failure is not permanent.
    if (doc.status === 'gathering' || doc.status === 'failed') return age <= RETRY_MS;

    return age <= FRESH_MS;
  } catch {
    return true;   // on error, DO NOT gather. A broken cache must not become a spend loop.
  }
}

// -----------------------------------------------------------------------------
// THE PROMPT.
//
// It asks for one thing and refuses the rest. The failure mode I hit reading
// Alinea by hand is exactly what this has to survive: 292 reviews, a wall of
// short generic praise that reads like a prompted review flow, one review
// describing $180,000 and "release fees" that was almost certainly a
// pig-butchering scam wearing the company's name, and an F BBB rating sourced
// from a scam-recovery site that exists to farm anxiety. All three are noise.
// The signal was underneath: dozens of people, separately, saying they were
// charged after cancelling and could not get out.
//
// So: the repeated sentence, or nothing. "Nothing" is a perfectly good answer
// and it must be easy for the model to give.
// -----------------------------------------------------------------------------
function buildPrompt(domain) {
  return [
    'Find out what CUSTOMERS say about ' + domain + ' -- the company behind that website.',
    '',
    'Search real consumer review sources: Trustpilot, the Better Business Bureau,',
    'Google reviews, app store reviews, Reddit. Read what people actually wrote.',
    '',
    'You are looking for ONE THING: the complaint that REPEATS. Not the angriest',
    'review, not the average rating -- the thing many different people describe',
    'separately, in their own words. In consumer complaints it is almost always',
    'about what happens AFTER you pay: money that will not come back, charges that',
    'keep coming, a cancellation that did not take, something that never arrived,',
    'nobody answering.',
    '',
    'DISCARD, and this matters more than finding something:',
    '  - Short generic praise in the same register ("so easy!", "love it!"). That is',
    '    a prompted review flow, not evidence.',
    '  - Reviews describing very large sums and demands for "release" or "processing"',
    '    fees to withdraw. That is a separate scam wearing this company\'s name, and',
    '    reporting it as this company\'s behaviour would be wrong.',
    '  - Ratings and warnings from scam-recovery or review-recovery sites. They exist',
    '    to farm anxiety.',
    '  - Anything about stock performance, returns, or whether something is a good',
    '    investment. Not the question.',
    '',
    'If no complaint repeats -- if the reviews are ordinary, or thin, or you cannot',
    'find real ones -- say so by returning null. That is a good answer. Do not',
    'manufacture a concern to have something to report.',
    '',
    'Return ONLY a JSON object, no preamble and no code fences:',
    '{',
    '  "line": "one plain sentence under 14 words, in the words customers used,',
    '           starting with the words People say -- or null if nothing repeats",',
    '  "seen": "roughly how many reviews you actually read, as a number",',
    '  "sources": ["up to 3 URLs where a person can read it themselves"]',
    '}',
    '',
    'The line will be read by someone in their seventies standing in front of a',
    'sign-up form with a card in their hand. Plain words. No jargon. No hedging.',
  ].join('\n');
}

// -----------------------------------------------------------------------------
// THE GATHER. Fire-and-forget: it is never awaited by anything a person is
// waiting on, and it can never throw into a caller. Its only job is to leave
// something in the cache for the NEXT person who lands on this domain.
// -----------------------------------------------------------------------------
async function gather(db, domain) {
  if (!db || !domain || !process.env.ANTHROPIC_API_KEY) return;

  // Claim the domain BEFORE the call, so two people landing on the same page at
  // the same moment do not both pay for it.
  try {
    await db.collection(COLL).updateOne(
      { _id: domain },
      { $setOnInsert: { domain, line: null, sources: [], gathered_at: new Date(), status: 'gathering' } },
      { upsert: true }
    );
  } catch {
    return;
  }

  let out = { line: null, seen: null, sources: [] };
  let costUSD = null;
  let failed = null;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1500,
        messages: [{ role: 'user', content: buildPrompt(domain) }],
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      }),
      signal: AbortSignal.timeout(GATHER_MS),
    });
    if (!r.ok) throw new Error('model door -> ' + r.status);

    const ad = await r.json();
    const u  = ad && ad.usage;
    const px = PRICE[MODEL];
    if (u && px) costUSD = ((u.input_tokens / 1e6) * px.in) + ((u.output_tokens / 1e6) * px.out);

    // Search-enabled responses interleave text, tool_use and tool_result blocks.
    // Take the text blocks by TYPE, never by position.
    const text = (ad.content || [])
      .filter((b) => b.type === 'text').map((b) => b.text).join('\n')
      .replace(/```json|```/g, '').trim();

    const m = text.match(/\{[\s\S]*\}/);       // the model may narrate before the JSON
    out = JSON.parse(m ? m[0] : text);
  } catch (e) {
    failed = String((e && e.message) || e);
  }

  let line = (typeof out.line === 'string' && out.line.trim()) ? out.line.trim() : null;
  if (line && line.split(/\s+/).length > 18) line = null;   // it broke the shape; drop it rather than show a paragraph

  const sources = Array.isArray(out.sources) ? out.sources.slice(0, 3).map(String) : [];

  try {
    await db.collection(COLL).updateOne(
      { _id: domain },
      { $set: {
          domain,
          line,
          sources,
          seen: Number(out.seen) || null,
          gathered_at: new Date(),
          status: failed ? 'failed' : (line ? 'found' : 'nothing-repeats'),
          error: failed,
          cost_usd: costUSD,
          model: MODEL,
      } },
      { upsert: true }
    );
  } catch { /* a cache write failure changes nothing a person sees */ }

  // THE FINDING GOES IN THE POOL TOO, raw, like everything else -- so that next
  // time this domain comes up the ordinary check is already stronger, without
  // any new mechanism. Only when something was actually found; an empty search
  // is cache business, not substrate business.
  return { line, sources, cost_usd: costUSD, status: failed ? 'failed' : (line ? 'found' : 'nothing-repeats') };
}

module.exports = { reviewLine, alreadyLooked, gather, COLL };
