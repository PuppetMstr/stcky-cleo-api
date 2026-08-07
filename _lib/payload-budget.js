/**
 * STCKY — PAYLOAD BUDGET. The honest-door primitive.
 * C:\Stcky\cleo-api\_lib\payload-budget.js
 *
 * Built Jul 18 2026 by Eli, closing owed item (b) from the Jul 12 door doctrine.
 * Tested against the July 12 failure shape before it shipped (642 KB in,
 * 64 KB out, honest counts, notice first).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * On July 12 2026 the associative door shipped a 652 KB response at a reader
 * whose platform caps responses near 100 KB. OpenAI's layer chopped the JSON
 * wherever it happened to land — mid-string, inside an unrelated memory about a
 * mortgage — and Chaos received a fragment that looked like a whole document.
 * He refused it three times and was right three times.
 *
 * The lesson was written that day as canon:
 *
 *      A FRAGMENT MUST NEVER BE ABLE TO PASS AS A WHOLE.
 *
 * But the fix was never built. Six truncation sites were repaired downstream;
 * nothing ever measured what this door SHIPS. So the door could still, today,
 * hand a reader more than the reader can hold — and the cut would happen
 * somewhere we do not control, silently, with no id and no notice.
 *
 * THE RULE THIS ENFORCES: never ship more than a reader can hold, and when
 * something must be left out, SAY SO IN THE TEXT THE MODEL READS — not in a
 * JSON field it may skip.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE THREE GUARANTEES (door doctrine, Jul 12) — how each is honored here
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. WHOLE OR LOUD.   Trimming writes `_NOTICE` as the FIRST key of the
 *                     response, in plain prose. A model reading top-down hits
 *                     it before any data. Every shortened item also carries its
 *                     own in-band banner inside its own text field.
 * 2. REDEEMABLE.      Every dropped or shortened item is listed by ID with the
 *                     exact call that returns it whole. An id is a promise the
 *                     house keeps.
 * 3. ABSENCE IS EARNED. A trimmed response NEVER looks like a complete one.
 *                     Counts report what was FOUND as well as what was
 *                     RETURNED, so a reader can never mistake a trim for the
 *                     end of the pool.
 *
 * DROP ORDER IS DELIBERATE: lowest-ranked first, from the tail. The arrays
 * arrive best-first, so the reader keeps the strongest material and loses the
 * weakest — the opposite of a blind byte-cut, which keeps whatever happened to
 * be early and destroys whatever happened to be at the knife.
 *
 * COLLECTION ORDER IS ALSO DELIBERATE, AND IT CHANGED THE DAY IT WAS BUILT:
 * candidates first (they duplicate memories+objects in the v3 pipeline), then
 * events, then MEMORIES, and RAW OBJECTS LAST. Curated memories are summaries;
 * raw objects are the record. Steven's ruling that morning — "one hundred
 * percent of everything that we discuss goes into STCKY raw" — makes the raw
 * the thing worth protecting when something has to go.
 */

// The smallest reader we know of is a ChatGPT Custom GPT Action, capped near
// 100 KB. Budget well under it: the platform wraps our JSON in its own
// envelope, and a budget that only just fits is a budget that does not fit.
const DEFAULT_MAX_BYTES = 70000;

// ===========================================================================
// STRIP THE VECTORS BEFORE MEASURING ANYTHING. Added Jul 21 2026, on Steven:
// "I thought we wrote into it that we no longer would do slices through the
// doors. How did that start again?"
//
// It never started again. It never stopped -- and this is why.
//
// MEASURED THIS MORNING ON THE LIVE DOOR, query "DMARC", limit 10:
//
//     total payload ............ 674,005 bytes
//     of which raw embeddings ..  635,993 bytes   (94%)
//     of which actual content ..    8,833 bytes   (1%)
//     after stripping vectors ..   37,862 bytes   -- FITS THE 70 KB CEILING WHOLE
//
// Mongo hands back the whole document, embedding field included. Nothing in
// this pipeline reads that field after the search is done -- the vectors did
// their work inside the database, in-process, before this code ever runs. They
// then rode all the way out the door as 1,536 floats spelled out in decimal,
// per record, and blew a 70 KB ceiling by seventeen times.
//
// So the budget did exactly what it was built to do: it dropped the lowest-
// ranked items to fit. Twenty-two real records, on Steven's own question,
// sacrificed to make room for numbers no reader has ever read.
//
// THAT is the slicing. Not a philosophy problem. Not reader discipline. A
// field nobody wants, priced at 94% of every answer, paid for in records.
//
// This runs FIRST, before a single byte is counted, at the one chokepoint both
// doors pass through -- so it cannot be forgotten by a future door, and it
// cannot regress one door at a time. A wall, not a promise. Same treatment as
// the 410 on marker writes, which is the only fix in this system's history
// that ever held.
// ===========================================================================
const VECTOR_FIELDS = [
  'embedding', 'embedding_small', 'embedding_large',
  'vector', 'contentVector', 'valueVector', 'plot_embedding',
];

