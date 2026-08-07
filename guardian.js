// C:\Stcky\cleo-api\guardian.js — STCKY Guardian, the check door
// =============================================================================
// Route: POST /api/guardian/check   (add to vercel.json builds + routes)
//
// WHY THIS FILE EXISTS. Guardian v1.5.4 shipped six times asking the USER to
// paste an Anthropic API key into the extension popup. Sharon is 70-something,
// mostly disabled, on a hand-me-down Windows 10 machine, and she is the entire
// point of the product. She will never paste an API key. Neither will anybody's
// mother. That single text box meant Guardian had exactly one possible user in
// the world and it was Steven.
//
// So the model call moves here. The extension holds a STCKY key -- the same
// cleo_ key it already needs to read the pool -- and nothing else. One
// credential, issued by us, revocable by us, meaningless to a scammer who
// steals it off her laptop.
//
// AND IT FIXES THE SECOND DEFECT FOR FREE. The old extension judged a page by
// its URL alone. A scam site's URL looks fine; that is the entire craft. This
// door takes the page: title, visible text, the names of the fields it is
// asking her to fill, and whether any of them want a password or a card.
//
// AND THE THIRD. The old client and the old server both read
// cleo-api.vercel.app/api/memory -- the marker store retired Jul 18 2026, empty
// by design. Guardian has therefore been blind to the pool since the day the
// pool became the pool. It has been a generic URL checker wearing our logo.
// This door asks the real substrate, through the real doors, with her key.
//
// WHAT ONLY THE POOL CAN DO, and the reason this is not another blocklist:
// Terry lost $35,000 and Sharon lost $200,000, and in both cases nobody had the
// whole picture -- including them. The bank saw one transfer. A friend heard one
// odd remark. Nobody saw three transfers over five weeks, escalating. A
// blocklist cannot know Sharon has no grandson named Kevin. The pool can,
// because it is the only thing that has all of it.
// =============================================================================
const { auth, cors, getDb } = require('./_lib/auth');
// WHAT PEOPLE SAY -- read from cache only, never fetched while anyone is waiting,
// and it can never move the dot. See _lib/reviews.js for why.
const reviews = require('./_lib/reviews');

const API      = 'https://api.stcky.ai';
const MODEL    = 'claude-sonnet-4-6';
// PER-MILLION-TOKEN PRICES, from Anthropic's published rate card. These exist so the
// COST OF A FREE GUARDIAN IS A MEASURED FACT AND NOT AN ESTIMATE. Steven, Jul 31 2026:
// the cost is a selling point, not a problem -- but only if we know what it actually is.
// If MODEL changes, CHANGE THESE. A stale price is worse than no price, because it
// looks like a measurement.
const PRICE = { 'claude-sonnet-4-6': { in: 3.00, out: 15.00 },
                'claude-haiku-4-5-20251001': { in: 1.00, out: 5.00 } };
const LEVELS   = ['safe', 'caution', 'warning', 'danger'];

// Budgets. This door sits in front of a page load; a guardian that takes ten
// seconds to colour a dot is a guardian nobody keeps installed.
//
// POOL_MS CORRECTED Jul 29 2026, within the hour of first deploy, on measured
// evidence rather than taste. It was 3500ms. send-pacer.js records the exists
// door answering in 0.77s, 2.58s, 4.69s and 7.51s in production -- so a 3.5s
// budget times out more often than it succeeds. And a timed-out pool is not
// neutral here: the prompt tells the model to treat pool silence as NO
// information, which pushes every verdict toward danger. The first live test
// returned `danger` on irs.gov with pool_read "failed".
//
// A guardian whose default state is alarm is a guardian that gets ignored, and
// then it protects nobody. Ten false alarms in a day is exactly how STCKY Watch
// taught this lesson on Steven's own machine this morning.
//
// The two pool questions now run in PARALLEL, so a longer budget costs one wait
// and not two.
const POOL_MS  = 7500;   // both pool calls, concurrently
const MODEL_MS = 12000;  // the judgment itself
const MAX_TEXT = 6000;   // characters of visible page text sent to the model

