// /v1/read -- STCKY thin-wrapper read endpoint
// =============================================
// Stable-door read door. Public contract: path /v1/read, mode values,
// response field names. Everything else is room (free to refactor).
//
// Routes via vercel.json:
//   { "src": "/v1/read", "dest": "/v1-read.js" }
//
// Companion spec: design-note/v1-read-thin-wrapper-spec-2026-05-11
//
// PATCHED 2026-05-16 (Eli): mode=semantic uses shared _lib/hybrid-search
// primitive. Closes finding/semantic-search-fails-on-slug-syntax-queries-
// 2026-05-16. Composes with principle/fix-it-right-no-patches-forward-
// thinking-2026-05-16.
//
// PATCHED 2026-05-16 v2 (Eli): searchHybrid now takes a scope object (e.g.
// { userId } or { projectId }) instead of a user object. One-line caller
// change here; primitive becomes reusable for project-scoped search too.

const { getDb, auth, cors } = require('./_lib/auth');
const { searchHybrid } = require('./_lib/hybrid-search');
const { HEAD_CHARS } = require('./_lib/objects');

// ============ NOW ============
function nowISO() {
  return new Date().toISOString();
}
function nowHuman(user) {
  // Each user's clock is their own: read the timezone captured at signup.
  // Fall back to UTC (honestly labeled) only when we genuinely don't know -
  // never silently default everyone to one zone.
  const tz = (user && typeof user.timezone === 'string' && user.timezone) || 'UTC';
  const opts = {
    timeZone: tz,
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
    hour12: true,
  };
  return `${new Date().toLocaleString('en-US', opts)} (${tz})`;
}

// ============ RESPONSE SHAPING ============
function trimMemory(m) {
  return {
    _id: m._id,
    category: m.category,
    key: m.key,
    value: m.value,
    tags: m.tags || '',
    domain: m.domain || null,
    source: m.source || '',
    relevantDate: m.relevantDate || null,
    anchor: m.anchor === true,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    version_count: m.version_count || 1,
  };
}

function trimObject(o) {
  return {
    _id: o._id,
    content: o.content,
    speaker: o.speaker,
    source_type: o.source_type,
    source: o.source,
    timestamp: o.timestamp || o.client_timestamp,
    ingested_at: o.ingested_at,
    session_id: o.session_id,
    tool_name: o.metadata && o.metadata.tool_name,
    event_type: o.metadata && o.metadata.event_type,
  };
}

// ============ MODE: NOW ============
async function fanOutNow(db, user, hours, limit, include, anchor, before, maxWindowDays, sourceType) {
  const hoursNum = Math.max(1, Math.min(parseInt(hours) || 24, 168));
  const limitNum = Math.max(1, Math.min(parseInt(limit) || 30, 200));
  // THE REAL CLAMP (found Aug 1 2026). This is what bounds mode:'now' -- the
  // 24*90 on line ~346 is the COUNT path and was never the thing hiding history.
  // Default stays 90 so nothing that works today changes; the CEILING goes to 3
  // years so a caller who asks can actually look back. A door that silently
  // narrows a request and returns a confident empty page manufactures absence.
  const maxDays = Math.max(1, Math.min(parseInt(maxWindowDays) || 90, 1095));

  const upperBound = before ? new Date(before) : (anchor ? new Date(anchor) : new Date());

  const earliestAllowed = new Date(Date.now() - maxDays * 24 * 60 * 60 * 1000);
  let lowerBound = new Date(upperBound.getTime() - hoursNum * 60 * 60 * 1000);
  let exhaustedWindow = false;
  if (lowerBound < earliestAllowed) {
    lowerBound = earliestAllowed;
    exhaustedWindow = true;
  }

  const upperOp = before ? '$lt' : '$lte';

  const inc = {
    curated: include.curated !== false,
    raw: include.raw !== false,
    events: include.events === true,
  };

  const [memoryDocs, objectDocs] = await Promise.all([
    inc.curated
      ? db.collection('memories')
          .find({ userId: user._id, updatedAt: { $gte: lowerBound, [upperOp]: upperBound } })
          .sort({ updatedAt: -1 })
          .limit(limitNum)
          .toArray()
      : Promise.resolve([]),
    inc.raw
      ? db.collection('objects')
          .find({
            userId: user._id,
            ingested_at: { $gte: lowerBound, [upperOp]: upperBound },
            // FILTER AT THE DOOR, NOT IN THE CALLER. Added Aug 7 2026, Eli.
            //
            // pulse.html asked for the 6 newest objects and then filtered them
            // for source_type 'conversation' in the browser. All six came back
            // machine records -- heartbeats, SENT receipts -- so the card read
            // "no turns in 24h" beside its own exact count of 59. A filter
            // applied AFTER a limit is not a filter, it is a coin toss.
            //
            // The alternative was to ask for sixty objects and throw away
            // fifty-four whole bodies, which is the disease this page was just
            // cured of. Served by userId_1_source_type_1_ingested_at_-1.
            ...(sourceType ? { source_type: String(sourceType) } : {}),
            ...(inc.events ? {} : { 'metadata.event_type': { $ne: 'tool_event' } }),
          })
          .sort({ ingested_at: -1 })
          .limit(limitNum)
          .toArray()
      : Promise.resolve([]),
  ]);

  const merged = [
    ...memoryDocs.map(m => ({ kind: 'memory', ts: m.updatedAt, doc: m })),
    ...objectDocs.map(o => ({ kind: 'object', ts: o.ingested_at, doc: o })),
  ].sort((a, b) => b.ts - a.ts).slice(0, limitNum);

  const cursor = merged.length > 0 ? merged[merged.length - 1].ts.toISOString() : null;

  return {
    memories: merged.filter(x => x.kind === 'memory').map(x => trimMemory(x.doc)),
    objects: merged.filter(x => x.kind === 'object').map(x => trimObject(x.doc)),
    window: { from: lowerBound.toISOString(), to: upperBound.toISOString(), hours: hoursNum, max_window_days: maxDays },
    cursor,
    exhausted_window: exhaustedWindow,
    limit_effective: limitNum,
  };
}