function stripVectors(response) {
  let removed = 0;
  let bytesFreed = 0;

  const scrub = (item) => {
    if (!item || typeof item !== 'object') return;
    for (const f of VECTOR_FIELDS) {
      if (item[f] !== undefined) {
        try { bytesFreed += Buffer.byteLength(JSON.stringify(item[f]), 'utf8'); } catch (e) {}
        delete item[f];
        removed++;
      }
    }
    // Nested payloads (v3 candidates carry the source doc under payload/meta).
    if (item.payload && typeof item.payload === 'object') scrub(item.payload);
    if (item.meta    && typeof item.meta    === 'object') scrub(item.meta);
  };

  for (const k of Object.keys(response)) {
    const v = response[k];
    if (Array.isArray(v)) v.forEach(scrub);
    else if (v && typeof v === 'object') scrub(v);
  }

  return { removed, bytesFreed };
}

// No single item may occupy more than this share of the budget. Without it one
// enormous object starves everything else and the response becomes a single
// document pretending to be a search result.
const MAX_SINGLE_ITEM_SHARE = 0.35;

// ===========================================================================
// NEVER SHIP A BODY TWICE. NEVER DROP THE ONLY COPY. Added Jul 21 2026, right
// after the vector strip, on Steven: "costing us."
//
// MEASURED ON THE LIVE DOOR, post-vector-strip, query "one door in one door
// out everything raw", limit 10:
//
//     candidates ............... 43,618 bytes
//       of which .payload ......  31,209 bytes   (72% of the array)
//     objects .................. 36,862 bytes
//
// candidates[].payload is BYTE-IDENTICAL to objects[].content. Verified on
// every record: 10 of 10 matched by meta.legacy_id, string-equal. The v3
// pipeline builds a canonical view of the same documents it already returns in
// the legacy arrays, and both go out the door. The response pays twice for the
// same words, then drops the tail of the result to afford it.
//
// So the trim was eating REAL RECORDS to pay for a second copy of records it
// was already carrying. Same disease as the embeddings, one layer up.
//
// THE RULE, AND IT CUTS BOTH WAYS:
//   * If the body is already in this response under its own id, the candidate
//     carries a POINTER instead of a copy.
//   * If it is NOT -- a kind that has no legacy array, or a record the trim
//     already dropped -- the candidate KEEPS THE BODY. A dedupe that removes
//     the last copy of something is just truncation wearing a clean shirt, and
//     that is the exact thing the Jul 12 doctrine exists to forbid.
//
// The pointer is in-band and redeemable: it names the array and the id where
// the whole body is sitting, in this same response. Nobody has to fetch
// anything to honor it.
// ===========================================================================
function dedupeBodies(response) {
  const candidates = response.candidates;
  if (!Array.isArray(candidates) || !candidates.length) {
    return { deduped: 0, bytesFreed: 0 };
  }

  // Everything whose whole body is present in THIS response, by id.
  const present = new Map();   // id -> which array it is sitting in
  for (const [key, field] of [['objects', 'content'], ['memories', 'value']]) {
    const arr = response[key];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;
      const id = String(item._id || item.id || '');
      if (!id) continue;
      if (typeof item[field] === 'string' && item[field].length) present.set(id, key);
    }
  }
  if (!present.size) return { deduped: 0, bytesFreed: 0 };

  let deduped = 0;
  let bytesFreed = 0;

  for (const c of candidates) {
    if (!c || typeof c !== 'object') continue;
    if (typeof c.payload !== 'string' || !c.payload.length) continue;

    const id = String((c.meta && c.meta.legacy_id) || '');
    const where = id && present.get(id);
    if (!where) continue;                 // the only copy. Leave it alone.

    bytesFreed += Buffer.byteLength(c.payload, 'utf8');
    c.payload = null;
    c.body_is_at = { array: where, id: id };
    c.body_note =
      'BODY NOT REPEATED. The whole, uncut body of this record is in this same ' +
      'response under ' + where + '[] where _id = ' + id + '. Nothing was ' +
      'dropped or shortened -- it is simply not printed twice.';
    deduped++;
  }

  return { deduped, bytesFreed };
}


