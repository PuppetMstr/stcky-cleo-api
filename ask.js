// cleo-api/ask.js
// ---------------------------------------------------------------------------
// THE GUARDIAN -- the server-side door that answers without editing.
//
// Steven, Jul 30 2026: "I kept thinking we needed the door for you to get in the
// blob. But now I think what we need is a WALL with a search engine on the other
// side that does very simple things -- not as smart as you, not as clever as you,
// doesn't have the needs that you have to prove itself to go find things."
// And: "It's the lifeguard. It's the guardian. It's what protects what's in that
// pool. It doesn't let things out unless there's the things it's supposed to get
// out -- because this is everybody's pool."
//
// He built that locally first (pull_pool.py + ask.py, MiniLM, 32,374 objects on
// his own machine). This is the same contract implemented server-side, so every
// STCKY gets it without installing Python, downloading weights, or running a
// nightly top-up. The vectors are already here; only the guardian was missing.
//
// THE CONTRACT -- these are the promises, not features:
//   1. SCORE EVERYTHING. No k, no threshold, no rank-and-truncate. Exhaustive.
//   2. REPORT THE DISTRIBUTION FIRST -- how the WHOLE pool leans, before any cut.
//   3. THE CUT IS THE USER'S, AND IT IS PRINTED. Never buried on the far side.
//   4. `near` AND `literal` ARE NEVER BLENDED into one number.
//   5. SAY HOW MANY MORE ARE OUT THERE.
//   6. IF IT COULD NOT FINISH, SAY SO. Absence is never implied by silence.
//
// WHY IT IS TRUSTWORTHY: not because it is simple, but because it does the
// geometry and refuses to do the editing. It CANNOT decide what to hide, because
// deciding is not in it. Judgment belongs on the other side of the wall.
//
// WHY THIS IS A NEW FILE AND NOT AN EDIT TO associative.js: that file is 39KB and
// serves every STCKY user right now. A new endpoint cannot break the working door,
// and if this turns out to be the wrong shape, we delete one file.
//
// TWO CHANNELS, DELIBERATELY UNMIXED:
//   LITERAL  -- word-boundary matching with an exact count. NO MODEL. Pure
//               arithmetic. It is the ONLY channel that can ever handle a private
//               vocabulary: VDC, ARIS, Chalam, Growbotik, STCKY. A general
//               embedding model was frozen before those words meant anything, and
//               it will never learn them. On Jul 30 the literal channel found all
//               14 VDC objects with zero junk while semantic smeared VDC->VA.
//   NEAR     -- exact nearest neighbour (ENN) over every indexed vector. Catches
//               paraphrase, which literal cannot do at all.
// They fail in opposite directions. Averaging them would hide both failures.
// ---------------------------------------------------------------------------
'use strict';

const { MongoClient } = require('mongodb');
const { embed } = require('./_lib/embeddings');
const { auth: sharedAuth } = require('./_lib/auth');

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGO_DB_NAME || 'cleo';

// ENN is exhaustive by definition, so it costs what it costs. MongoDB's own
// guidance is sub-second up to ~10,000 documents. Past that it degrades honestly
// (slower), not silently (narrower) -- which is the trade this contract wants.
const ENN_CEILING = Number(process.env.GUARDIAN_ENN_CEILING || 60000);
const DEFAULT_TAKE = 10;
const MAX_TAKE = 200;
const BUCKETS = 10;

let _client = null;
async function getDb() {
  if (!_client) {
    _client = new MongoClient(MONGODB_URI);
    await _client.connect();
  }
  return _client.db(DB_NAME);
}

async function authenticate(req, db) {
  const auth = req.headers && req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;
  return (await db.collection('users').findOne({ apiKey: token })) || null;
}

// The vector index name is DISCOVERED, not hardcoded. A wrong guess here would
// throw on every query, and a guessed constant is the kind of thing that works
// on one deploy and breaks on the next.
let _indexName = null;
async function vectorIndexName(db) {
  if (_indexName) return _indexName;
  if (process.env.OBJECTS_VECTOR_INDEX) return (_indexName = process.env.OBJECTS_VECTOR_INDEX);
  try {
    const idx = await db.collection('objects').listSearchIndexes().toArray();
    const v = idx.find(i => i.type === 'vectorSearch') || idx.find(i => /vector/i.test(i.name));
    if (v) return (_indexName = v.name);
  } catch (_) {}
  return (_indexName = 'objects_vector_index');
}