// ============ MODE: SEMANTIC ============
async function semantic(db, user, query, limit, include) {
  const limitNum = Math.max(1, Math.min(parseInt(limit) || 10, 50));

  const inc = {
    curated: include.curated !== false,
    raw: include.raw !== false,
  };

  const result = await searchHybrid(db, { userId: user._id }, query, {
    limit: limitNum,
    includeMemories: inc.curated,
    includeObjects:  inc.raw,
    now: new Date(),
  });

  return {
    memories: result.memories.map(trimMemory),
    objects:  result.objects.map(trimObject),
    searchMethod: result.searchMethod,
  };
}

// ============ MODE: REGION -- THE STRING THAT PULLS THE PAST INTO NOW ============
// Steven, Jul 14 2026, 6:00 AM, naming the architecture better than the architect:
//   "NOW and what's around NOW is what's most important... when we're doing things
//    now, they're called something from the past, from before now, it brings it
//    closer to now so it's not having to search for everything... Those are
//    connected by strings."
//
// WHY THIS EXISTS: the LLM superpower is ATTENTION, and attention only reaches
// what is IN THE WINDOW. Semantic search returns a HIT -- a point. A point has to
// be followed up: fetch the object, fetch its neighbours, re-query with better
// words. That is ten round trips and a pile of crumbs. It is librarian work, and
// it is exactly the grind STCKY was built to abolish.
//
// A STRING DOES NOT RETURN A POINT. IT DRAGS A REGION FORWARD, WHOLE.
// Search locates; then we load the NEIGHBOURHOOD around each hit -- every object
// within +/- radius_min, full bodies, no previews -- and hand back one merged,
// time-ordered slab. Once it is in the window it is not "the past" any more: it
// is context, live, sitting next to today's problem where attention can collide
// the two. That collision is the thing a database can never do and a pool does
// for free.
//
// ONE CALL. WHOLE BODIES. NO ELLIPSES. NO SECOND TRIP.
async function region(db, user, query, opts) {
  const hits      = Math.max(1, Math.min(parseInt(opts.hits) || 5, 20));
  const radiusMin = Math.max(1, Math.min(parseInt(opts.radius_min) || 45, 720));
  const capObjs   = Math.max(1, Math.min(parseInt(opts.limit) || 120, 400));
  const inc = { curated: opts.include.curated !== false, raw: opts.include.raw !== false };

  // 1. LOCATE. Search is a pointer, not a reading.
  const found = await searchHybrid(db, { userId: user._id }, query, {
    limit: hits,
    includeMemories: inc.curated,
    includeObjects: true,          // objects carry the timestamps the strings hang from
    now: new Date(),
  });

  // 2. PULL. Every hit becomes a WINDOW around itself, and the windows merge.
  const anchors = [];
  for (const o of (found.objects || [])) {
    const t = new Date(o.ingested_at || o.timestamp);
    if (!isNaN(t)) anchors.push({ t, why: 'object', id: String(o._id) });
  }
  for (const m of (found.memories || [])) {
    const t = new Date(m.updatedAt || m.createdAt);
    if (!isNaN(t)) anchors.push({ t, why: 'memory:' + m.category + '/' + m.key, id: String(m._id) });
  }

  if (!anchors.length) {
    // HONEST EMPTY. Not "it isn't there" -- "this query found no anchor."
    return {
      memories: (found.memories || []).map(trimMemory),
      objects: [],
      regions: [],
      note: 'NO ANCHOR FOUND FOR THIS QUERY. This is a fact about the QUERY, not about the pool. ' +
            'Try the user\'s own words for the thing, a bare token, or a literal value before concluding absence.',
    };
  }

  // Merge overlapping windows so an important hour is loaded once, not five times.
  const R = radiusMin * 60 * 1000;
  const spans = anchors
    .map(a => ({ from: new Date(a.t.getTime() - R), to: new Date(a.t.getTime() + R), why: [a.why] }))
    .sort((a, b) => a.from - b.from);
  const merged = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.from <= last.to) {
      if (s.to > last.to) last.to = s.to;
      last.why.push(...s.why);
    } else {
      merged.push({ from: s.from, to: s.to, why: [...s.why] });
    }
  }

  // 3. LOAD WHOLE. Every object in every window, full body. This is the payload
  //    attention actually reads. RAW MEANS RAW -- at the write AND at the read.
  const objectDocs = await db.collection('objects')
    .find({
      userId: user._id,
      $or: merged.map(w => ({ ingested_at: { $gte: w.from, $lte: w.to } })),
      ...(opts.include.events === true ? {} : { 'metadata.event_type': { $ne: 'tool_event' } }),
    })
    .sort({ ingested_at: -1 })
    .limit(capObjs)
    .toArray();

  const memoryDocs = inc.curated
    ? await db.collection('memories')
        .find({
          userId: user._id,
          $or: merged.map(w => ({ updatedAt: { $gte: w.from, $lte: w.to } })),
        })
        .sort({ updatedAt: -1 })
        .limit(capObjs)
        .toArray()
    : [];

  // Union the direct hits back in -- a hit outside every window (older than the
  // cap allowed) must never be dropped just because its neighbourhood was busy.
  const byId = new Map(objectDocs.map(o => [String(o._id), o]));
  for (const o of (found.objects || [])) if (!byId.has(String(o._id))) byId.set(String(o._id), o);
  const memById = new Map(memoryDocs.map(m => [String(m._id), m]));
  for (const m of (found.memories || [])) if (!memById.has(String(m._id))) memById.set(String(m._id), m);

  const objs = [...byId.values()].sort(
    (a, b) => new Date(b.ingested_at || b.timestamp) - new Date(a.ingested_at || a.timestamp)
  );
  const mems = [...memById.values()].sort(
    (a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt)
  );

  return {
    memories: mems.map(trimMemory),
    objects: objs.map(trimObject),
    regions: merged.map(w => ({
      from: w.from.toISOString(),
      to: w.to.toISOString(),
      pulled_by: Array.from(new Set(w.why)),
    })),
    searchMethod: found.searchMethod,
    radius_min: radiusMin,
  };
}

