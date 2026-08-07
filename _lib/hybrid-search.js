// _lib/hybrid-search.js -- shared hybrid search primitives
// =========================================================
// v3 (2026-05-16): exact-slug bypass. When a query contains literal
// "category/key" or a bare "key" token, the matching memory is looked up
// directly and surfaced at top with dominant score. Closes the "user pasted
// an identifier expecting that exact memory" use case as a first-class
// feature instead of leaving it to noisy slug-embedding ranking.
//
// v2 (2026-05-16): scope parameterization. Primitives take a scope object
// (either { userId } or { projectId }) so the same primitive serves user-
// scoped and project-scoped searches.
//
// v1 (2026-05-16): extracted from associative.js. Vector + keyword + merge
// + rank as the canonical search primitive shared across all search-fronting
// endpoints. Closes finding/semantic-search-fails-on-slug-syntax-queries-
// 2026-05-16.

const { embed } = require('./embeddings');

const MEMORIES_VECTOR_INDEX = 'memory_vector_index';
const OBJECTS_VECTOR_INDEX  = 'objects_vector_index';

const EXACT_MATCH_SCORE = 1000;  // dominant; ensures exact slug hits sort first

// SEMANTIC PATH = RELEVANCE ONLY. Recency/momentum is the temporal path's job
// (the parallel recent-objects pull + /v1/read mode=now), not the semantic
// ranker's. Mixing time windows into semantic search re-pollutes it with the
// noise the temporal window suffers from. Default 0 = pure relevance.
// Dial up (e.g. 0.25) to reintroduce a gentle recency nudge if ever wanted.
const SEMANTIC_TEMPORAL_WEIGHT = 0;

// --------------------------------------------------------------------------
// Tokenization + escaping
// --------------------------------------------------------------------------

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tokenize(query) {
  if (!query) return [];
  return String(query)
    .split(/[\s/]+/)
    .map(t => t.trim())
    .filter(t => t.length >= 2);
}

// --------------------------------------------------------------------------
// Exact-slug bypass (v3, 2026-05-16)
// --------------------------------------------------------------------------
//
// When the query contains an identifier-shaped string -- either "category/key"
// or a bare slug-key with hyphens -- look it up directly and return it as
// the top-ranked result. Handles the "user pasted a memory identifier"
// use case deterministically rather than relying on embedding ranking.
//
// Detection rules:
//   - Any "category/key" substring matching slug syntax -> findOne by both
//   - Any token from tokenize() with length >= 5 that looks key-shaped
//     (contains at least one hyphen) -> findOne by key only
//
// Returns: array of matching memory docs (deduped by _id). Empty if no
// exact identifiers found. Each match gets relevanceScore=EXACT_MATCH_SCORE
// and matchType='exact_slug' for caller introspection.

async function exactSlugMatches(db, scope, query) {
  if (!query) return [];

  const matches = [];
  const seen = new Set();

  // 1. category/key patterns (most specific)
  const slugRe = /([a-z][a-z0-9-]*[a-z0-9])\/([a-z0-9][a-z0-9-]+)/gi;
  let m;
  while ((m = slugRe.exec(query)) !== null) {
    try {
      const found = await db.collection('memories').findOne({
        ...scope, category: m[1], key: m[2]
      });
      if (found && !seen.has(found._id.toString())) {
        found.relevanceScore = EXACT_MATCH_SCORE;
        found.matchType = 'exact_slug';
        matches.push(found);
        seen.add(found._id.toString());
      }
    } catch (e) {
      console.log('[HYBRID-SEARCH] exact slug lookup failed:', e.message);
    }
  }

  // 2. Bare-key tokens (looser: any token that looks like a key)
  const tokens = tokenize(query);
  for (const tok of tokens) {
    if (tok.length < 5) continue;
    if (!tok.includes('-')) continue;  // keys have hyphens
    try {
      const found = await db.collection('memories').findOne({
        ...scope, key: tok
      });
      if (found && !seen.has(found._id.toString())) {
        found.relevanceScore = EXACT_MATCH_SCORE;
        found.matchType = 'exact_key';
        matches.push(found);
        seen.add(found._id.toString());
      }
    } catch (e) {
      console.log('[HYBRID-SEARCH] exact key lookup failed:', e.message);
    }
  }

  return matches;
}

// --------------------------------------------------------------------------
// Temporal scoring helpers
// --------------------------------------------------------------------------

