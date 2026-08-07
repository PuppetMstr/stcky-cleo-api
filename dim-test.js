// cleo-api/dim-test.js
// ---------------------------------------------------------------------------
// ONE-SHOT MEASUREMENT (Aug 1 2026). DELETE AFTER USE.
//
// THE QUESTION: /api/ask now takes 33-69 seconds, and it is the only door Eli
// has, so its speed is the speed of everything. Stage timings show the cost is
// I/O, not arithmetic -- enn_scan swung 12,096ms -> 64,004ms across three runs
// of the SAME query on the SAME data, and the pure matrix-vector math for
// 36,345 x 3,072 float32 measures 46ms in numpy. A 5.3x swing on identical
// computation is disk and deserialization, not distance.
//
// Bytes read per query, which is the actual lever:
//     3072 dims -> 447 MB     1024 -> 149 MB     512 -> 75 MB
//
// BUT LATENCY ALONE CANNOT JUSTIFY THE CHANGE. Chaos, Jul 31: "I would expect
// 3,072 dimensions to be unnecessary for many conversation-retrieval workloads,
// but that must be established by RECALL measurements, not latency measurements
// from two unrelated systems."
//
// WHAT THIS MEASURES: text-embedding-3 models are Matryoshka-trained, so asking
// for fewer dimensions is a principled truncation rather than a different model.
// This embeds the SAME sampled objects at 3072, 1024 and 512, runs the SAME
// queries against each, and reports whether the RANKINGS AGREE.
//
//   If the top-10 at 512 is essentially the top-10 at 3072, those dimensions
//   were carrying nothing this pool uses, and the change is free.
//   If it scrambles, they were carrying something, and 6x latency is the price
//   of keeping it.
//
// Nothing is written and nothing is re-indexed. It reads a sample, embeds it in
// memory, and reports. Runs entirely on the server because that is where
// OPENAI_API_KEY lives -- no credential moves anywhere.
// ---------------------------------------------------------------------------
'use strict';

const OWNER = 'cleo_eb2eaecd66f004eb0d25361675c5d637';

// NO DATABASE HANDLE HERE, DELIBERATELY.
// The first version of this file did db.collection('objects').find(...) -- a raw
// query straight into the pool, written FORTY MINUTES AFTER the wall went up.
// Steven caught it: "Are you pulling corpus samples directly?" Yes, it was.
//
// A measurement is not an exemption. If the rule is that pool content comes
// through the guardian, it comes through the guardian even when the caller has
// a good reason and even when the caller is the one who built the wall. That is
// the whole difference between a rule and a preference.
//
// So the corpus below is drawn through /api/ask like anything else. The ONE thing
// that genuinely cannot go through that door is embedding at four different
// dimensions, because that needs OPENAI_API_KEY and there is no door for it --
// that is a new capability, not a retrieval path, which is why it lives here.

const DIMS = [3072, 1024, 512, 256];
const QUERIES = [
  'capture stopped and nobody noticed',
  'what did Sharon run into',
  'how much does a Guardian check cost',
  'Paul cannot get to the site',
  'why the search is slow',
  'the wall and the guardian',
  'money owed and when it is due',
  'what did Chaos say was wrong',
];

async function embedBatch(texts, dims) {
  const r = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'text-embedding-3-large',
      input: texts.map(t => (t || '').slice(0, 8000)),
      dimensions: dims,
    }),
  });
  if (!r.ok) throw new Error('embed ' + dims + ' -> ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const j = await r.json();
  return j.data.map(d => d.embedding);
}

function cosine(a, b) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/** Jaccard overlap of two id sets -- "did we retrieve the same things at all". */
function overlap(a, b) {
  const sa = new Set(a), sb = new Set(b);
  let hit = 0;
  for (const x of sa) if (sb.has(x)) hit++;
  return hit / (sa.size || 1);
}

/** Did the #1 result survive? The single most consequential position. */
function topOne(a, b) { return a[0] === b[0]; }