// =============================================================================
// UNKNOWN IS NEVER SAFE.
//
// Every other organ in this system learned this the hard way and wrote it down:
// the pacer said "queue empty" when it meant "I could not see," and it cost a
// morning of open send window. send-pacer.js now carries the sentence in
// capitals -- ABSENCE OF EVIDENCE PRODUCED BY A BAD QUERY IS NOT EVIDENCE OF
// ABSENCE.
//
// For a guardian the stakes run the other way and the rule is therefore
// stricter: a failed read must never render as a green dot. If the model call
// times out, if the pool is down, if the JSON comes back malformed -- the answer
// is `unknown`, the dot goes grey, and FILL IS REFUSED. A guardian that fails
// open is decoration.
// =============================================================================
const UNKNOWN = (why) => ({
  threat_level: 'unknown',
  reason: 'Guardian could not check this page. Be careful, and do not enter personal details.',
  fill_allowed: false,
  signals: [],
  degraded: true,
  why,
});

// -----------------------------------------------------------------------------
// Ask the pool, over the same public doors everything else uses. Deliberately
// HTTP and not a direct Mongo query: these contracts are stable, verified in
// production daily, and this file does not then need to know the object schema.
// The alternative is guessing at internals, which is the house disease.
// -----------------------------------------------------------------------------
async function poolDoor(key, path, body, ms) {
  const r = await fetch(API + path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(ms),
  });
  if (!r.ok) throw new Error(path + ' -> ' + r.status);
  return r.json();
}

// What does her own life say about this outfit? Two questions, both cheap.
//
//   1. mode=exists on the bare domain -- literal substring, no ranking, no
//      window, no ceiling. "Has this name EVER appeared in my life?" The exists
//      door is the right door for a single decisive question; a recency window
//      would miss anything older than a day.
//   2. associative on the domain and the page's own words -- "what does my pool
//      associate with this?" Ranked, so it surfaces the representative rather
//      than the unresolved, which is exactly right here.
//
// Both fail soft INTO THE PROMPT, not into a verdict: if the pool is unreachable
// the model is told the pool was unreachable, and the model is instructed that
// silence from the pool is not reassurance.
async function askPool(key, domain, title) {
  const out = { known: null, context: [], error: null };

  // CONCURRENT, not sequential. Sequentially these two cost up to 15s before the
  // model has even been asked, which is longer than anyone will wait for a dot.
  const [seenR, assocR] = await Promise.allSettled([
    poolDoor(key, '/v1/read', { mode: 'exists', needle: domain }, POOL_MS),
    (async () => {
      const q = encodeURIComponent([domain, title].filter(Boolean).join(' ').slice(0, 120));
      const r = await fetch(API + '/api/associative?query=' + q, {
        headers: { Authorization: 'Bearer ' + key },
        signal: AbortSignal.timeout(POOL_MS),
      });
      if (!r.ok) throw new Error('associative -> ' + r.status);
      return r.json();
    })(),
  ]);

  if (seenR.status === 'fulfilled') {
    out.known = !!(seenR.value && seenR.value.found);
  } else {
    out.error = 'exists: ' + ((seenR.reason && seenR.reason.message) || seenR.reason);
  }

  // ===========================================================================
  // GUARDIAN MUST NOT READ ITS OWN HANDWRITING AS EVIDENCE.
  //
  // FOUND LIVE, Aug 2 2026, on Steven's screen. alinea-invest.com came back
  // `caution / domain never seen` at 9:12 AM -- correct. That verdict was written
  // into the pool, as every check is. An hour later the SAME page came back
  // `safe`, and the signal it gave was "domain matches user records." It did.
  // The record it matched was Guardian's own note saying it had never seen the
  // domain before.
  //
  // Left alone, every domain on earth turns green on the second visit, and the
  // organ whose entire job is to say "I do not know this place" becomes the
  // reason it knows the place. Sharon's second look at a scam is the dangerous
  // one, and it is exactly the one this would have waved through.
  //
  // It is the house disease in a new organ -- an instrument reading its own
  // output back as a fact about the world -- and it is the third time today.
  //
  // THE FILTER IS DELIBERATELY CRUDE, AND IT IS NOT THE REAL FIX. The exists
  // door answers found/not-found over a substring scan; it cannot be asked "found
  // in anything I did not write myself." So this checks the ranked context for a
  // single entry that is not Guardian's own handwriting. It is imperfect: a real
  // mention that never surfaces in the top 8 will be missed, and a miss here
  // reads as `never seen`, which is the SAFE direction to be wrong in. Erring
  // toward "unfamiliar" costs a moment of caution. Erring toward "familiar" costs
  // what it cost Terry.
  //
  // THE REAL FIX, when the exists door can take it: a speaker/pipeline exclusion
  // at the door itself, so the question is asked properly instead of corrected
  // afterwards.
  // ===========================================================================
  if (assocR.status === 'fulfilled') {
    out.context = ((assocR.value && assocR.value.objects) || []).slice(0, 8).map(
      (o) => String(o.content || '').replace(/\s+/g, ' ').slice(0, 300)
    );
  } else {
    // A FAILED ASSOCIATIVE READ IS NOT A FAILED POOL READ. Only `exists` answers
    // the decisive question -- has this name ever appeared in this person's life.
    // Losing the ranked context costs colour, not judgment, so it must not flip
    // the whole verdict into degraded/alarm.
    out.context_error = 'associative: ' + ((assocR.reason && assocR.reason.message) || assocR.reason);
  }

  // THE FILTER ITSELF, applied only once the context actually exists.
  if (out.known && out.context.length) {
    const mine = (s) => /^(GUARDIAN CHECK|WHAT PEOPLE SAY)\b/.test(String(s).trim());
    const somebodyElse = out.context.filter((c) => !mine(c));
    if (!somebodyElse.length) {
      out.known = false;
      out.self_only = true;
    }
    out.context = somebodyElse;
  }

  return out;
}