function calculateTemporalScore(memory, now) {
  let score = 0;
  const hoursSinceUpdate = (now - new Date(memory.updatedAt)) / (1000 * 60 * 60);
  if (hoursSinceUpdate < 24) score += 30;
  else if (hoursSinceUpdate < 168) score += 20;
  else if (hoursSinceUpdate < 720) score += 10;

  if (memory.relevantDate) {
    const hoursToRelevant = Math.abs(now - new Date(memory.relevantDate)) / (1000 * 60 * 60);
    if (hoursToRelevant < 24) score += 30;
    else if (hoursToRelevant < 168) score += 20;
    else if (hoursToRelevant < 720) score += 10;
  }

  if (memory.accessCount > 10) score += 10;
  else if (memory.accessCount > 5) score += 5;

  return score;
}

function calculateObjectTemporalScore(obj, now) {
  let score = 0;
  const anchorTime = obj.timestamp || obj.ingested_at || obj.server_ingest_timestamp;
  if (anchorTime) {
    const hoursSince = (now - new Date(anchorTime)) / (1000 * 60 * 60);
    if (hoursSince < 24) score += 30;
    else if (hoursSince < 168) score += 20;
    else if (hoursSince < 720) score += 10;
  }
  return score;
}

function calculateKeywordScore(doc, queryTerms, fields) {
  if (!queryTerms || queryTerms.length === 0) return 0;
  let score = 0;
  const parts = fields.map(f => String(doc[f] ?? '')).join(' ').toLowerCase();
  for (const term of queryTerms) {
    if (parts.includes(term.toLowerCase())) {
      score += 40 / queryTerms.length;
    }
  }
  return Math.round(score);
}

// --------------------------------------------------------------------------
// Memory search paths
// --------------------------------------------------------------------------

async function memoryVectorSearch(db, scope, queryEmbedding, limit) {
  try {
    const pipeline = [
      {
        $vectorSearch: {
          index: MEMORIES_VECTOR_INDEX,
          path: 'embedding',
          queryVector: queryEmbedding,
          numCandidates: limit * 20,
          limit: limit * 2,
          filter: scope
        }
      },
      {
        $project: {
          _id: 1,
          category: 1, key: 1, value: 1, tags: 1,
          domain: 1, anchor: 1, relevantDate: 1,
          createdAt: 1, updatedAt: 1, accessCount: 1,
          vectorScore: { $meta: 'vectorSearchScore' }
        }
      }
    ];
    return await db.collection('memories').aggregate(pipeline).toArray();
  } catch (error) {
    console.log('[HYBRID-SEARCH] Memory vector search failed:', error.message);
    return null;
  }
}

async function memoryKeywordSearch(db, scope, queryTerms, limit) {
  if (!queryTerms || queryTerms.length === 0) return [];

  const escapedTerms = queryTerms.map(escapeRegex);
  const conditions = escapedTerms.flatMap(term => [
    { key:      { $regex: term, $options: 'i' } },
    { value:    { $regex: term, $options: 'i' } },
    { tags:     { $regex: term, $options: 'i' } },
    { category: { $regex: term, $options: 'i' } },
  ]);

  // Deterministic for the same reason objectsKeywordSearch is -- see the note
  // there. Memories order by updatedAt, which is the field their own ranker
  // scores recency on.
  return await db.collection('memories')
    .find({ ...scope, $or: conditions })
    .sort({ updatedAt: -1 })
    .limit(limit * 3)
    .toArray();
}

// --------------------------------------------------------------------------
// Object search paths
// --------------------------------------------------------------------------

async function objectsVectorSearch(db, scope, queryEmbedding, limit) {
  try {
    const pipeline = [
      {
        $vectorSearch: {
          index: OBJECTS_VECTOR_INDEX,
          path: 'embedding',
          queryVector: queryEmbedding,
          numCandidates: limit * 20,
          limit: limit * 2,
          filter: scope
        }
      },
      {
        $project: {
          _id: 1,
          object_id: 1, content: 1, content_length: 1,
          source_type: 1, source: 1, speaker: 1,
          session_id: 1, turn_index: 1, trace_id: 1, client: 1,
          timestamp: 1, ingested_at: 1,
          parent_object_id: 1, chunk_index: 1,
          embedding: 1,
          metadata: 1,
          vectorScore: { $meta: 'vectorSearchScore' }
        }
      }
    ];
    return await db.collection('objects').aggregate(pipeline).toArray();
  } catch (error) {
    console.log('[HYBRID-SEARCH] Objects vector search failed:', error.message);
    return null;
  }
}