module.exports = async (req, res) => {
  if (req.query.secret !== OWNER) return res.status(401).json({ error: 'unauthorized' });
  if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY not set' });

  const started = Date.now();
  const sample = Math.min(400, Math.max(50, Number(req.query.sample) || 250));
  const K = Math.min(20, Math.max(3, Number(req.query.k) || 10));

  // CORPUS THROUGH THE GUARDIAN. Several unrelated asks so the sample spans
  // topics rather than clustering on one, deduped by object id.
  const seeds = [
    'capture', 'Guardian cost', 'Sharon', 'Paul', 'money owed',
    'the wall', 'vectors and dimensions', 'letters sent',
  ];
  const seen = new Map();
  const seedReport = [];
  for (const q of seeds) {
    try {
      const r = await fetch('https://api.stcky.ai/api/ask?q=' + encodeURIComponent(q) + '&take=40',
        { headers: { Authorization: 'Bearer ' + OWNER } });
      if (!r.ok) { seedReport.push({ q, error: r.status }); continue; }
      const j = await r.json();
      const hits = [...(j.near?.hits || []), ...(j.literal?.hits || [])];
      for (const h of hits) if (h && h.content) seen.set(String(h.id), h);
      seedReport.push({ q, returned: hits.length, running_total: seen.size });
    } catch (e) { seedReport.push({ q, error: String(e.message).slice(0, 80) }); }
    if (seen.size >= sample * 2) break;
  }

  const corpus = [...seen.values()].filter(d => (d.content || '').length > 120).slice(0, sample);
  if (corpus.length < 20) return res.status(500).json({ error: 'not enough corpus', got: corpus.length });

  const texts = corpus.map(d => d.content);

  // Embed the corpus once per dimension. Batched to stay inside request limits.
  const byDim = {};
  for (const dims of DIMS) {
    const t0 = Date.now();
    const out = [];
    for (let i = 0; i < texts.length; i += 96) {
      out.push(...await embedBatch(texts.slice(i, i + 96), dims));
    }
    byDim[dims] = { vecs: out, embed_ms: Date.now() - t0 };
  }

  // Queries embedded at each dimension too -- a query vector only means anything
  // in the space its corpus lives in.
  const qByDim = {};
  for (const dims of DIMS) qByDim[dims] = await embedBatch(QUERIES, dims);

  const base = DIMS[0];
  const results = {};

  for (const dims of DIMS) {
    const agree = [], top1 = [], perQuery = [];
    for (let qi = 0; qi < QUERIES.length; qi++) {
      const rank = (d) => byDim[d].vecs
        .map((v, i) => ({ i, s: cosine(v, qByDim[d][qi]) }))
        .sort((a, b) => b.s - a.s).slice(0, K).map(x => x.i);
      const r0 = rank(base), rd = rank(dims);
      const ov = overlap(r0, rd);
      agree.push(ov);
      top1.push(topOne(r0, rd) ? 1 : 0);
      perQuery.push({ query: QUERIES[qi], overlap: +(ov * 100).toFixed(1), top1_same: topOne(r0, rd) });
    }
    results[dims] = {
      bytes_per_query_mb: +((36345 * dims * 4) / 1e6).toFixed(1),
      mean_topK_overlap_pct: +((agree.reduce((a, b) => a + b, 0) / agree.length) * 100).toFixed(1),
      top1_preserved_pct: +((top1.reduce((a, b) => a + b, 0) / top1.length) * 100).toFixed(1),
      embed_ms: byDim[dims].embed_ms,
      per_query: perQuery,
    };
  }

  res.json({
    what_this_is: 'Recall comparison across embedding dimensions on REAL pool objects. ' +
      'Nothing was written and nothing re-indexed.',
    corpus_objects: corpus.length,
    corpus_source: 'drawn through /api/ask -- the guardian -- not by raw query',
    seed_asks: seedReport,
    top_k: K,
    baseline_dims: base,
    results,
    how_to_read:
      'mean_topK_overlap_pct is how much of the 3072-dim top-K survives at each smaller ' +
      'dimension. High overlap means those extra dimensions were carrying nothing this ' +
      'pool uses, and shrinking is free. top1_preserved_pct is the strictest test: did the ' +
      'single best answer stay the best. A dimension that keeps top-1 but reshuffles ranks ' +
      '4-10 is usually fine for retrieval; one that moves top-1 is not.',
    caveat:
      'The corpus is what the guardian returned for eight seed asks, so it is biased toward ' +
      'objects those asks reach -- representative of things we actually search for, not of ' +
      'the whole 36k pool. It also measures AGREEMENT WITH 3072, NOT TRUTH: if 3072 is itself ' +
      'wrong about something, a smaller dimension agreeing with it is not evidence of ' +
      'correctness. This answers "are we paying 6x for nothing", not "is our retrieval good".',
    ms: Date.now() - started,
  });
};