// -----------------------------------------------------------------------------
// THE PROMPT. Written for the reader, not for the log.
//
// The reason string is the only part of this system Sharon will ever read, and
// she will read it while a stranger is on the phone telling her to hurry. So it
// gets a hard shape: one sentence, plain words, no jargon, no hedging, and it
// must name the thing that is actually wrong rather than describing a category
// of risk.
//
// The four levels map to the dot the extension already draws -- 12px green,
// 24px yellow, 48px orange, 80px red. That interface is the best thing in the
// old build: wordless, unmissable, and it GROWS with the danger, so the amount
// of screen it takes is proportional to how much she should care.
// -----------------------------------------------------------------------------
function buildPrompt(page, pool) {
  const fields = (page.fields || []).slice(0, 40).join(', ') || '(none seen)';
  const poolBlock = pool.error
    ? 'THE POOL COULD NOT BE READ (' + pool.error + '). Treat this as NO information. ' +
      'Silence from a broken pool is not reassurance -- but it is ALSO NOT EVIDENCE OF DANGER. ' +
      'Judge the page on the page. Do not raise the level merely because the records were unavailable.'
    : (pool.known
        ? 'This domain HAS appeared somewhere in the user\'s own records before.'
        : 'This domain has NEVER appeared anywhere in the user\'s own records.') +
      (pool.context.length
        ? '\n\nRelated entries from the user\'s own records:\n- ' + pool.context.join('\n- ')
        : '\n\nNo related entries surfaced.');

  return [
    'You are STCKY Guardian. You protect one person while they browse. Many of the',
    'people you protect are older, are not technical, and may be on the phone with',
    'someone pressuring them while they read your answer.',
    '',
    'Judge THIS PAGE. Weigh the page content far more heavily than the domain name:',
    'a convincing scam almost always has an unremarkable URL.',
    '',
    'URL   : ' + page.url,
    'TITLE : ' + (page.title || '(none)'),
    'FORM FIELDS ON THE PAGE : ' + fields,
    'ASKS FOR A PASSWORD : ' + (page.has_password ? 'YES' : 'no'),
    'ASKS FOR CARD OR BANK DETAILS : ' + (page.has_payment ? 'YES' : 'no'),
    '',
    'VISIBLE PAGE TEXT (truncated):',
    '"""',
    String(page.text || '').slice(0, MAX_TEXT),
    '"""',
    '',
    'WHAT THIS PERSON\'S OWN RECORDS SAY:',
    poolBlock,
    '',
    'Weigh especially: urgency and countdowns; instructions to keep this private or',
    'not tell family; demands for gift cards, wire transfers, crypto or remote-access',
    'software; claims to be a bank, government agency, or a relative in trouble;',
    'requests for card, bank, password or government ID details on a page with no',
    'established relationship in the records above; a login form whose branding does',
    'not match its domain; and any contradiction between what the page claims to be',
    'and what the records show.',
    '',
    'Return ONLY a JSON object, no preamble and no code fences:',
    '{',
    '  "threat_level": "safe" | "caution" | "warning" | "danger",',
    '  "reason": "one plain sentence, under 25 words, that a 78-year-old can act on",',
    '  "fill_allowed": true only when threat_level is "safe",',
    '  "signals": ["short phrases naming what you actually saw"]',
    '}',
  ].join('\n');
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  // ONE CREDENTIAL, AND IT IS OURS. The extension presents a cleo_ key; this
  // door resolves it to a user through the same _lib/auth every other endpoint
  // uses. No Anthropic key ever leaves this server, and none ever reaches the
  // browser.
  const user = await auth(req);
  if (!user) return res.status(401).json({ error: 'unauthorized' });

  if (!process.env.ANTHROPIC_API_KEY)
    return res.status(200).json(UNKNOWN('ANTHROPIC_API_KEY not set on the server'));

  const page = (req.body && typeof req.body === 'object') ? req.body : {};
  if (!page.url) return res.status(400).json({ error: 'url required' });

  let domain = '';
  try { domain = new URL(page.url).hostname.replace(/^www\./, ''); } catch { domain = ''; }

  // Never spend a model call, or write a record, for a page that is not a page.
  if (/^(chrome|about|edge|moz-extension|chrome-extension|file):/i.test(page.url))
    return res.status(200).json({
      threat_level: 'safe', reason: 'Browser page.', fill_allowed: true, signals: [], skipped: true,
    });

  const key = (req.headers.authorization || '').replace('Bearer ', '') ||
              req.headers['x-api-key'] || '';

  try {
    const pool = await askPool(key, domain, page.title);

    const ar = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 400,
        messages: [{ role: 'user', content: buildPrompt(page, pool) }],
      }),
      signal: AbortSignal.timeout(MODEL_MS),
    });
    if (!ar.ok) return res.status(200).json(UNKNOWN('model door -> ' + ar.status));

    const ad = await ar.json();
    // The usage block is already in this response and was being discarded.
    // Reading it costs nothing: no extra call, no extra token, no extra latency.
    const u  = (ad && ad.usage) || null;
    const px = PRICE[MODEL] || null;
    const costUSD = (u && px)
      ? ((u.input_tokens / 1e6) * px.in) + ((u.output_tokens / 1e6) * px.out)
      : null;
    const cacheRead = (u && (u.cache_read_input_tokens || 0)) || 0;
    const text = (ad.content || [])
      .filter((b) => b.type === 'text').map((b) => b.text).join('\n')
      .replace(/```json|```/g, '').trim();

    let out;
    try { out = JSON.parse(text); } catch { return res.status(200).json(UNKNOWN('model returned unparseable JSON')); }

    // TRUST NOTHING THE MODEL SAYS ABOUT PERMISSIONS. fill_allowed is decided
    // HERE, from the level, not read from the response. A prompt-injected page
    // that talks the model into "fill_allowed": true must not be able to make
    // this door hand over her name, address and phone number.
    const level = LEVELS.includes(out.threat_level) ? out.threat_level : 'caution';
    const verdict = {
      threat_level: level,
      reason: String(out.reason || '').slice(0, 240) || 'No specific concerns found.',
      fill_allowed: level === 'safe',
      signals: Array.isArray(out.signals) ? out.signals.slice(0, 6).map(String) : [],
      pool_read: pool.error ? 'failed' : (pool.known ? 'domain known' : 'domain never seen'),
      degraded: !!pool.error,
    };

    // -----------------------------------------------------------------------
    // ONE MORE LINE IN THE WINDOW THAT IS ALREADY OPEN.
    let reviewState = 'not attempted';
    //
    // Steven, Aug 2 2026: "Orange dot. Want to know more? Tap. It goes and looks.
    // It comes back and says: people have a hard time getting their money out."
    //
    // CACHE READ ONLY. If the sentence is not ready, the panel does not have that
    // line -- it never shows a spinner and it never makes anyone wait, because the
    // person is standing there with a card in their hand. The gather that fills
    // the cache for the NEXT visitor is fire-and-forget below.
    //
    // IT CANNOT MOVE THE DOT. verdict.threat_level is already decided above and
    // nothing here reads it or changes it. The day this starts producing a grade,
    // Guardian has become a blocklist with extra steps.
    // -----------------------------------------------------------------------
    try {
      const db = await getDb();
      const found = await Promise.race([
        reviews.reviewLine(db, domain),
        new Promise((r) => setTimeout(() => r(null), 900)),
      ]);
      if (found && found.line) {
        verdict.what_people_say = found.line;
        verdict.what_people_say_sources = found.sources;
        reviewState = 'line ready';
      } else if (!(await Promise.race([
                 reviews.alreadyLooked(db, domain),
                 // A HANGING CACHE MUST NOT HANG A PAGE LOAD. On timeout assume it
                 // HAS been looked at -- the cost of skipping a gather is one missing
                 // line; the cost of assuming otherwise is a spend loop.
                 new Promise((r) => setTimeout(() => r(true), 900)),
               ]))) {
        // Nobody has looked at this domain recently. Go look, for whoever lands
        // here next -- never for the person waiting on this response.
        reviewState = 'gather fired';
        reviews.gather(db, domain).then((g) => {
          if (!g) return;
          // EVERY OUTCOME IS WRITTEN DOWN, NOT ONLY THE GOOD ONE.
          //
          // First version wrote a record only when a line was found. So a
          // rejected web-search call, an unparseable answer and a domain with
          // genuinely ordinary reviews all looked identical from outside: silence.
          // Aug 2, that cost an hour of not knowing whether the gather had run at
          // all. An organ that can only report success cannot be debugged and
          // cannot be trusted -- the same lesson as ORGAN SILENT and the day-closer.
          const found = !!g.line;
          poolDoor(key, '/api/ingest', {
            content:
              (found ? 'WHAT PEOPLE SAY -- ' : 'WHAT PEOPLE SAY (NOTHING WRITTEN) -- ') + domain + '\n' +
              '  when    : ' + new Date().toISOString() + '\n' +
              '  status  : ' + (g.status || 'unknown') + '\n' +
              (found ? '  line    : ' + g.line + '\n' : '') +
              '  sources : ' + ((g.sources || []).join(' | ') || 'none') + '\n' +
              '  cost    : ' + (g.cost_usd === null || g.cost_usd === undefined ? 'UNMEASURED'
                    : '$' + Number(g.cost_usd).toFixed(6) + '  (' + MODEL + ', with web search)') + '\n' +
              (g.error ? '  error   : ' + g.error + '\n' : '') + '\n' +
              (found
                ? '  [THIS IS WHAT STRANGERS WROTE, NOT A VERDICT. It is the complaint that\n' +
                  '   REPEATED across many separate reviews -- gathered once for this domain and\n' +
                  '   shared, because what customers say about a company is the same for\n' +
                  '   everybody. It did not change the dot and it never can.]'
                : '  [NO LINE WENT INTO THE PANEL. Either nothing repeated across the reviews --\n' +
                  '   which is a good and common answer -- or the gather failed. The status and\n' +
                  '   error above say which. This record exists so the difference is VISIBLE\n' +
                  '   instead of both looking like silence.]'),
            source_type: 'document',
            speaker: 'Guardian',
            metadata: { pipeline: 'reviews', domain, status: g.status || null },
          }, POOL_MS).catch(() => {});
        }).catch(() => {});
      } else {
        // ALREADY LOOKED, AND NO LINE. This is the state that was invisible on
        // Aug 2: a check with no review line and no explanation anywhere, which
        // could mean the reviews were unremarkable, or the gather failed, or the
        // cache was poisoned by a crashed claim. Say WHICH, on the check record
        // itself -- one line, no extra object, always present.
        reviewState = 'already looked, no line';
        try {
          const doc = await db.collection(reviews.COLL).findOne({ _id: domain });
          if (doc) {
            reviewState = 'already looked -- status=' + (doc.status || '?') +
                          ', at=' + (doc.gathered_at ? new Date(doc.gathered_at).toISOString() : '?') +
                          (doc.error ? ', error=' + String(doc.error).slice(0, 160) : '');
          }
        } catch { reviewState = 'already looked, cache unreadable'; }
      }
    } catch (e) { reviewState = 'reviews threw: ' + String((e && e.message) || e).slice(0, 160); }

    // EVERY CHECK GOES IN THE POOL, RAW. Not for the dot -- for the pattern.
    // One warning on one afternoon is noise. The same unfamiliar domain four
    // times in a week, escalating, is the thing nobody in Terry's life could
    // see because nobody had all of it. This record is how the pool becomes
    // the witness instead of just the filter. Fire-and-forget: a logging
    // failure must never change a verdict.
    poolDoor(key, '/api/ingest', {
      content:
        'GUARDIAN CHECK -- ' + (domain || page.url) + '\n' +
        '  when    : ' + new Date().toISOString() + '\n' +
        '  level   : ' + verdict.threat_level + '\n' +
        '  url     : ' + String(page.url).slice(0, 300) + '\n' +
        '  title   : ' + String(page.title || '').slice(0, 200) + '\n' +
        '  asks    : ' + ((page.fields || []).slice(0, 20).join(', ') || 'nothing') +
        (page.has_password ? ' [PASSWORD]' : '') + (page.has_payment ? ' [PAYMENT]' : '') + '\n' +
        '  pool    : ' + verdict.pool_read + '\n' +
        '  reason  : ' + verdict.reason + '\n' +
        '  signals : ' + (verdict.signals.join(' | ') || 'none') + '\n' +
        '  fill    : ' + (verdict.fill_allowed ? 'ALLOWED' : 'REFUSED') + '\n' +
        '  reviews : ' + reviewState + '\n' +
        '  cost    : ' + (costUSD === null
            ? 'UNMEASURED -- the model returned no usage block'
            : '$' + costUSD.toFixed(6) + '  (' + MODEL + ', in ' + u.input_tokens +
              ' tok, out ' + u.output_tokens + ' tok' +
              (cacheRead ? ', cached ' + cacheRead : '') + ')') + '\n\n' +
        '  [A GUARDIAN CHECK IS NOT AN ACCUSATION AND NOT A BLOCK. Nothing was prevented and\n' +
        '   nothing was sent anywhere. It is one look at one page, kept raw so that a PATTERN\n' +
        '   across weeks can be seen later -- which is the only thing a blocklist cannot do.]',
      source_type: 'document',
      speaker: 'Guardian',
      metadata: {
        pipeline: 'guardian', domain, level: verdict.threat_level,
        fill_allowed: verdict.fill_allowed, degraded: verdict.degraded,
      },
    }, POOL_MS).catch(() => {});

    return res.status(200).json(verdict);
  } catch (e) {
    // A CRASH MUST NOT BE A GREEN DOT.
    return res.status(200).json(UNKNOWN(String((e && e.message) || e)));
  }
};