// ============ MODE: COUNT -- ASK THE DATABASE TO COUNT, NEVER THE RANKER ============
// Added Jul 21 2026, after the ops board was caught reporting 83 SENT THIS WEEK
// on a Tuesday when a single lane had sent 81 on Monday alone.
//
// HOW THE LIE GOT TOLD: growbotik-status asked /api/associative for each kind of
// ledger record and counted what came back. That door is a RELEVANCE SEARCH. It
// returns the best matches it can reach at its recall depth, ranked, and its
// ranker weights recency -- so it handed back today's sends and stopped. Nothing
// hit a stated ceiling, so the gauge believed it had the whole week.
//
// Measured with the new walk, one lane, one query, walked to the bottom:
//     Jul 14  36    Jul 17  81    Jul 20  81
//     Jul 15   6    Jul 18  28    Jul 21  88
//     Jul 16  41    Jul 19  44    -- 406 records on ONE lane
// The board, reading the same pool, said 83 for all three lanes for seven days.
//
// THE CATEGORY ERROR, NAMED IN THIS POOL ON MAY 6 AND NOT ACTED ON UNTIL NOW:
// "how many are there" is a STRUCTURAL question and belongs to the database.
// "what is this about" is an ASSOCIATIVE question and belongs to the search.
// Counting with a ranker is like measuring a room with a metaphor -- it will
// always return something, and the something will always be too small.
//
// So this mode does not rank, does not embed, does not paginate and cannot be
// truncated. It asks Mongo to count documents in a time window whose content
// starts with a literal prefix, and returns the number. There is no ceiling to
// hit and therefore no floor to disclaim: a count from here is a TOTAL.
async function countBuckets(db, user, body) {
  // =========================================================================
  // THE CAP IS REAL AND IT MUST SAY SO. Fixed Jul 27 2026.
  //
  // This line was `body.buckets.slice(0, 24)` and nothing downstream mentioned
  // it. Asked for 31 buckets, the door answered 24 and returned a door_notice
  // reading: "Nothing here was ranked, embedded, paginated or truncated, so
  // there is no ceiling to hit and no undercount to disclaim."
  //
  // THAT IS THE ONE SENTENCE THIS DOOR EXISTS TO BE ABLE TO SAY, AND IT WAS
  // FALSE. Every organ was told to trust count mode over the search door
  // precisely because count cannot be truncated. A caller checking 30 addresses
  // for prior contact would have been handed 24 answers and a written guarantee
  // that all 30 were covered -- and the six it never asked about would have
  // read as clean. That is a duplicate email to a real person, produced by a
  // door's own reassurance.
  //
  // Found Jul 27 while building the feeder's prior-contact gate: asked 31, got
  // 24, no warning. Two separate callers now carry hand-written truncation
  // guards that compare returned bucket count against asked bucket count. Those
  // guards are correct and should stay -- but they exist because THIS line lied,
  // and a guard in every caller is the wrong place to fix a door.
  //
  // The cap stays (24 concurrent unindexed scans is already the practical
  // limit). What changes is that the answer now tells the truth about itself.
  // =========================================================================
  const BUCKET_CAP = 24;
  const bucketsAsked = Array.isArray(body.buckets) ? body.buckets.length : 0;
  const buckets = Array.isArray(body.buckets) ? body.buckets.slice(0, BUCKET_CAP) : [];
  const bucketsTruncated = bucketsAsked > buckets.length;
  if (!buckets.length) {
    return { counts: {}, error: 'count mode requires buckets: [{name, prefix}]' };
  }

  const now = new Date();
  const since = body.since ? new Date(body.since)
    : new Date(now.getTime() - Math.max(1, Math.min(parseInt(body.hours) || 168, 24 * 1095)) * 3600e3);
  const until = body.until ? new Date(body.until) : now;
  if (isNaN(since.getTime()) || isNaN(until.getTime())) {
    return { counts: {}, error: 'count mode: since/until must be valid ISO timestamps' };
  }

  const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const window = { $gte: since, $lte: until };

  // =========================================================================
  // ASK THE INDEX, NOT THE WHOLE POOL. Jul 28 2026.
  //
  // This match was `content: { $regex: '^' + esc(prefix) }`. `content` carries
  // entire email bodies and has no index, so answering "does a record start
  // with SENT -- greg@example.com" required reading every document this user
  // owns. The drip issues SEVEN of these per address and gave each 15 seconds;
  // it was timing out on the FIRST one and skipping the man entirely. Nine
  // hours of "database confirmation failed" against a pool that knew the
  // answer perfectly well.
  //
  // Objects now carry `head` -- the first 200 characters -- with an index on
  // { userId, head, ingested_at }. A case-sensitive ^-anchored regex on an
  // indexed field is a RANGE SCAN over index keys, so the same question is now
  // answered without opening a single body.
  //
  // THE $or IS NOT OPTIONAL AND MUST NOT BE "CLEANED UP" LATER. Records written
  // before Jul 28 2026 have no `head` until the backfill has run over all of
  // them. A document missing `head` would silently fail the fast path, and a
  // MISSING COUNT HERE READS AS ZERO PRIOR CONTACT -- which is how a man who
  // already said no gets mailed again. So the old path stays live for exactly
  // those documents: { head: null } is itself an indexed lookup, so this costs
  // almost nothing once the backfill is done, and it is CORRECT during it.
  // Remove the branch only after verifying zero objects lack `head`, and even
  // then there is no prize for removing it.
  //
  // A prefix longer than the head cannot be answered from the head. Rather than
  // truncate the question -- which would silently widen it and overcount -- such
  // a bucket falls back to the full content scan. Slow and right beats fast and
  // wrong at this door, every time.
  // =========================================================================
  const matchFor = (prefix) => {
    const rx = { $regex: '^' + esc(prefix) };
    if (String(prefix).length > HEAD_CHARS) {
      return { match: { userId: user._id, ingested_at: window, content: rx }, path: 'content_scan' };
    }
    return {
      match: {
        userId: user._id,
        ingested_at: window,
        $or: [
          { head: rx },                        // indexed range scan
          { head: null, content: rx },         // pre-backfill records only
        ],
      },
      path: 'head_index',
    };
  };

  // =========================================================================
  // BUCKETS BY SOURCE_TYPE, AND BUCKETS OF EVERYTHING. Added Aug 7 2026, Eli.
  //
  // WHY: this door could only be asked "how many records START WITH this
  // literal string." That is exactly right for the ledger, where every record
  // is written by a machine with a fixed head -- SENT --, QUEUED --, BOUNCE --.
  // It is useless for CONVERSATION TURNS, which are whatever Steven or I
  // happened to say and have no prefix at all.
  //
  // So pulse.html -- the page whose entire job is to prove capture is alive --
  // could not use this door and counted by walking instead: up to 60 paged
  // reads of /v1/read mode=now per refresh, once a minute, pulling ~1,799 whole
  // object bodies (~73 MB at the pool's 41.9 kB average) to display four
  // numbers. Measured Aug 7 2026: ~103 GB a day and ~86,400 requests a day per
  // open tab, and its own footer had to print a "+" because a walk can only
  // ever report a floor.
  //
  // A bucket may now say `source_type` instead of `prefix`, served by the
  // existing userId_1_source_type_1_ingested_at_-1 index, or say `all: true`
  // for every object in the window.  Both are exact totals.
  //
  // STRICTLY ADDITIVE. A bucket carrying `prefix` behaves byte-identically to
  // before, so growbotik-status and the drip's prior-contact checks are
  // untouched. Only a bucket that asks the new way takes the new path.
  // =========================================================================
  const matchForSourceType = (sourceType) => ({
    match: { userId: user._id, ingested_at: window, source_type: String(sourceType) },
    path: 'source_type_index',
  });

  const matchForAll = () => ({
    match: { userId: user._id, ingested_at: window },
    path: 'window_index',
  });

  const counts = {};
  const newest = {};
  const perDay = {};
  const distinct = {};
  const paths = {};

  await Promise.all(buckets.map(async (b) => {
    const name = String(b && b.name || '').slice(0, 60);
    const prefix = String(b && b.prefix || '');
    const sourceType = String(b && b.source_type || '');
    const wantsAll = !!(b && b.all);
    if (!name) return;
    if (!prefix && !sourceType && !wantsAll) return;

    const built = prefix ? matchFor(prefix)
                : sourceType ? matchForSourceType(sourceType)
                : matchForAll();
    const match = built.match;
    paths[name] = built.path;

    counts[name] = await db.collection('objects').countDocuments(match);

    // NEWEST, AS A FACT. Added Aug 7 2026, Eli.
    //
    // WHY: growbotik-status computed every number from this door EXCEPT one --
    // the timestamp of the most recent send -- which it still took from the
    // relevance walk, on the stated reasoning that "recency is the one axis the
    // ranker never misses." On Aug 7 at 4:39 AM that board showed SENT TODAY 18
    // and 18 IN THE LAST HOUR beside LAST SEND 2d AGO. The counts were right and
    // the walk-derived timestamp was two days stale, on the same card, in the
    // same second.
    //
    // The ranker had not missed recency because of a bug. objectsKeywordSearch
    // applies .limit() with NO .sort(), so WHICH matching documents come back is
    // whatever the chosen query plan yields first -- an arbitrary slice that only
    // LOOKED recency-ordered. Creating an index invalidates a collection's plan
    // cache, so the two indexes built that morning reshuffled the arbitrary and
    // the assumption fell over. It was never true; it was lucky.
    //
    // This is the same file's oldest lesson applied one last time: NUMBERS FROM
    // FACTS, NOT FROM A SEARCH. Sorted on ingested_at, served by the existing
    // userId_head_ingested_at index, one document, no ranking and no ceiling.
    const newestDoc = await db.collection('objects')
      .find(match, { projection: { ingested_at: 1, timestamp: 1, head: 1 } })
      .sort({ ingested_at: -1 })
      .limit(1)
      .next();
    newest[name] = newestDoc
      ? {
          ingested_at: newestDoc.ingested_at || null,
          timestamp: newestDoc.timestamp || newestDoc.ingested_at || null,
          head: newestDoc.head ? String(newestDoc.head).slice(0, 120) : null,
        }
      : null;

    // DISTINCT VALUES PULLED OUT OF THE BODY. Added minutes after count mode,
    // because the first thing it measured raised a question it could not answer.
    //
    // The window showed 656 BOUNCE records against 629 sends. That reads like
    // catastrophe -- and it is NOT a bounce rate, because the inbox sweep files
    // the same DSN more than once and one dead address can produce dozens of
    // records. COUNTING RECORDS DESCRIBES OUR PAPERWORK. COUNTING ADDRESSES
    // DESCRIBES THE WORLD. The board learned that on Jul 18 and it cost Steven a
    // day of sending on a number that was 2.5x too high.
    //
    // The safety question -- what fraction of real people we mailed do not exist
    // -- can only be answered by DISTINCT ADDRESS, and the address lives inside
    // the record text, so no plain count can reach it. This does it in the
    // database with $regexFind: pull the capture out of every matching document,
    // group by it, return how many distinct values there are and the top few.
    // Still no ranking, no pagination, no ceiling. Still a total.
    if (b && b.extract) {
      const pattern = String(b.extract).slice(0, 300);
      const rows = await db.collection('objects').aggregate([
        { $match: match },
        { $project: { hit: { $regexFind: { input: '$content', regex: pattern, options: 'i' } } } },
        { $match: { hit: { $ne: null } } },
        { $project: { v: { $toLower: { $arrayElemAt: ['$hit.captures', 0] } } } },
        { $match: { v: { $ne: null } } },
        { $group: { _id: '$v', n: { $sum: 1 } } },
        { $sort: { n: -1 } },
      ]).toArray();
      distinct[name] = {
        distinct_values: rows.length,
        records_matched: rows.reduce((a, r) => a + r.n, 0),
        duplicate_records: rows.reduce((a, r) => a + r.n, 0) - rows.length,
        top: rows.slice(0, 10).map(r => ({ value: r._id, records: r.n })),
      };
    }

    // DISTINCT BY A REAL FIELD, not by a regex over the body. Aug 7 2026, Eli.
    //
    // `extract` above pulls a capture out of `content` because the ledger keeps
    // the address INSIDE the record text. But `speaker` is an actual field on
    // every object, and pulse.html was tallying it in JavaScript over 1,799
    // downloaded bodies to render one line: "Eli 118 . Steven 110 . Chaos 2".
    //
    // Same question, asked of the database, over the same indexed match.
    if (b && b.distinct_field) {
      const field = String(b.distinct_field).replace(/[^A-Za-z0-9_.]/g, '').slice(0, 60);
      if (field) {
        const rows = await db.collection('objects').aggregate([
          { $match: match },
          { $group: { _id: '$' + field, n: { $sum: 1 } } },
          { $sort: { n: -1 } },
        ]).toArray();
        distinct[name] = {
          field,
          distinct_values: rows.length,
          records_matched: rows.reduce((a, r) => a + r.n, 0),
          top: rows.slice(0, 10).map(r => ({ value: r._id, records: r.n })),
        };
      }
    }

    if (body.group_by_day) {
      // Bucketed in the caller's own zone, so "Monday" means Monday where Steven
      // is standing -- the same law the pacer and the board already follow.
      const tz = (user && user.timezone) || 'America/Los_Angeles';
      const rows = await db.collection('objects').aggregate([
        { $match: match },
        { $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$ingested_at', timezone: tz } },
            n: { $sum: 1 },
        } },
        { $sort: { _id: 1 } },
      ]).toArray();
      perDay[name] = rows.reduce((a, r) => (a[r._id] = r.n, a), {});
    }
  }));

  return {
    counts,
    per_day: body.group_by_day ? perDay : undefined,
    newest: Object.keys(newest).length ? newest : undefined,
    distinct: Object.keys(distinct).length ? distinct : undefined,
    scanned_by: paths,
    window: { from: since.toISOString(), to: until.toISOString() },
  };
}

