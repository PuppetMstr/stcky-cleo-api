// reflect-mode.js — feed-and-reflect read for the associative door.
// "The pool answers the pour." Steven + Eli, Jul 22 2026.
//
// Called from associative.js when mode=reflect. rankFn(query, {offset, depth})
// is the EXISTING resolved pipeline returning { objects: [...] }. No self-HTTP.
// No tenant shapes: classification is by source_type only — never by name.

const STOP = new Set(("a an and are as at be been but by for from had has have he her his i if in " +
  "is it its me my no not of on or our so that the their them they this to was we were what when " +
  "where which who will with you your yours am do does did being just about into over under out up down")
  .split(" "));

const conversational = (o) => o && o.source_type === "conversation";

function proseLines(content) {
  return (content || "").split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0
      && !/^[\w\-. ]{1,14}:\s/.test(l)              // machine "key   : value" rows
      && !(l.startsWith("[") && l.endsWith("]")));
}

function tokens(s) {
  return (s.toLowerCase().match(/[a-z][a-z\-@.']+/g) || [])
    .filter((t) => t.length > 2 && !STOP.has(t));
}

// The pool's own sentences, rarity-scored. Seeds come from conversation
// objects when any exist; the caller's vocabulary is never involved.
function raritySeeds(objects, maxSeeds = 6) {
  const pool = objects.filter(conversational);
  const src = pool.length ? pool : objects;
  const df = new Map();
  for (const o of src) {
    for (const t of new Set(proseLines(o.content).flatMap(tokens))) {
      df.set(t, (df.get(t) || 0) + 1);
    }
  }
  const scored = [];
  for (const o of src) {
    for (const line of proseLines(o.content)) {
      for (const s of line.split(/(?<=[.!?])\s+/)) {
        const toks = tokens(s);
        if (s.length < 16 || toks.length < 3) continue;
        const score = toks.reduce((a, t) => a + 1 / (df.get(t) || 1), 0) / toks.length;
        scored.push([score, s.slice(0, 120)]);
      }
    }
  }
  scored.sort((a, b) => b[0] - a[0]);
  const seeds = [], seen = new Set();
  for (const [, s] of scored) {
    const k = [...new Set(s.toLowerCase().match(/\w+/g) || [])].sort().join(" ").slice(0, 80);
    if (seen.has(k)) continue;
    seen.add(k);
    seeds.push(s);
    if (seeds.length >= maxSeeds) break;
  }
  return seeds;
}

/**
 * reflectRead — hop 1 feeds the turn VERBATIM (plus walk depth), hop 2
 * reflects on the pool's own sentences, concurrently, then returns one
 * activation-ranked field: conversation stratum first, machine stratum after.
 */
async function reflectRead(turn, rankFn, opts = {}) {
  const { maxHops = 2, dieRatio = 0.2, depthPages = 3, pageSize = 10,
          maxSeeds = 6, budgetMs = 8000, thinField = 15, maxFeedPages = 5 } = opts;
  const t0 = Date.now();
  const field = new Map();       // id -> object
  const activation = new Map();  // id -> score
  const hopFound = new Map();    // id -> first hop

  const absorb = (resp, hop) => {
    let added = 0;
    ((resp && resp.objects) || []).forEach((o, rank) => {
      const id = String(o._id);
      const w = (10 - Math.min(rank, 9)) * (hop === 1 ? 2 : 1);
      activation.set(id, (activation.get(id) || 0) + w);
      if (!field.has(id)) { field.set(id, o); hopFound.set(id, hop); added++; }
    });
    return added;
  };

  // HOP 1 — FEED: verbatim turn, walking depthPages into the ranked pool.
  // Jul 22 lesson (certified-mail record found on page 3): if the field comes
  // back thin, keep walking — the answer is often below the first pages.
  let page = 0;
  while (page < depthPages || (field.size < thinField && page < maxFeedPages)) {
    if (Date.now() - t0 > budgetMs) break;
    try {
      const added = absorb(await rankFn(turn, { offset: page * pageSize }), 1);
      page++;
      if (page >= depthPages && added === 0) break; // pool exhausted for this query
    } catch (e) {
      console.log('[REFLECT] feed page failed:', e.message);
      break;
    }
  }

  // HOP 2+ — REFLECT: seeds are the pool's sentences, run concurrently.
  let prevCount = field.size;
  const hops = [];
  for (let hop = 2; hop <= maxHops; hop++) {
    if (Date.now() - t0 > budgetMs) break;
    const seeds = raritySeeds([...field.values()], maxSeeds);
    if (!seeds.length) break;
    const results = await Promise.all(seeds.map((s) => rankFn(s, {}).catch((e) => {
      console.log('[REFLECT] seed failed:', e.message);
      return null;
    })));
    const added = results.reduce((a, r) => a + absorb(r, hop), 0);
    hops.push({ hop, seeds, added, spread: Math.round(100 * added / Math.max(prevCount, 1)) / 100 });
    if (added / Math.max(prevCount, 1) < dieRatio) break;
    prevCount = field.size;
  }

  const byRank = (a, b) => (activation.get(String(b._id)) - activation.get(String(a._id)))
    || String(a.timestamp || "").localeCompare(String(b.timestamp || ""));
  const all = [...field.values()];
  const objects = [...all.filter(conversational).sort(byRank),
                   ...all.filter((o) => !conversational(o)).sort(byRank)]
    .map((o) => ({ ...o, _reflect: { activation: activation.get(String(o._id)), hop: hopFound.get(String(o._id)) } }));

  return {
    mode: "reflect",
    query: turn,
    objects,
    objects_count: objects.length,
    hops,
    elapsed_ms: Date.now() - t0,
    read_this: "Field is activation-ranked, conversation stratum first. Hop 1 = " +
      "the turn verbatim; later hops were seeded by the pool's own sentences. " +
      "Attend to the whole field — do not conclude absence from a fragment.",
  };
}

module.exports = { reflectRead, raritySeeds };
