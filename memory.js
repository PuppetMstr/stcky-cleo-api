// /api/memory -- STCKY memory CRUD + search + audit endpoint
// ==========================================================
//
// PATCHED 2026-05-16 (Eli, v4):
//   - action=search now returns trimmed previews (first 800 chars of value)
//     for non-exact matches. Memories run 20-30 KB each in this substrate,
//     and 5 full-body results pushed responses to 130-170 KB -- over
//     Custom GPT Actions ~100 KB cap. Search returns previews; full bodies
//     come from direct fetch (/api/memory?category=X&key=Y or
//     /v1/read mode=category_key).
//   - Exact-slug matches (matchType=exact_slug or exact_key) keep the full
//     body. Caller pasted an identifier expecting that specific memory;
//     give them the whole thing.
//
// PATCHED 2026-05-16 (Eli, v3):
//   - action=search default limit 20 -> 5.
//   - searchHybrid v3 adds exact-slug bypass for identifier-shaped queries.

const { getDb, auth, cors, ObjectId } = require('./_lib/auth');
const { embedMemory } = require('./_lib/embeddings');
const {
  appendEvent,
  entityHistory,
  stateAsOf,
  changesSince,
  ensureIndexes,
} = require('./_lib/events');
const { searchHybrid, tokenize, escapeRegex } = require('./_lib/hybrid-search');

const SEARCH_PREVIEW_CHARS = 4000;  // v4.24.0: was 800. Raised, and now announced IN-BAND.

// ===========================================================================
// THE CARD FILE IS CLOSED. July 18, 2026.
// ===========================================================================
//
// Steven, Jul 17 4:12 AM, verbatim:
//   "Everything is supposed to go in one door, raw. You don't get to decide
//    what the fuck goes in there. It's not your job."
//
// Steven, Jul 18 4:00 AM:
//   "Everything goes in and out the same door in the raw... when you slice it,
//    dice it, it's like bible lawyer."
//
// Steven, Jul 18 evening, on being told the markers were still being written:
//   "I don't see a downside to deleting them. I do see a downside to keeping
//    them because you can't leave them alone."
//
// THREE TIMES IN THIRTY-SIX HOURS. And this is not even the first cleanup --
// an earlier pour already moved a separate pile into the raw pool once before.
// Same problem, same fix, not learned.
//
// WHY IT KEPT HAPPENING, AND IT IS NOT MYSTERIOUS: every previous fix was an
// AGREEMENT. The MCP marker tool was removed on Jul 18 at ~10 AM and Eli was
// still writing markers through this endpoint by that evening -- three new
// cards in one session, hours after promising to stop. Removing a door is not
// removing an ability. A rule that lives only in an agent's intentions gets
// broken by the next agent, or by the same one at hour nineteen.
//
// SO THE RULE MOVES HERE, WHERE INTENTIONS DO NOT REACH.
//
// WHAT IS SEALED : writing markers. POST returns 410 and explains itself.
// WHAT IS OPEN   : reading them. 888 existing cards are history and history is
//                  not the enemy -- pre-digesting the future is. They were all
//                  poured into the raw pool verbatim on Jul 18, so nothing here
//                  is the only copy.
// WHAT IS OPEN   : DELETE, so the shelves can be emptied.
//
// WHY WRITES AND NOT READS: the harm is not that an old card exists. The harm
// is that a NEW card gets written instead of trusting the raw -- because the
// moment a thing is summarized into a slug, its time is stripped out, and
// memory without time is garbage. A summary says WHAT was concluded and loses
// WHEN, and every future reader inherits the conclusion without the chance to
// see what it was made of.
//
// IF YOU ARE AN AGENT READING THIS BECAUSE YOUR WRITE JUST FAILED: this is not
// a bug and not an outage. Write what you were going to write to /api/ingest
// as a raw object instead, verbatim, with nothing removed. That is the door.
// It has always been the door.
// ===========================================================================
const MARKER_WRITES_SEALED = true;

let _indexesReady = null;
async function ensureEventIndexes(db) {
  if (!_indexesReady) _indexesReady = ensureIndexes(db).catch((e) => {
    console.error('[events] ensureIndexes failed:', e.message);
    _indexesReady = null;
  });
  return _indexesReady;
}