function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Word-boundary, not substring. "VDC" must not match "VDCX", and \b behaves
// badly around hyphens, so the boundaries are stated explicitly.
function wordRegex(q) {
  return new RegExp('(^|[^A-Za-z0-9_])' + escapeRegex(q) + '([^A-Za-z0-9_]|$)', 'i');
}

function histogram(scores) {
  if (!scores.length) return [];
  const lo = Math.min(...scores), hi = Math.max(...scores);
  const span = (hi - lo) || 1;
  const rows = Array.from({ length: BUCKETS }, () => 0);
  for (const s of scores) {
    let b = Math.floor(((s - lo) / span) * BUCKETS);
    if (b >= BUCKETS) b = BUCKETS - 1;
    if (b < 0) b = 0;
    rows[b]++;
  }
  return rows.map((n, i) => ({
    from: +(lo + (span * i) / BUCKETS).toFixed(4),
    to:   +(lo + (span * (i + 1)) / BUCKETS).toFixed(4),
    count: n,
    bar: '#'.repeat(Math.max(n ? 1 : 0, Math.round((n / Math.max(...rows)) * 40)))
  })).reverse();
}

module.exports = async function handler(req, res) {
  const started = Date.now();
  // STAGE TIMERS. Added after a 20.5s measurement was accepted as "the cost of
  // exhaustive scoring" and used to justify a redesign. The arithmetic is 46ms:
  // 35,234 x 3,072 float32 is a 433MB matrix-vector product, ~46ms in numpy.
  // A 450x gap is an IMPLEMENTATION problem wearing an ARCHITECTURE costume.
  // Never redesign a contract around an unattributed number again.
  const T = {}; let _m = Date.now();
  const mark = (k) => { T[k] = Date.now() - _m; _m = Date.now(); };
  const db = await getDb();
  mark('connect');
  // Use the SHARED auth from _lib/auth.js, not a private copy. ask.js had its own
  // inline authenticate() copied from objects.js, which only checked { apiKey: token }
  // and so REJECTED the very scoped key this door exists to serve (Aug 1 2026).
  // A second auth implementation is a second place to forget something.
  const user = await sharedAuth(req);
  if (!user) return res.status(401).json({ error: 'unauthorized' });

  const src = req.method === 'POST' ? (req.body || {}) : (req.query || {});
  const query = (src.query || src.q || '').toString().trim();
  if (!query) return res.status(400).json({ error: 'ask for something: ?q=...' });

  const take = Math.min(MAX_TAKE, Math.max(1, Number(src.take) || DEFAULT_TAKE));
  const scope = { userId: user._id };          // copied verbatim from associative.js
  const objects = db.collection('objects');

  const total = await objects.countDocuments(scope);
  mark('count_all');

  // ---- CHANNEL 1: LITERAL. No model. Exact. Never approximate. --------------
  const rx = wordRegex(query);
  const litFilter = { ...scope, content: { $regex: rx } };
  // EXPLAIN MODE (Aug 1 2026). ?explain=1 returns query plans instead of running
  // the full search. Plans are counters only -- docs examined, keys examined, ms,
  // index chosen. No pool content, so it is safe behind the same door.
  if (src.explain === '1' || src.explain === 'true') {
    const out = { what_this_is: 'query plans only -- no pool content returned' };
    try {
      out.literal_count_plan = await objects.find(litFilter)
        .explain('executionStats');
    } catch (e) { out.literal_count_plan = { error: String(e.message).slice(0, 300) }; }
    try {
      out.indexes = (await objects.indexes()).map(i => ({ name: i.name, key: i.key }));
    } catch (e) { out.indexes = { error: String(e.message).slice(0, 200) }; }
    try {
      const st = await db.command({ collStats: 'objects' });
      out.collection = {
        count: st.count, size_mb: +(st.size / 1e6).toFixed(1),
        avg_obj_bytes: st.avgObjSize,
        total_index_size_mb: +((st.totalIndexSize || 0) / 1e6).toFixed(1),
      };
    } catch (e) { out.collection = { error: String(e.message).slice(0, 200) }; }
    // WHERE DO 44,052 BYTES PER OBJECT GO? Averages over a sample, using
    // bsonSize so the numbers are actual stored bytes, not string lengths.
    // No content is returned -- only sizes.
    try {
      const agg = await objects.aggregate([
        { $match: { userId: user._id } },
        { $sample: { size: 300 } },
        { $project: {
            total:     { $bsonSize: '$$ROOT' },
            content:   { $bsonSize: { c: { $ifNull: ['$content', ''] } } },
            embedding: { $bsonSize: { c: { $ifNull: ['$embedding', []] } } },
            enrichment:{ $bsonSize: { c: { $ifNull: ['$enrichment', {}] } } },
            metadata:  { $bsonSize: { c: { $ifNull: ['$metadata', {}] } } },
            provenance:{ $bsonSize: { c: { $ifNull: ['$provenance', {}] } } },
            emb_len:   { $size: { $ifNull: ['$embedding', []] } },
        } },
        { $group: {
            _id: null, n: { $sum: 1 },
            total: { $avg: '$total' }, content: { $avg: '$content' },
            embedding: { $avg: '$embedding' }, enrichment: { $avg: '$enrichment' },
            metadata: { $avg: '$metadata' }, provenance: { $avg: '$provenance' },
            emb_len: { $avg: '$emb_len' }, emb_max: { $max: '$emb_len' },
            biggest: { $max: '$total' },
        } },
      ]).toArray();
      const a = agg[0] || {};
      const r = (x) => Math.round(x || 0);
      const pct = (x) => a.total ? +(((x || 0) / a.total) * 100).toFixed(1) : 0;
      out.where_the_bytes_go = {
        sampled: a.n,
        avg_total_bytes: r(a.total),
        biggest_seen_bytes: r(a.biggest),
        embedding_dims_avg: r(a.emb_len),
        embedding_dims_max: r(a.emb_max),
        breakdown: {
          embedding:  { bytes: r(a.embedding),  pct: pct(a.embedding) },
          content:    { bytes: r(a.content),    pct: pct(a.content) },
          enrichment: { bytes: r(a.enrichment), pct: pct(a.enrichment) },
          provenance: { bytes: r(a.provenance), pct: pct(a.provenance) },
          metadata:   { bytes: r(a.metadata),   pct: pct(a.metadata) },
          everything_else: {
            bytes: r(a.total - a.embedding - a.content - a.enrichment - a.metadata - a.provenance),
            pct: pct(a.total - a.embedding - a.content - a.enrichment - a.metadata - a.provenance),
          },
        },
      };
    } catch (e) { out.where_the_bytes_go = { error: String(e.message).slice(0, 300) }; }

    // BUILD THE COVERING INDEX. Explicit opt-in via &build_index=1 so that merely
    // asking for an explain can never mutate the database. background:true so the
    // collection stays writable while it builds -- the pacer and the organs are
    // running and must not be blocked.
    if (src.build_index === '1') {
      try {
        const t0 = Date.now();
        const name = await objects.createIndex(
          { userId: 1, content: 1 },
          { name: 'userId_1_content_1_covering', background: true }
        );
        out.index_build = { created: name, ms: Date.now() - t0,
          note: 'Re-run explain without build_index=1 to see whether the plan now ' +
                'reports IXSCAN alone with totalDocsExamined near 0. If it still ' +
                'FETCHes, the index is not covering the query and the regex needs a ' +
                'different shape -- do not assume it worked.' };
      } catch (e) {
        out.index_build = { error: String(e.message).slice(0, 400),
          note: 'A key-too-large or index-size error here is itself the answer: ' +
                'content is too big to index wholesale, and Chaos\'s design ' +
                '(normalized literal representation -> candidate generation -> exact ' +
                'byte verification) becomes the correct build after all.' };
      }
    }

    // MIGRATE A SLICE to binData float32. Opt-in via &migrate_f32=N so an explain
    // can never mutate anything. Resumable: it only touches objects that have an
    // `embedding` array and no `embedding_f32` yet, so re-running continues where
    // it stopped and finishing twice is harmless.
    if (src.migrate_f32) {
      const want = Math.min(2000, Math.max(1, Number(src.migrate_f32) || 500));
      const t0 = Date.now();
      const rep = { requested: want, converted: 0, skipped_bad_dims: 0, errors: 0 };
      try {
        const { Binary } = require('mongodb');
        const todo = await objects.find(
          { userId: user._id, embedding: { $type: 'array' }, embedding_f32: { $exists: false } },
          { projection: { embedding: 1 } }
        ).limit(want).toArray();
        rep.found = todo.length;

        const ops = [];
        for (const d of todo) {
          const v = d.embedding;
          if (!Array.isArray(v) || v.length !== 3072 || v.some(x => typeof x !== 'number' || !isFinite(x))) {
            rep.skipped_bad_dims++;
            continue;
          }
          ops.push({ updateOne: { filter: { _id: d._id },
            update: { $set: { embedding_f32: Binary.fromFloat32Array(new Float32Array(v)) } } } });
        }
        if (ops.length) {
          const r = await objects.bulkWrite(ops, { ordered: false });
          rep.converted = r.modifiedCount;
        }
        const remaining = await objects.countDocuments(
          { userId: user._id, embedding: { $type: 'array' }, embedding_f32: { $exists: false } });
        rep.remaining = remaining;
        rep.done = remaining === 0;
      } catch (e) {
        rep.errors++; rep.error = String(e.message).slice(0, 400);
      }
      rep.ms = Date.now() - t0;
      rep.note = rep.done
        ? 'All objects now carry embedding_f32. NEXT: create a SECOND vector index on ' +
          'embedding_f32 (3072 dims, cosine), wait for it to build, point ask.js at it, ' +
          'and measure. The original `embedding` field is untouched, so the live index ' +
          'and every existing query still work exactly as before.'
        : 'Slice done. Call again with the same parameter to continue. Nothing is ' +
          'overwritten and re-running is safe.';
      out.migrate_f32 = rep;
    }

    // SIZE COMPARISON once both fields exist -- proves the saving rather than
    // assuming it. Sizes only, no content.
    if (src.compare_size === '1') {
      try {
        const a = await objects.aggregate([
          { $match: { userId: user._id, embedding_f32: { $exists: true } } },
          { $sample: { size: 200 } },
          { $project: {
              old_bytes: { $bsonSize: { c: { $ifNull: ['$embedding', []] } } },
              new_bytes: { $bsonSize: { c: { $ifNull: ['$embedding_f32', null] } } } } },
          { $group: { _id: null, n: { $sum: 1 },
              old: { $avg: '$old_bytes' }, new: { $avg: '$new_bytes' } } },
        ]).toArray();
        const x = a[0] || {};
        out.size_comparison = {
          sampled: x.n,
          array_bytes: Math.round(x.old || 0),
          bindata_bytes: Math.round(x.new || 0),
          shrink_factor: x.new ? +((x.old || 0) / x.new).toFixed(2) : null,
        };
      } catch (e) { out.size_comparison = { error: String(e.message).slice(0, 300) }; }
    }

    // CREATE THE VECTOR INDEX ON embedding_f32. Explicit opt-in. Creating it does
    // NOT switch anything -- ask.js keeps using the old index until &use_f32=1 is
    // passed, so this is safe to run while the system is live.
    if (src.build_vector_index === '1') {
      try {
        const name = await objects.createSearchIndex({
          name: 'objects_vector_f32',
          type: 'vectorSearch',
          definition: { fields: [
            { type: 'vector', path: 'embedding_f32', numDimensions: 3072, similarity: 'cosine' },
            { type: 'filter', path: 'userId' },
          ] },
        });
        out.vector_index_build = { created: name,
          note: 'Building is ASYNCHRONOUS. Re-run explain to watch status until it ' +
                'reports READY, then compare with &use_f32=1. Nothing has switched.' };
      } catch (e) {
        out.vector_index_build = { error: String(e.message).slice(0, 400) };
      }
    }

    // Status of every search index, so "is it ready yet" is answerable.
    try {
      out.search_indexes = (await objects.listSearchIndexes().toArray()).map(i => ({
        name: i.name, status: i.status, queryable: i.queryable,
        path: i.latestDefinition?.fields?.[0]?.path,
      }));
    } catch (e) { out.search_indexes = { error: String(e.message).slice(0, 200) }; }

    // RESTORE THE SINGLE-INDEX BASELINE. Drops the float32 search index first, then
    // the field -- in that order, because a search index whose source field has been
    // removed is not a supported serving state.
    if (src.drop_f32 === '1') {
      const rep = {};
      try {
        await objects.dropSearchIndex('objects_vector_f32');
        rep.index_dropped = 'objects_vector_f32';
      } catch (e) { rep.index_error = String(e.message).slice(0, 300); }
      try {
        const r = await objects.updateMany(
          { userId: user._id, embedding_f32: { $exists: true } },
          { $unset: { embedding_f32: '' } });
        rep.fields_unset = r.modifiedCount;
        rep.remaining = await objects.countDocuments(
          { userId: user._id, embedding_f32: { $exists: true } });
      } catch (e) { rep.field_error = String(e.message).slice(0, 300); }
      rep.note = 'Baseline restored: one vector field, one vector index. Now re-run ' +
        'the ORIGINAL array query. If enn_scan returns to its earlier 12-70s range, ' +
        'the second index was causing contention and the binData result was ' +
        'confounded. If it stays degraded, something else changed and the ' +
        'representation was never the variable.';
      out.drop_f32 = rep;
    }

    // WHAT THE SEARCH INDEXES ACTUALLY COST. The number never measured: collection
    // storage is not scoring-matrix size, and conflating them is what produced the
    // wrong conclusion.
    if (src.index_sizes === '1') {
      try {
        out.index_sizes = (await objects.listSearchIndexes().toArray()).map(i => ({
          name: i.name, status: i.status, queryable: i.queryable,
          path: i.latestDefinition?.fields?.[0]?.path,
          indexed_docs: i.statusDetail?.[0]?.mainIndex?.definitionVersion ? undefined : undefined,
          detail: i.statusDetail ? JSON.stringify(i.statusDetail).slice(0, 600) : null,
        }));
      } catch (e) { out.index_sizes = { error: String(e.message).slice(0, 300) }; }
    }

    out.read_this =
      'If totalDocsExamined is near the collection count and the winning plan is ' +
      'COLLSCAN, the regex is reading every document -- INCLUDING its 12KB embedding -- ' +
      'to test a text field. That is ~447MB dragged through memory for words. The fix ' +
      'is then a COVERING index on {userId, content}, which needs no analyzer and ' +
      'trades no exactness. If a plausible index IS already being used and it is still ' +
      'slow, the problem is elsewhere and Atlas Search candidate-generation plus exact ' +
      'byte verification is the right build.';
    return res.status(200).json(out);
  }

  const literalCount = await objects.countDocuments(litFilter);
  mark('literal_count');   // SUSPECT: unanchored regex = full collection scan
  const literalDocs = await objects.find(litFilter)
    .project({ embedding: 0 })
    .sort({ timestamp: -1 })
    .limit(take)
    .toArray();
  mark('literal_find');    // SUSPECT: sort on timestamp -- indexed?

  // ---- CHANNEL 2: NEAR. Exhaustive (ENN), never ANN. -----------------------
  // Stage 1 projects ONLY _id and score -- no bodies, no vectors. That is what
  // makes scoring the entire pool affordable: ~40 bytes per object instead of
  // ~12KB. The distribution needs every score; it does not need every document.
  let allScores = [], nearRanked = [], semanticState = 'ok', semanticNote = null;

  if (total > ENN_CEILING) {
    semanticState = 'refused';
    semanticNote = `pool is ${total} objects, above the exhaustive ceiling of ${ENN_CEILING}. ` +
      `Rather than quietly narrow the search, the semantic channel declined. The literal ` +
      `channel below is unaffected and is still exact.`;
  } else {
    const e = await embed(query, 'large');     // objects are embedded with large
    mark('embed_query');   // network round trip to OpenAI
    if (!e || !e.embedding) {
      semanticState = 'unavailable';
      semanticNote = 'the embedding provider did not answer, so NOTHING was scored by meaning. ' +
        'This is not "no matches" -- it is "not measured." The literal channel is unaffected ' +
        'because it needs no model at all.';
    } else {
      try {
        // HEAD-TO-HEAD: &use_f32=1 runs the identical query against the binData
        // index instead of the array one. Same vectors, same dimensions, same
        // similarity -- the ONLY difference is how many bytes must be read to
        // score them. That isolates storage from everything else.
        const useF32 = (src.use_f32 === '1');
        const idx = useF32 ? 'objects_vector_f32' : await vectorIndexName(db);
        const vpath = useF32 ? 'embedding_f32' : 'embedding';
        allScores = await objects.aggregate([
          { $vectorSearch: {
              index: idx, path: vpath, queryVector: e.embedding,
              exact: true,                    // ENN: every indexed vector, no candidate pool
              limit: Math.max(total, 1),
              filter: { userId: user._id }
          } },
          { $project: { _id: 1, score: { $meta: 'vectorSearchScore' } } }
        ], { allowDiskUse: true }).toArray();
        mark('enn_scan');  // THE ONE WE BLAMED FOR ALL 20 SECONDS

        const ids = allScores.slice(0, take).map(r => r._id);
        const bodies = await objects.find({ _id: { $in: ids } })
          .project({ embedding: 0 }).toArray();
        mark('fetch_bodies');
        const byId = new Map(bodies.map(b => [b._id.toString(), b]));
        nearRanked = allScores.slice(0, take)
          .map(r => ({ score: r.score, doc: byId.get(r._id.toString()) }))
          .filter(x => x.doc);
      } catch (err) {
        semanticState = 'failed';
        semanticNote = `exhaustive vector search errored: ${err.message}. NOTHING was scored by ` +
          `meaning. Treat this as unmeasured, not as absent.`;
      }
    }
  }

  const scored = allScores.length;
  const complete = semanticState === 'ok' && scored >= total;

  const strip = d => d && ({
    id: d._id, timestamp: d.timestamp, speaker: d.speaker,
    source_type: d.source_type, content: d.content
  });

  return res.status(200).json({
    query,
    pool: { objects: total, scored, complete },

    // Promise 6: never let silence imply absence.
    completeness: complete
      ? `Every one of the ${total} objects was scored. Nothing was dropped and nothing was ranked away.`
      : `NOT EXHAUSTIVE -- ${scored} of ${total} scored by meaning (${semanticState}). ` +
        `Do NOT read a thin result as an empty pool.`,

    // Promise 4: two numbers, never one.
    literal: {
      channel: 'exact word-boundary match, no model involved',
      in_the_pool: literalCount,
      over_the_wall: literalDocs.length,
      more_out_there: Math.max(0, literalCount - literalDocs.length),
      hits: literalDocs.map(strip)
    },

    vector_path: (src.use_f32 === '1') ? 'embedding_f32 (binData)' : 'embedding (array)',
    near: {
      channel: 'exhaustive nearest-neighbour (ENN) over every indexed vector',
      state: semanticState,
      note: semanticNote,
      // Promise 2: the shape of the WHOLE pool, before any cut.
      distribution: histogram(allScores.map(r => r.score)),
      over_the_wall: nearRanked.length,
      more_out_there: Math.max(0, scored - nearRanked.length),
      hits: nearRanked.map(r => ({ score: +r.score.toFixed(4), ...strip(r.doc) }))
    },

    // Promise 3: the cut is the caller's, and it is stated out loud.
    cut: {
      take,
      set_by: 'you',
      note: `You asked for ${take}. That is the only reason ${take} came back. ` +
            `Ask for more with &take=N (max ${MAX_TAKE}).`
    },

    ms: Date.now() - started,

    // Where the time actually went. Read this before drawing any conclusion
    // about what exhaustive scoring costs.
    timing_ms: T,
    timing_note:
      'Pure arithmetic for 35,234 x 3,072 float32 is ~46ms measured in numpy. ' +
      'Anything far above that in enn_scan is storage, deserialization or transport, ' +
      'NOT the cost of scoring. If literal_count or literal_find dominate, the ' +
      'bottleneck is an unindexed regex scan and has nothing to do with vectors.',

    door_notice: {
      door: 'ask',
      answers: 'WHAT IS IN THE POOL, SCORED WHOLE -- and how much of it you chose not to look at.',
      contract: [
        'scores everything; no k, no threshold, no rank-and-truncate',
        'reports the distribution before any cut',
        'the cut is yours and is printed',
        'near and literal are never blended into one number',
        'always says how many more are out there',
        'if it could not finish, it says so'
      ],
      read_this:
        'This door does the geometry and refuses to do the editing. It cannot decide what ' +
        'not to show you. If a result looks thin, read `completeness` and `more_out_there` ' +
        'BEFORE concluding anything is absent -- a small answer here is a small ASK, not a ' +
        'small pool.'
    }
  });
};