function bytes(v) {
  return Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v), 'utf8');
}

/**
 * Shorten one long text field, loudly and redeemably.
 * The banner goes INSIDE the returned text so a reader cannot miss it, and
 * names the call that redeems the rest.
 */
function shortenField(text, keepBytes, id) {
  const full = String(text || '');
  const fullLen = Buffer.byteLength(full, 'utf8');
  if (fullLen <= keepBytes) return { text: full, shortened: false, fullLen };

  // Cut on a character boundary, then back up to the last newline so we do not
  // end mid-sentence if we can help it.
  let cut = Buffer.from(full, 'utf8').slice(0, keepBytes).toString('utf8');
  const lastBreak = cut.lastIndexOf('\n');
  if (lastBreak > keepBytes * 0.6) cut = cut.slice(0, lastBreak);

  const missing = fullLen - Buffer.byteLength(cut, 'utf8');
  const banner =
    '\n\n' +
    '  !! ---- SHORTENED BY THE PAYLOAD BUDGET ---- !!\n' +
    '  !! ' + Buffer.byteLength(cut, 'utf8') + ' of ' + fullLen + ' bytes. ' + missing + ' BYTES ARE MISSING.\n' +
    '  !! YOU HAVE NOT READ THIS ITEM. Do not conclude from it. Do not call it absent.\n' +
    (id ? '  !! REDEEM IT WHOLE:  GET /v1/object/' + id + '\n' : '') +
    '  !! ------------------------------------------ !!';

  return { text: cut + banner, shortened: true, fullLen, returnedLen: Buffer.byteLength(cut, 'utf8') };
}

/**
 * Enforce the budget on an associative/read response.
 *
 * @param {object} response  the assembled response object
 * @param {object} opts
 *        maxBytes    {number}   hard ceiling, default 70000
 *        arrays      {string[]} response keys holding rankable arrays,
 *                               in DROP PRIORITY ORDER (first = dropped first)
 *        textFieldOf {function} (item, arrayKey) => the long text field name
 *        idOf        {function} (item) => a redeemable id string
 * @returns {object} the response, trimmed, with _NOTICE and payload_budget
 *                   added when anything was cut.
 */