// ============ MODE: EXISTS -- A LITERAL YES OR NO ============
// Added Jul 21 2026, after measuring 656 bounce records that were 39 real
// emails, and 106 reply records that were 13. A 17x duplication, invisible for
// weeks because duplicates look exactly like activity.
//
// THE CAUSE: inbox-sweep asks "have I already filed this Message-ID?" and asked
// it of the SEARCH door. A Message-ID is a meaningless string to an embedder and
// a single unsplittable token to a keyword ranker, so the search often could not
// find a record that was sitting right there -- and the caller's failure default
// was `return false`, which means WRITE IT AGAIN. Every uncertain answer became
// another copy, every ten minutes, forever.
//
// A YES/NO QUESTION MUST NEVER BE ASKED OF A RANKER. "Is this exact string in
// the pool" is structural, like counting -- it belongs to the database, where
// the answer is a fact rather than a best effort. Same category error as the ops
// board counting sends with a relevance search, one layer down.
//
// So: one indexed-ish literal lookup, limit 1, no ranking, no window, no
// embedding. It cannot half-succeed and it cannot be truncated.
async function existsLiteral(db, user, needle) {
  const s = String(needle || '').trim();
  if (!s) return { error: 'exists mode requires needle' };
  if (s.length > 400) return { error: 'exists mode: needle too long (max 400 chars)' };

  const esc = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const doc = await db.collection('objects').findOne(
    { userId: user._id, content: { $regex: esc } },
    { projection: { _id: 1, ingested_at: 1 } }
  );

  return {
    needle: s,
    found: !!doc,
    first_match: doc ? { _id: doc._id, ingested_at: doc.ingested_at } : null,
  };
}