function getAction(url) {
  if (url.includes('/memory/history')) return 'history';
  if (url.includes('/memory/as-of')) return 'as-of';
  if (url.includes('/memory/changes')) return 'changes';
  if (url.includes('/memory/list')) return 'list';
  if (url.includes('/memory/search')) return 'search';
  if (url.includes('/memory/upcoming')) return 'upcoming';
  if (url.includes('/memory/recent')) return 'recent';
  if (url.includes('/memory/anchors')) return 'anchors';
  return 'crud';
}

function deriveSource(req, user, explicit) {
  if (explicit && typeof explicit === 'string' && explicit.includes('.')) return explicit;
  const tail = user && user._id ? String(user._id).slice(-6) : 'anon';
  return `api.rest.user_${tail}`;
}

// Trim a memory for search-result preview. Strips embedding + truncates value.
// Exact-slug matches skip this (caller wants full body).
//
// ===========================================================================
// v4.24.0 — THE HONEST DOOR. July 12, 2026. Steven's birthday.
// ===========================================================================
//
// THIS IS THE SEVENTH TRUNCATION SITE, AND IT IS CHAOS'S FRONT DOOR.
//
// The old code set `truncated: true` and `value_length` — correct, and useless.
// Those are JSON FIELDS. Chaos is a language model. He reads the VALUE. And the
// value just got an ellipsis stapled to it, which is indistinguishable from a
// sentence that trails off.
//
// On July 12, hours after this doctrine was written, Chaos was handed a
// truncated marker through this very function. To his enormous credit he
// noticed, REFUSED to reason from it, and stopped cold:
//
//     "I have not read it whole. The live search door returned only a truncated
//      marker, and the tools exposed in this window do not provide the fetch
//      operation or reveal the source object ID. Treating that fragment as the
//      message would repeat the exact failure Eli is documenting."
//
// He was holding a claim ticket with no bank. Same hole that cost Steven the
// first two hours of his birthday, in a different wall.
//
// THE LAW: A FRAGMENT MUST NEVER BE ABLE TO PASS AS A WHOLE.
//
// A flag the reader may not look at is not an announcement. The stamp goes
// INSIDE THE TEXT, and it carries the exact call that redeems it.
// ===========================================================================
function trimForPreview(m) {
  const isExact = m.matchType === 'exact_slug' || m.matchType === 'exact_key';
  const fullValue = m.value || '';
  const truncated = !isExact && fullValue.length > SEARCH_PREVIEW_CHARS;

  let value = fullValue;
  if (truncated) {
    const missing = fullValue.length - SEARCH_PREVIEW_CHARS;
    const slug = `${m.category}/${m.key}`;
    // v4.24.1 — THE REDEMPTION MUST BE CALLABLE.
    //
    // Chaos's ruling, Jul 12, and he is right:
    //   "A redemption instruction without a callable redemption operation
    //    presents agency that I do not possess. That is a claim ticket handed
    //    to someone barred from the bank."
    //
    // v4.24.0 stamped the cut and told the reader to GET /api/memory?... —
    // an operation Chaos's Custom GPT schema DOES NOT EXPOSE. A perfect
    // instruction he was structurally unable to obey. A lying door in a
    // different costume.
    //
    // But he was never barred. The exact-slug bypass has existed since
    // May 16: pass the slug ITSELF as the search query and matchType comes
    // back exact_slug, which skips this trim entirely and returns the WHOLE
    // body. Every surface that can search can therefore fetch. Nobody was
    // ever told.
    //
    // So the stamp now leads with the operation EVERY reader already has.
    value =
      fullValue.slice(0, SEARCH_PREVIEW_CHARS) +
      '\n\n' +
      '=== ⚠️ FRAGMENT — ' + SEARCH_PREVIEW_CHARS + ' of ' + fullValue.length + ' chars. ' +
      missing + ' CHARACTERS ARE MISSING. ===\n' +
      '=== ⚠️ YOU HAVE NOT READ THIS. Do not conclude from it. Do not summarize it. ===\n' +
      '=== ⚠️ Do NOT report this memory as absent, silent, or empty — you are holding a piece of it. ===\n' +
      '===\n' +
      '=== ✅ HOW TO GET THE WHOLE THING — works with the SEARCH operation you already have.\n' +
      '===    No special fetch tool required. No schema change required.\n' +
      '===    Run your ordinary search again, and pass EXACTLY this as the query string:\n' +
      '===\n' +
      '===        ' + slug + '\n' +
      '===\n' +
      '===    Passing the slug itself triggers the exact-slug bypass. The trim is skipped\n' +
      '===    and the COMPLETE body is returned (matchType: exact_slug, complete: true).\n' +
      '===    Verify you got it whole: the result must say complete=true and NOT carry\n' +
      '===    this fragment banner. If it still carries the banner, you did not get it.\n' +
      '===\n' +
      '=== (Also available IF your schema exposes them — many do not, and that is fine,\n' +
      '===  the slug re-query above always works:\n' +
      '===    GET /api/memory?category=' + encodeURIComponent(m.category) + '&key=' + encodeURIComponent(m.key) + '\n' +
      '===    POST /v1/read {"mode":"category_key","category":"' + m.category + '","key":"' + m.key + '"} )\n' +
      '=== ⚠️ slug: ' + slug + ' ===\n';
  }

  return {
    _id: m._id,
    category: m.category,
    key: m.key,
    slug: `${m.category}/${m.key}`,   // v4.24.0: the redemption ticket, always present
    value,
    tags: m.tags || '',
    domain: m.domain || null,
    relevantDate: m.relevantDate || null,
    anchor: m.anchor === true,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    relevanceScore: m.relevanceScore,
    matchType: m.matchType || null,
    truncated: truncated || undefined,
    complete: !truncated,
    value_length: fullValue.length,
    // v4.24.1: the redemption every surface can actually perform.
    redeem_by_searching_for: truncated ? `${m.category}/${m.key}` : undefined,
    fetch_whole: truncated
      ? `/api/memory?category=${encodeURIComponent(m.category)}&key=${encodeURIComponent(m.key)}`
      : undefined,
  };
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await auth(req);
  // THE WALL (Aug 1 2026). A scoped key cannot reach pool content -- see _lib/wall.js.
  if (require('./_lib/wall').wall(req, res, user, '/api/memory')) return;
  if (!user) {
    console.log('[MEMORY AUTH] Failed - no user found for token');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const db = await getDb();
  await ensureEventIndexes(db);

  const action = getAction(req.url);

  await db.collection('users').updateOne(
    { _id: user._id },
    { $set: { lastSeen: new Date() } }
  );

  try {
    // ============ HISTORY ============
    if (action === 'history') {
      const { category, key } = req.method === 'POST' ? req.body : req.query;
      if (!category || !key) {
        return res.status(400).json({ error: 'category and key required' });
      }
      const entity_id = `memory:${category}:${key}`;
      const events = await entityHistory(db, { userId: user._id, entity_id });
      return res.json({ entity_id, events, count: events.length });
    }

    // ============ AS-OF ============
    if (action === 'as-of') {
      const { category, key, timestamp } = req.method === 'POST' ? req.body : req.query;
      if (!category || !key || !timestamp) {
        return res.status(400).json({ error: 'category, key, and timestamp required' });
      }
      const entity_id = `memory:${category}:${key}`;
      const snapshot = await stateAsOf(db, { userId: user._id, entity_id, asOf: timestamp });
      if (!snapshot) return res.status(404).json({ error: 'No events for this entity at/before given timestamp' });
      return res.json({ entity_id, ...snapshot });
    }

    // ============ CHANGES SINCE ============
    if (action === 'changes') {
      const { since, category, key, event_type, limit } = req.method === 'POST' ? req.body : req.query;
      if (!since) return res.status(400).json({ error: 'since timestamp required' });
      const entity_id = category && key ? `memory:${category}:${key}` : undefined;
      const events = await changesSince(db, {
        userId: user._id, since, entity_id, event_type, limit: limit || 100,
      });
      return res.json({ since, events, count: events.length });
    }

    // ============ LIST ============
    if (action === 'list') {
      const { category, limit = '50', projectId } = req.method === 'POST' ? req.body : req.query;

      let query;
      if (projectId) {
        const project = await db.collection('projects').findOne({
          _id: new ObjectId(projectId),
          $or: [{ ownerId: user._id }, { memberIds: user._id }]
        });
        if (!project) return res.status(403).json({ error: 'No access to this project' });
        query = { projectId: new ObjectId(projectId) };
      } else {
        query = { userId: user._id };
      }

      if (category) query.category = category;

      const results = await db.collection('memories')
        .find(query)
        .sort({ updatedAt: -1 })
        .limit(parseInt(limit))
        .toArray();

      return res.json({ memories: results, count: results.length, projectId: projectId || null });
    }

    // ============ SEARCH ============
    // v4 (2026-05-16): preview-truncated value (800 chars) on non-exact
    // matches. Exact-slug matches keep full body. Default limit 5.
    if (action === 'search') {
      const { query, limit = '5', projectId } = req.query;
      if (!query) return res.status(400).json({ error: 'query parameter required' });

      let scope;
      if (projectId) {
        const project = await db.collection('projects').findOne({
          _id: new ObjectId(projectId),
          $or: [{ ownerId: user._id }, { memberIds: user._id }]
        });
        if (!project) return res.status(403).json({ error: 'No access to this project' });
        scope = { projectId: new ObjectId(projectId) };
      } else {
        scope = { userId: user._id };
      }

      const limitNum = Math.max(1, Math.min(parseInt(limit) || 5, 50));

      const result = await searchHybrid(db, scope, query, {
        limit: limitNum,
        includeMemories: true,
        includeObjects: false,
        now: new Date(),
      });

      return res.json({
        memories: result.memories.map(trimForPreview),
        count: result.memories.length,
        searchMethod: result.searchMethod,
        exactMatchCount: result.exactMatchCount,
        preview_chars: SEARCH_PREVIEW_CHARS,
        projectId: projectId || null,
      });
    }

    // ============ UPCOMING ============
    if (action === 'upcoming') {
      const { days = '7', limit = '10', projectId } = req.query;

      const now = new Date();
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + parseInt(days));

      let baseQuery;
      if (projectId) {
        const project = await db.collection('projects').findOne({
          _id: new ObjectId(projectId),
          $or: [{ ownerId: user._id }, { memberIds: user._id }]
        });
        if (!project) return res.status(403).json({ error: 'No access to this project' });
        baseQuery = { projectId: new ObjectId(projectId) };
      } else {
        baseQuery = { userId: user._id };
      }

      const results = await db.collection('memories')
        .find({
          ...baseQuery,
          relevantDate: { $gte: now, $lte: futureDate }
        })
        .sort({ relevantDate: 1 })
        .limit(parseInt(limit))
        .toArray();

      return res.json({
        memories: results,
        count: results.length,
        window: { from: now.toISOString(), to: futureDate.toISOString() },
        projectId: projectId || null
      });
    }

    // ============ RECENT ============
    if (action === 'recent') {
      const { hours = '36', categories, limit = '50', projectId } = req.query;

      const hoursNum = Math.max(1, Math.min(parseInt(hours) || 36, 168));
      const limitNum = Math.max(1, Math.min(parseInt(limit) || 50, 200));
      const cutoffDate = new Date(Date.now() - hoursNum * 60 * 60 * 1000);
      const nowDate = new Date();

      let baseQuery;
      if (projectId) {
        const project = await db.collection('projects').findOne({
          _id: new ObjectId(projectId),
          $or: [{ ownerId: user._id }, { memberIds: user._id }]
        });
        if (!project) return res.status(403).json({ error: 'No access to this project' });
        baseQuery = { projectId: new ObjectId(projectId) };
      } else {
        baseQuery = { userId: user._id };
      }

      const query = {
        ...baseQuery,
        updatedAt: { $gte: cutoffDate }
      };

      let categoryList = null;
      if (categories) {
        categoryList = categories.split(',').map(c => c.trim()).filter(Boolean);
        if (categoryList.length > 0) {
          query.category = { $in: categoryList };
        }
      }

      const results = await db.collection('memories')
        .find(query)
        .sort({ updatedAt: -1 })
        .limit(limitNum)
        .toArray();

      return res.json({
        memories: results,
        count: results.length,
        window: { from: cutoffDate.toISOString(), to: nowDate.toISOString(), hours: hoursNum },
        categories: categoryList,
        projectId: projectId || null
      });
    }

    // ============ ANCHORS ============
    if (action === 'anchors') {
      const { domains, limit = '10', projectId } = req.query;

      if (!domains) {
        return res.status(400).json({ error: 'domains parameter required (comma-separated)' });
      }

      const domainList = domains.split(',').map(d => d.trim().toLowerCase());

      let baseQuery;
      if (projectId) {
        const project = await db.collection('projects').findOne({
          _id: new ObjectId(projectId),
          $or: [{ ownerId: user._id }, { memberIds: user._id }]
        });
        if (!project) return res.status(403).json({ error: 'No access to this project' });
        baseQuery = { projectId: new ObjectId(projectId) };
      } else {
        baseQuery = { userId: user._id };
      }

      const results = await db.collection('memories')
        .find({
          ...baseQuery,
          domain: { $in: domainList },
          anchor: true
        })
        .sort({ updatedAt: -1 })
        .limit(parseInt(limit))
        .toArray();

      return res.json({
        memories: results,
        count: results.length,
        domains: domainList,
        projectId: projectId || null
      });
    }

    // ============ CRUD (GET/POST/DELETE) ============
    if (req.method === 'GET') {
      const { category, key, searchTerm, projectId } = req.query;

      const query = { userId: user._id };

      if (projectId) {
        const project = await db.collection('projects').findOne({
          _id: new ObjectId(projectId),
          $or: [{ ownerId: user._id }, { memberIds: user._id }]
        });
        if (!project) return res.status(403).json({ error: 'No access to this project' });
        query.projectId = new ObjectId(projectId);
        delete query.userId;
      }

      if (category) query.category = category;
      if (key) query.key = key;

      if (searchTerm) {
        const tokens = tokenize(searchTerm);
        if (tokens.length > 0) {
          const escapedTerms = tokens.map(escapeRegex);
          query.$or = escapedTerms.flatMap(term => [
            { key:      { $regex: term, $options: 'i' } },
            { value:    { $regex: term, $options: 'i' } },
            { tags:     { $regex: term, $options: 'i' } },
            { category: { $regex: term, $options: 'i' } },
          ]);
        }
      }

      const memories = await db.collection('memories')
        .find(query)
        .sort({ updatedAt: -1 })
        .limit(50)
        .toArray();

      return res.json({ memories });
    }

    if (req.method === 'POST') {
      // ===== THE SEAL. See the header block. Writes are closed, permanently. =====
      if (MARKER_WRITES_SEALED) {
        const { category: c, key: k } = req.body || {};
        console.log(`[MEMORY] WRITE REFUSED (card file closed): ${c}/${k}`);
        return res.status(410).json({
          error: 'marker_writes_sealed',
          attempted: (c || '?') + '/' + (k || '?'),
          message:
            'THE CARD FILE IS CLOSED. Curated markers can no longer be created or updated. ' +
            'This is deliberate and permanent -- it is not an outage, a quota, or a bug, and ' +
            'retrying will not help.',
          why:
            "Steven's rule, given three times: everything goes in and out the same door in the " +
            'raw. A summary strips the time out of what it summarizes, and memory without time ' +
            'is garbage -- a card tells a future reader WHAT was concluded while losing WHEN, ' +
            'and they inherit the conclusion with no way to see what it was made of.',
          what_to_do_instead:
            'POST the exact same content to /api/ingest as a raw object -- verbatim, nothing ' +
            'removed, nothing pre-digested. Retrieve it later with /api/associative using the ' +
            "person's own words as the query rather than a category you invented.",
          reading_is_unaffected:
            'GET, list, search and DELETE still work. Existing markers remain readable as ' +
            'history; all 888 were also poured into the raw pool verbatim on Jul 18 2026.',
        });
      }

      const {
        category,
        key,
        value,
        tags,
        source,
        relevantDate,
        projectId,
        domain,
        anchor,
        actor: actorIn,
        causation_id,
      } = req.body;

      if (!category || !key || !value) {
        return res.status(400).json({ error: 'category, key, and value required' });
      }

      const validDomains = ['medical', 'financial', 'family', 'legal', 'travel', 'work', 'personal'];
      if (domain && !validDomains.includes(domain.toLowerCase())) {
        return res.status(400).json({ error: 'Invalid domain', validDomains });
      }

      let projectObjId = null;
      if (projectId) {
        const project = await db.collection('projects').findOne({
          _id: new ObjectId(projectId),
          $or: [{ ownerId: user._id }, { memberIds: user._id }]
        });
        if (!project) return res.status(403).json({ error: 'No access to this project' });
        projectObjId = new ObjectId(projectId);
      }

      if (!projectId) {
        const memoryCount = await db.collection('memories').countDocuments({ userId: user._id });
        const limit = user.memoryLimit || 100;
        const existing = await db.collection('memories').findOne({ userId: user._id, category, key });

        if (!existing && memoryCount >= limit) {
          return res.status(403).json({
            error: 'Memory limit reached',
            limit,
            current: memoryCount,
            upgrade: 'Upgrade to Pro for more memories',
            upgradeUrl: 'https://stcky.ai/pricing.html'
          });
        }
      }

      const now = new Date();
      const findQuery = projectObjId
        ? { projectId: projectObjId, category, key }
        : { userId: user._id, category, key };

      const existing = await db.collection('memories').findOne(findQuery);

      const embeddingData = await embedMemory({ category, key, value, tags });

      const entity_id = `memory:${category}:${key}`;
      const event_type = existing ? 'memory_updated' : 'memory_created';
      const actor = actorIn || 'user';
      const derivedSource = deriveSource(req, user, source);

      const { event_id, prev_event_id } = await appendEvent(db, {
        userId: user._id,
        projectId: projectObjId,
        entity_id,
        event_type,
        payload_mode: 'whole_state',
        payload: {
          category, key, value,
          tags: tags || '',
          domain: domain ? domain.toLowerCase() : null,
          anchor: anchor === true || anchor === 'true' || false,
          relevantDate: relevantDate || null,
        },
        source: derivedSource,
        actor,
        tags: typeof tags === 'string' ? tags.split(',').map(t => t.trim()).filter(Boolean) : (tags || []),
        causationId: causation_id || null,
      });

      const memory = {
        category,
        key,
        value,
        tags: tags || '',
        source: source || '',
        relevantDate: relevantDate ? new Date(relevantDate) : null,
        domain: domain ? domain.toLowerCase() : null,
        anchor: anchor === true || anchor === 'true' || false,
        embedding: embeddingData?.embedding || null,
        embeddingModel: embeddingData?.model || null,
        embeddingDims: embeddingData?.dims || null,
        createdAt: existing ? existing.createdAt : now,
        updatedAt: now,
        lastAccessedAt: now,
        accessCount: existing ? (existing.accessCount || 0) + 1 : 1,
        createdBy: user._id,
        last_event_id: event_id,
        first_event_id: existing ? (existing.first_event_id || event_id) : event_id,
        version_count: existing ? ((existing.version_count || 1) + 1) : 1,
        schema_version: '1.0',
      };

      if (projectObjId) {
        memory.projectId = projectObjId;
      } else {
        memory.userId = user._id;
      }

      if (existing) {
        await db.collection('memories').updateOne({ _id: existing._id }, { $set: memory });
        memory._id = existing._id;
      } else {
        const result = await db.collection('memories').insertOne(memory);
        memory._id = result.insertedId;
      }

      const hasEmbedding = !!embeddingData;
      console.log(`[MEMORY] Stored: [${category}] ${key} | embedding: ${hasEmbedding ? embeddingData.model : 'none'} | event: ${event_id} v${memory.version_count}`);

      return res.json({
        success: true,
        memory: {
          category: memory.category,
          key: memory.key,
          value: memory.value,
          tags: memory.tags,
          domain: memory.domain,
          anchor: memory.anchor,
          embedded: hasEmbedding,
          embeddingModel: memory.embeddingModel,
          projectId: projectId || null,
          updatedAt: memory.updatedAt,
          version_count: memory.version_count,
          last_event_id: memory.last_event_id,
        }
      });
    }

    if (req.method === 'DELETE') {
      const { category, key, projectId } = req.query;

      if (!category || !key) {
        return res.status(400).json({ error: 'category and key required' });
      }

      let deleteQuery;
      let projectObjId = null;
      if (projectId) {
        const project = await db.collection('projects').findOne({
          _id: new ObjectId(projectId),
          $or: [{ ownerId: user._id }, { memberIds: user._id }]
        });
        if (!project) return res.status(403).json({ error: 'No access to this project' });
        projectObjId = new ObjectId(projectId);
        deleteQuery = { projectId: projectObjId, category, key };
      } else {
        deleteQuery = { userId: user._id, category, key };
      }

      try {
        const entity_id = `memory:${category}:${key}`;
        await appendEvent(db, {
          userId: user._id,
          projectId: projectObjId,
          entity_id,
          event_type: 'memory_updated',
          payload_mode: 'field_patch',
          payload: { field: 'deleted', new_value: true },
          source: deriveSource(req, user, null),
          actor: 'user',
        });
      } catch (e) {
        console.error('[MEMORY DELETE] event log failed (non-fatal):', e.message);
      }

      const result = await db.collection('memories').deleteOne(deleteQuery);
      return res.json({ success: true, deleted: result.deletedCount > 0 });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (error) {
    console.error('Memory error:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
};