function enforcePayloadBudget(response, opts = {}) {
  const maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES;
  const arrayKeys = opts.arrays || ['candidates', 'events', 'memories', 'objects'];
  const textFieldOf = opts.textFieldOf || defaultTextField;
  const idOf = opts.idOf || defaultId;

  // ---- PASS 0: THROW AWAY WHAT NOBODY READS, BEFORE COUNTING ANYTHING ----
  // A record must never be dropped to make room for a vector. See the block
  // above stripVectors() for the measurement that forced this.
  const vectors = stripVectors(response);

  // ---- PASS 0b: NEVER PAY TWICE FOR THE SAME WORDS ----
  // A record must never be dropped to make room for a second copy of another
  // record. See the block above dedupeBodies() for the measurement.
  const dupes = dedupeBodies(response);

  const originalBytes = bytes(response);
  if (originalBytes <= maxBytes) {
    // Under budget. Report it anyway — a reader should be able to TRUST that
    // silence means whole, and it can only trust that if the door says so.
    response.payload_budget = {
      max_bytes: maxBytes,
      bytes: originalBytes,
      complete: true,
      note: 'Full result. Nothing was dropped or shortened.',
      vectors_stripped: vectors.removed,
      vector_bytes_freed: vectors.bytesFreed,
      bodies_deduped: dupes.deduped,
      duplicate_bytes_freed: dupes.bytesFreed,
    };
    return response;
  }

  const dropped = [];
  const shortened = [];
  const foundCounts = {};

  for (const k of arrayKeys) {
    if (Array.isArray(response[k])) foundCounts[k] = response[k].length;
  }

  // ---- PASS 1: shorten any single item that is hogging the budget ----------
  const singleCap = Math.floor(maxBytes * MAX_SINGLE_ITEM_SHARE);
  for (const k of arrayKeys) {
    const arr = response[k];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;
      const field = textFieldOf(item, k);
      if (!field || typeof item[field] !== 'string') continue;
      if (Buffer.byteLength(item[field], 'utf8') <= singleCap) continue;
      const id = idOf(item);
      const r = shortenField(item[field], singleCap, id);
      if (r.shortened) {
        item[field] = r.text;
        item.complete = false;
        item.full_bytes = r.fullLen;
        item.returned_bytes = r.returnedLen;
        item.redeem = id ? '/v1/object/' + id : null;
        shortened.push({ id: id, array: k, full_bytes: r.fullLen });
      }
    }
  }

  // ---- PASS 2: drop lowest-ranked items until we fit ----------------------
  // Arrays arrive best-first, so we pop from the TAIL. Drop priority follows
  // arrayKeys order: the most redundant collection sheds first, the raw last.
  let guard = 0;
  while (bytes(response) > maxBytes && guard++ < 5000) {
    let droppedOne = false;
    for (const k of arrayKeys) {
      const arr = response[k];
      if (Array.isArray(arr) && arr.length > 1) {   // never drop the last one
        const gone = arr.pop();
        dropped.push({ id: idOf(gone), array: k });
        droppedOne = true;
        break;
      }
    }
    if (!droppedOne) break;   // nothing left to drop; the floor is the floor
  }

  // ---- Honest counts: what was FOUND, not merely what fit ----------------
  const countKeyFor = { memories: 'count', objects: 'objects_count', events: 'events_count', candidates: 'candidates_count' };
  const returnedCounts = {};
  for (const k of arrayKeys) {
    if (!Array.isArray(response[k])) continue;
    returnedCounts[k] = response[k].length;
    const ck = countKeyFor[k];
    if (ck) response[ck] = response[k].length;      // count matches what is here
  }

  const finalBytes = bytes(response);

  response.payload_budget = {
    max_bytes: maxBytes,
    bytes_before: originalBytes,
    bytes: finalBytes,
    complete: false,
    found: foundCounts,
    returned: returnedCounts,
    dropped_count: dropped.length,
    shortened_count: shortened.length,
    dropped: dropped.slice(0, 50),
    shortened: shortened.slice(0, 50),
    vectors_stripped: vectors.removed,
    vector_bytes_freed: vectors.bytesFreed,
    bodies_deduped: dupes.deduped,
    duplicate_bytes_freed: dupes.bytesFreed,
    redeem: 'GET /v1/object/{id} returns any single item whole, uncapped.',
    narrow: 'Or re-query with a smaller limit, or a more specific query, to get fewer items whole.',
  };

  // ---- IN-BAND, FIRST KEY, PLAIN PROSE ----------------------------------
  // A JSON field can be skipped by a model skimming for content. A sentence at
  // the top of the object cannot. This is the difference between an honest
  // door and a lying one.
  const notice =
    '*** THIS RESULT IS INCOMPLETE — THE PAYLOAD BUDGET TRIMMED IT. *** ' +
    'The search found ' + Object.entries(foundCounts).map(([k, v]) => v + ' ' + k).join(', ') + ', ' +
    'but a full response would have been ' + originalBytes + ' bytes against a ' + maxBytes + '-byte ceiling. ' +
    dropped.length + ' item(s) were DROPPED (lowest-ranked first) and ' + shortened.length + ' were SHORTENED. ' +
    'YOU ARE NOT LOOKING AT EVERYTHING THE POOL HOLDS FOR THIS QUERY. ' +
    'Do not conclude absence from this response. ' +
    'Every dropped and shortened item is listed by id under payload_budget — ' +
    'GET /v1/object/{id} returns any of them whole, with no cap. ' +
    'To see fewer things completely instead of more things partially, re-query with a smaller limit.';

  // Rebuild so _NOTICE is genuinely first in key order.
  const rebuilt = { _NOTICE: notice };
  for (const k of Object.keys(response)) rebuilt[k] = response[k];

  return rebuilt;
}

function defaultTextField(item, arrayKey) {
  if (arrayKey === 'memories') return 'value';
  if (arrayKey === 'objects') return 'content';
  if (arrayKey === 'candidates') return 'summary';
  if (typeof item.content === 'string') return 'content';
  if (typeof item.value === 'string') return 'value';
  return null;
}

function defaultId(item) {
  if (!item) return null;
  return String(item._id || item.id || item.event_id || (item.meta && item.meta.legacy_id) || '');
}

module.exports = { enforcePayloadBudget, stripVectors, dedupeBodies, DEFAULT_MAX_BYTES, bytes };