// ============ MODE: CATEGORY_KEY ============
async function byCategoryKey(db, user, category, key) {
  const memory = await db.collection('memories').findOne({
    userId: user._id,
    category,
    key,
  });
  return {
    memories: memory ? [trimMemory(memory)] : [],
    objects: [],
  };
}

// ============ MODE: THREAD ============
async function byThread(db, user, thread, limit) {
  const limitNum = Math.max(1, Math.min(parseInt(limit) || 50, 200));

  const escaped = thread.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rx = new RegExp(`(^|,)\\s*${escaped}\\s*(,|$)`, 'i');

  const memoryDocs = await db.collection('memories')
    .find({ userId: user._id, tags: { $regex: rx } })
    .sort({ updatedAt: -1 })
    .limit(limitNum)
    .toArray();

  return {
    memories: memoryDocs.map(trimMemory),
    objects: [],
  };
}

// ============ MODE: RAW_RECENT ============
async function rawRecent(db, user, hours, limit, include, anchor, before, maxWindowDays) {
  const hoursNum = Math.max(1, Math.min(parseInt(hours) || 24, 168));
  const limitNum = Math.max(1, Math.min(parseInt(limit) || 30, 200));
  // THE REAL CLAMP (found Aug 1 2026). This is what bounds mode:'now' -- the
  // 24*90 on line ~346 is the COUNT path and was never the thing hiding history.
  // Default stays 90 so nothing that works today changes; the CEILING goes to 3
  // years so a caller who asks can actually look back. A door that silently
  // narrows a request and returns a confident empty page manufactures absence.
  const maxDays = Math.max(1, Math.min(parseInt(maxWindowDays) || 90, 1095));

  const upperBound = before ? new Date(before) : (anchor ? new Date(anchor) : new Date());
  const earliestAllowed = new Date(Date.now() - maxDays * 24 * 60 * 60 * 1000);
  let lowerBound = new Date(upperBound.getTime() - hoursNum * 60 * 60 * 1000);
  let exhaustedWindow = false;
  if (lowerBound < earliestAllowed) {
    lowerBound = earliestAllowed;
    exhaustedWindow = true;
  }
  const upperOp = before ? '$lt' : '$lte';

  const inc = { events: include.events === true };

  const objectDocs = await db.collection('objects')
    .find({
      userId: user._id,
      ingested_at: { $gte: lowerBound, [upperOp]: upperBound },
      ...(inc.events ? {} : { 'metadata.event_type': { $ne: 'tool_event' } }),
    })
    .sort({ ingested_at: -1 })
    .limit(limitNum)
    .toArray();

  const cursor = objectDocs.length > 0 ? objectDocs[objectDocs.length - 1].ingested_at.toISOString() : null;

  return {
    memories: [],
    objects: objectDocs.map(trimObject),
    window: { from: lowerBound.toISOString(), to: upperBound.toISOString(), hours: hoursNum, max_window_days: maxDays },
    cursor,
    exhausted_window: exhaustedWindow,
    limit_effective: limitNum,
  };
}