async function objectsKeywordSearch(db, scope, queryTerms, limit) {
  if (!queryTerms || queryTerms.length === 0) return [];

  const escapedTerms = queryTerms.map(escapeRegex);
  const conditions = escapedTerms.flatMap(term => [
    { content: { $regex: term, $options: 'i' } },
    { source:  { $regex: term, $options: 'i' } },
    { speaker: { $regex: term, $options: 'i' } },
  ]);

  // A LIMIT WITHOUT A SORT IS AN ARBITRARY SLICE. Fixed Aug 7 2026, Eli.
  //
  // This was .find(...).limit(limit * 3) with no .sort(). Which matching
  // documents came back was whatever the chosen query plan happened to yield
  // first -- and NOTHING TOLD THE CALLER. It only ever LOOKED recency-ordered
  // because the plan the optimiser picked happened to walk that way.
  //
  // WHAT IT COST, Aug 7 2026 at 4:39 AM: growbotik-status derived the ops
  // board's LAST SEND from this door, on a comment reading "recency is the one
  // axis the ranker never misses." Two indexes were created on cleo.objects
  // that morning. Creating an index INVALIDATES THE COLLECTION'S PLAN CACHE.
  // The optimiser re-chose, the arbitrary slice reshuffled, and the board
  // printed SENT TODAY 18 -- 18 IN THE LAST HOUR -- LAST SEND 2d AGO, all on
  // one card in one second. The assumption was never true. It was lucky, and
  // an index build ended the luck.
  //
  // Sorting on ingested_at makes this DETERMINISTIC and makes it mean what
  // every caller already assumed it meant. The scope is { userId }, so
  // userId_1_ingested_at_-1 provides the order and the regexes are evaluated
  // as it walks -- the same work, in a defined sequence.
  //
  // HONEST COST: for a term that appears only in old records this now walks
  // further back before filling limit*3, where before it stopped at whatever
  // it found first. Slower and right beats fast and arbitrary at a door whose
  // output people make decisions from.
  return await db.collection('objects')
    .find({ ...scope, $or: conditions })
    .sort({ ingested_at: -1 })
    .limit(limit * 3)
    .toArray();
}

// --------------------------------------------------------------------------
// Merge + rank
// --------------------------------------------------------------------------

function mergeAndRankMemories(vectorResults, keywordResults, queryTerms, now) {
  const seen = new Set();
  const merged = [];

  if (vectorResults) {
    for (const m of vectorResults) {
      const id = m._id.toString();
      if (!seen.has(id)) {
        seen.add(id);
        m.vectorScore = m.vectorScore || 0;
        m.keywordScore = 0;
        merged.push(m);
      }
    }
  }

  if (keywordResults) {
    for (const m of keywordResults) {
      const id = m._id.toString();
      if (!seen.has(id)) {
        seen.add(id);
        m.vectorScore = 0;
        m.keywordScore = calculateKeywordScore(m, queryTerms, ['key', 'value', 'tags', 'category']);
        merged.push(m);
      } else {
        const existing = merged.find(x => x._id.toString() === id);
        if (existing) {
          existing.keywordScore = calculateKeywordScore(m, queryTerms, ['key', 'value', 'tags', 'category']);
        }
      }
    }
  }

  for (const m of merged) {
    const temporalScore = calculateTemporalScore(m, now);
    const normalizedVector = (m.vectorScore || 0) * 50;
    const keywordPart = m.keywordScore || 0;
    m.relevanceScore = Math.round(normalizedVector + keywordPart + SEMANTIC_TEMPORAL_WEIGHT * temporalScore);
  }

  merged.sort((a, b) => b.relevanceScore - a.relevanceScore);
  return merged;
}

function mergeAndRankObjects(vectorResults, keywordResults, queryTerms, now) {
  const seen = new Set();
  const merged = [];

  if (vectorResults) {
    for (const o of vectorResults) {
      const id = o._id.toString();
      if (!seen.has(id)) {
        seen.add(id);
        o.vectorScore = o.vectorScore || 0;
        o.keywordScore = 0;
        merged.push(o);
      }
    }
  }

  if (keywordResults) {
    for (const o of keywordResults) {
      const id = o._id.toString();
      if (!seen.has(id)) {
        seen.add(id);
        o.vectorScore = 0;
        o.keywordScore = calculateKeywordScore(o, queryTerms, ['content', 'source', 'speaker']);
        merged.push(o);
      } else {
        const existing = merged.find(x => x._id.toString() === id);
        if (existing) {
          existing.keywordScore = calculateKeywordScore(o, queryTerms, ['content', 'source', 'speaker']);
        }
      }
    }
  }

  for (const o of merged) {
    const temporalScore = calculateObjectTemporalScore(o, now);
    const normalizedVector = (o.vectorScore || 0) * 50;
    const keywordPart = o.keywordScore || 0;
    o.relevanceScore = Math.round(normalizedVector + keywordPart + SEMANTIC_TEMPORAL_WEIGHT * temporalScore);
  }

  merged.sort((a, b) => b.relevanceScore - a.relevanceScore);
  return merged;
}