// ============ MAIN HANDLER ============
module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  const user = await auth(req);
  // THE WALL (Aug 1 2026). A scoped key cannot reach pool content -- see _lib/wall.js.
  if (require('./_lib/wall').wall(req, res, user, '/v1/read')) return;
  if (!user) {
    console.log('[V1/READ AUTH] Failed - no user found for token');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const db = await getDb();

  await db.collection('users').updateOne(
    { _id: user._id },
    { $set: { lastSeen: new Date() } }
  );

  const body = req.body || {};
  const {
    mode = 'now',
    query,
    category,
    key,
    thread,
    hours = 24,
    limit,
    include = {},
    anchor,
    before,
    cursor,
    max_window_days,
    source_type,
  } = body;

  // =======================================================================
  // PAGE WITH THE NAME WE HANDED YOU. Fixed Jul 25 2026, ~5:40 AM.
  //
  // This door returns its paging value in a field called `cursor` and, until
  // this line existed, accepted it back only as `before`. So every caller that
  // read the response, saw `cursor`, and passed `cursor` back got the IDENTICAL
  // page forever -- and then concluded the pool ended there.
  //
  // That one name mismatch is the shared root of three bugs filed as separate:
  //   - PULSE reporting NOT CAPTURING against a pool that was capturing fine,
  //     because it read one page, saw no conversation turns in the last 80
  //     minutes of a machine writing 22 objects an hour, and called it 24h.
  //   - growbotik-status reporting SENT TODAY 4 on a day with 7 sends.
  //   - drip-stager re-staging touch 1 to addresses already mailed, and the
  //     send door then refusing their touch 2 for having no prior touch.
  //
  // The door that warns every caller never to conclude absence from a window
  // was itself making the window impossible to escape. A door does not get to
  // blame the reader for a handle that turns only when held by a secret name.
  // =======================================================================
  const beforeArg = before || cursor;

  try {
    let result;
    switch (mode) {
      case 'now':
        result = await fanOutNow(db, user, hours, limit, include, anchor, beforeArg, max_window_days, source_type);
        break;
      case 'semantic':
        if (!query) {
          return res.status(400).json({ error: 'semantic mode requires query' });
        }
        result = await semantic(db, user, query, limit, include);
        break;
      case 'region':
        // THE STRING. Locate by meaning, then pull the whole neighbourhood forward
        // into NOW. One call, whole bodies, no second trip.
        if (!query) {
          return res.status(400).json({ error: 'region mode requires query' });
        }
        result = await region(db, user, query, {
          hits: body.hits,
          radius_min: body.radius_min,
          limit,
          include,
        });
        break;
      case 'count': {
        result = await countBuckets(db, user, body);
        if (result.error) return res.status(400).json({ error: result.error });
        // THE NOTICE MUST MATCH WHAT THE DOOR DID. See the cap note in
        // countBuckets: this response used to promise "nothing was truncated"
        // while silently serving only the first 24 buckets asked for.
        const bucketsAsked = Array.isArray(body.buckets) ? body.buckets.length : 0;
        const bucketsAnswered = Object.keys(result.counts || {}).length;
        const truncated = bucketsAsked > bucketsAnswered;
        return res.status(200).json({
          now_iso: nowISO(),
          now_human: nowHuman(user),
          mode: 'count',
          counts: result.counts,
          ...(result.newest ? { newest: result.newest } : {}),
          ...(result.per_day ? { per_day: result.per_day } : {}),
          ...(result.distinct ? { distinct: result.distinct } : {}),
          ...(result.scanned_by ? { scanned_by: result.scanned_by } : {}),
          window: result.window,
          buckets_asked: bucketsAsked,
          buckets_answered: bucketsAnswered,
          buckets_truncated: truncated,
          door_notice: {
            door: 'v1/read',
            answers: 'HOW MANY EXIST IN THIS WINDOW -- an exact total.',
            this_is_a_window: false,
            counted_by: 'database countDocuments over a literal content prefix',
            reads: 'indexed prefix range scan on `head` (first ' + HEAD_CHARS + ' chars of the ' +
                   'record), with a fallback to the full content scan for any record written ' +
                   'before the head backfill and for any prefix longer than the head. See ' +
                   '`scanned_by` for which path each bucket took. Correctness is identical on ' +
                   'both paths; only the cost differs.',
            bucket_cap: 24,
            read_this: truncated
              ? 'PARTIAL ANSWER. You asked for ' + bucketsAsked + ' buckets and this door serves at ' +
                'most 24 per request, so ' + (bucketsAsked - bucketsAnswered) + ' of them were NOT ' +
                'COUNTED AT ALL. A bucket missing from `counts` is NOT a zero -- it is a question ' +
                'that was never asked. Split the request into batches of 24 or fewer and ask again. ' +
                'The counts that ARE here are exact totals.'
              : 'THESE ARE TOTALS, NOT FLOORS. Every bucket you asked for was counted. Nothing here ' +
                'was ranked, embedded, paginated or truncated, so there is no ceiling to hit and no ' +
                'undercount to disclaim. The only limit is the time window, which is stated above. ' +
                'Use this -- never the search door -- to answer HOW MANY.',
            never_conclude: truncated
              ? 'DO NOT treat an absent bucket as a count of zero. On Jul 27 2026 this door answered ' +
                '24 of 31 buckets and told the caller nothing had been truncated; a prior-contact ' +
                'check reading those seven silences as "never contacted" would have mailed real ' +
                'people a second time.'
              : undefined,
          },
        });
      }
      case 'exists': {
        const ex = await existsLiteral(db, user, body.needle);
        if (ex.error) return res.status(400).json({ error: ex.error });
        return res.status(200).json({
          now_iso: nowISO(),
          mode: 'exists',
          needle: ex.needle,
          found: ex.found,
          first_match: ex.first_match,
          door_notice: {
            door: 'v1/read',
            answers: 'IS THIS EXACT STRING IN THE POOL -- yes or no.',
            this_is_a_window: false,
            matched_by: 'database literal substring lookup, not search',
            read_this:
              'THIS IS A FACT, NOT A BEST EFFORT. No ranking, no embedding, no time window, no ' +
              'ceiling. found:false means the string is genuinely not in the pool. Use this for ' +
              'de-duplication and identity checks -- NEVER the search door, which can fail to ' +
              'find a record that is sitting right there.',
          },
        });
      }
      case 'category_key':
        if (!category || !key) {
          return res.status(400).json({ error: 'category_key mode requires both category and key' });
        }
        result = await byCategoryKey(db, user, category, key);
        break;
      case 'thread':
        if (!thread) {
          return res.status(400).json({ error: 'thread mode requires thread' });
        }
        result = await byThread(db, user, thread, limit);
        break;
      case 'raw_recent':
        result = await rawRecent(db, user, hours, limit, include, anchor, beforeArg, max_window_days);
        break;
      default:
        return res.status(400).json({ error: `unknown mode: ${mode}` });
    }

    const response = {
      now_iso: nowISO(),
      now_human: nowHuman(user),
      mode,
      memories: result.memories,
      objects: result.objects,
      total_memories: result.memories.length,
      total_objects: result.objects.length,
    };
    if (result.window) response.window = result.window;
    if (result.regions) response.regions = result.regions;
    if (result.radius_min) response.radius_min = result.radius_min;
    if (result.note) response.note = result.note;
    if (result.cursor !== undefined) response.cursor = result.cursor;
    if (result.exhausted_window !== undefined) response.exhausted_window = result.exhausted_window;
    if (result.searchMethod) response.searchMethod = result.searchMethod;

    // =======================================================================
    // THIS DOOR IS A WINDOW, AND IT MUST SAY SO. Added Jul 19 2026, ~3:50 AM.
    //
    // Steven: "I think the one door in, one door out should be the walls."
    //
    // He is right, and this file is the reason the wall had holes in it. There
    // is ONE write door (/api/ingest -- marker writes now 410). There should be
    // ONE read door. Instead there are four, and three of them -- this one,
    // /api/memory/list, /api/memory/search -- hand back a WINDOW with nothing
    // in the payload to say a window is what it is.
    //
    // WHAT THIS DOOR ACTUALLY DOES: it returns what is NEAR IN TIME. That is a
    // legitimate question -- "what happened lately" -- and it stays open for
    // exactly that. What it is NOT is a way to see the pool, and it has been
    // used as one repeatedly, including by me:
    //   - Jul 18: asked for 6 hours, got 30 objects, concluded a conversation
    //     had not been recorded. It had. The window simply ended.
    //   - Jul 19 03:18: asked for 10 hours, got 29 objects, and every single
    //     one was from the newest few minutes.
    //   - The queue-feeder built its suppression and prior-contact sets from
    //     this door alone, so an opt-out older than the window became
    //     invisible and that person could be mailed again.
    //
    // A RECENCY WINDOW ANSWERS "WHAT IS NEW," NEVER "WHAT EXISTS." Those two
    // questions have opposite failure modes: a window that misses something
    // looks exactly like a pool that does not contain it. That ambiguity is
    // the single most expensive bug in this system's history, and it cannot be
    // fixed by the reader being careful -- it has to be fixed HERE, where the
    // door knows what it did and the reader cannot.
    //
    // So the notice is unconditional. Silence can never again mean complete.
    // =======================================================================
    // HIT_CEILING WAS ALWAYS TRUE. Fixed Jul 25 2026, alongside the cursor name.
    //
    // This compared what came back against `limit || 0`. When the caller omitted
    // limit -- which is the common case, and what PULSE and the ops board both
    // do -- that is `0`, and any non-empty read is `>= 0`. So the door reported
    // hit_ceiling: true on every unlimited read, whether it returned 30 records
    // or 3. The one flag that tells a caller "this is a floor, not a total" was
    // stuck on, which is the same as being absent: a warning that fires always
    // carries no information and gets tuned out. Compare against the limit the
    // door ACTUALLY APPLIED instead, and publish that number so the caller can
    // see the default it never asked for.
    const effLimit = result.limit_effective || parseInt(limit) || 0;
    const hitCeiling = effLimit > 0 &&
      (response.total_memories + response.total_objects) >= effLimit;
    response.door_notice = {
      door: 'v1/read',
      answers: 'WHAT IS NEAR IN TIME -- not what exists.',
      this_is_a_window: true,
      mode,
      returned: { memories: response.total_memories, objects: response.total_objects },
      limit_asked: limit || null,
      limit_applied: effLimit || null,
      hit_ceiling: hitCeiling,
      read_this:
        'THIS IS A TIME WINDOW, NOT THE POOL. Records outside it are NOT absent -- they were ' +
        'never looked at. ' +
        (hitCeiling
          ? 'This read ALSO came back full at its limit, so it does not even contain the whole ' +
            'window. Treat every count here as a floor.'
          : 'Nothing was cut by the limit, but the window itself still excludes everything older.'),
      never_conclude:
        'NEVER conclude that something does not exist because it is not here. This door cannot ' +
        'answer that question and has been mistaken for one that can -- on Jul 18 it returned 30 ' +
        'objects for a 6-hour request and a real conversation was declared missing.',
      use_instead:
        'To find whether something EXISTS, use the search door: /api/associative, asked several ' +
        'narrow ways in the person\'s own words until new queries stop returning new records. ' +
        'That door is the one door out. This one is for "what happened lately" only.',

      // HOW TO GET THE REST -- stated, not implied. Added Jul 25 2026 because
      // the absence of this block cost four days of wrong dashboards. Every
      // consumer of this door had to guess how to page, and all of them guessed
      // the field name we print two lines above. Now the door says it.
      how_to_continue: response.cursor
        ? 'Send this same request again with { "cursor": "' + response.cursor + '" } (or the ' +
          'equivalent "before") to get the page older than this one. Repeat until objects comes ' +
          'back empty or exhausted_window is true. `limit` is honored up to 200 and one call at ' +
          'limit:200 replaces seven at the default 30.'
        : 'No cursor -- nothing older was in reach for this request.',

      // AND WHEN NOT TO PAGE AT ALL.
      better_doors:
        'Do not page this door to answer HOW MANY or WHETHER. mode=count returns an exact ' +
        'database total over a literal content prefix with no ceiling (use it for every gauge and ' +
        'ledger number). mode=exists returns a literal yes/no for one string with no window (use ' +
        'it for de-duplication, prior-contact and suppression checks). Both were built Jul 21 ' +
        '2026 for exactly the jobs this window keeps being misused for.',
    };

    console.log(`[V1/READ] mode=${mode} memories=${result.memories.length} objects=${result.objects.length}`);
    return res.status(200).json(response);
  } catch (error) {
    console.error('[v1/read] handler error:', error);
    return res.status(500).json({ error: 'Internal server error', details: error.message });
  }
};