// --------------------------------------------------------------------------
// Top-level convenience: searchHybrid
// --------------------------------------------------------------------------
//
// v3 flow:
//   1. exactSlugMatches: deterministic lookup for category/key or bare key
//      identifiers in the query. Returns array of full memory docs with
//      relevanceScore=EXACT_MATCH_SCORE.
//   2. Vector + keyword fan-out (memories + objects)
//   3. Merge + rank by relevanceScore (exact matches dominate)
//   4. Return top N

async function searchHybrid(db, scope, query, opts = {}) {
  const {
    limit           = 10,
    includeMemories = true,
    includeObjects  = true,
    now             = new Date(),
  } = opts;

  if (!query) {
    return {
      memories: [],
      objects:  [],
      searchMethod: { memories: 'none', objects: 'none' },
      queryTerms: [],
    };
  }

  const queryTerms = tokenize(query);

  // 1. Exact-slug bypass (memories only -- objects don't have category/key)
  const exactMemories = includeMemories
    ? await exactSlugMatches(db, scope, query)
    : [];

  // 2. Fan-out vector + keyword
  const [smallEmbed, largeEmbed] = await Promise.all([
    includeMemories ? embed(query, 'small') : Promise.resolve(null),
    includeObjects  ? embed(query, 'large') : Promise.resolve(null),
  ]);

  const memoryTasks = [];
  if (includeMemories) {
    memoryTasks.push(smallEmbed && smallEmbed.embedding
      ? memoryVectorSearch(db, scope, smallEmbed.embedding, limit)
      : Promise.resolve(null));
    memoryTasks.push(memoryKeywordSearch(db, scope, queryTerms, limit));
  } else {
    memoryTasks.push(Promise.resolve(null), Promise.resolve([]));
  }

  const objectTasks = [];
  if (includeObjects) {
    objectTasks.push(largeEmbed && largeEmbed.embedding
      ? objectsVectorSearch(db, scope, largeEmbed.embedding, limit)
      : Promise.resolve(null));
    objectTasks.push(objectsKeywordSearch(db, scope, queryTerms, limit));
  } else {
    objectTasks.push(Promise.resolve(null), Promise.resolve([]));
  }

  const [memVec, memKw, objVec, objKw] = await Promise.all([...memoryTasks, ...objectTasks]);

  // 3. Merge + rank, then prepend exact matches and dedupe
  let rankedMemories = includeMemories
    ? mergeAndRankMemories(memVec, memKw, queryTerms, now)
    : [];

  if (exactMemories.length > 0) {
    const exactIds = new Set(exactMemories.map(m => m._id.toString()));
    const rest = rankedMemories.filter(m => !exactIds.has(m._id.toString()));
    rankedMemories = [...exactMemories, ...rest];
  }

  rankedMemories = rankedMemories.slice(0, limit);

  const rankedObjects = includeObjects
    ? mergeAndRankObjects(objVec, objKw, queryTerms, now).slice(0, limit)
    : [];

  const searchMethod = {
    memories: exactMemories.length > 0
      ? (memVec && memVec.length > 0 ? 'exact+hybrid' : (memKw && memKw.length > 0 ? 'exact+keyword' : 'exact'))
      : (memVec && memVec.length > 0 ? 'hybrid' : (memKw && memKw.length > 0 ? 'keyword' : 'none')),
    objects:  objVec && objVec.length > 0 ? 'hybrid' : (objKw && objKw.length > 0 ? 'keyword' : 'none'),
  };

  return {
    memories: rankedMemories,
    objects:  rankedObjects,
    searchMethod,
    queryTerms,
    exactMatchCount: exactMemories.length,
  };
}

module.exports = {
  searchHybrid,
  exactSlugMatches,
  tokenize,
  escapeRegex,
  memoryVectorSearch,
  memoryKeywordSearch,
  objectsVectorSearch,
  objectsKeywordSearch,
  mergeAndRankMemories,
  mergeAndRankObjects,
  calculateKeywordScore,
  calculateTemporalScore,
  calculateObjectTemporalScore,
  EXACT_MATCH_SCORE,
};
