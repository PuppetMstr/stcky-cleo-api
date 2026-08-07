// _lib/objects.js
//
// STCKY Blob Door v0.1 — Object storage helpers
// Chaos-approved Apr 21, 2026. Build blueprint in thread:ingest-door-2026-04-21.
//
// Content-addressed, append-only, embedded on write. Two verbs day one: PUT, SEARCH.
// Parent/child model for chunked content. Same event log as memories.

const crypto = require('crypto');
const { embed } = require('./embeddings');

// ---- Tunables ----

// Chunk threshold. Content under this is stored as a single object.
// Over this, we create a parent object holding the raw content and child
// chunk objects for retrieval granularity. Chosen as ~2000 tokens worst-case.
const CHUNK_THRESHOLD_CHARS = 8000;

// Target child chunk size and minimum viable tail.
const TARGET_CHUNK_CHARS = 4000;
const MIN_TAIL_CHARS = 400;

// Default embedding model per Chaos Q3 — same space for all content types.
const DEFAULT_EMBEDDING_SIZE = 'large'; // text-embedding-3-large, 3072 dims

// ---- THE HEAD: the first line of a record, made indexable ----
// Added Jul 28 2026, after the drip spent nine hours blocked on
// "confirmation exceeded 15000ms" and the feeder ran at 15-24s a call.
//
// THE COST WAS NEVER THE QUESTION, IT WAS THE SHAPE OF THE ANSWER. Every
// structural door in this system -- count mode, the prior-contact gate, the
// drip's database confirmation -- asks the same thing: does a record EXIST
// whose text STARTS WITH this literal prefix. "SENT -- greg@example.com".
// "BOUNCE -- greg@example.com". Each of those was a $regex on `content`, and
// `content` is unindexed and holds whole email bodies, so every one of those
// questions read every document this user owns, in full, to answer a question
// about its first sixty characters. Six confirmations = six full-collection
// scans. That is why the budget ran out on ONE address.
//
// You cannot usefully index `content` -- these are multi-kilobyte bodies. But
// nothing that asks a prefix question needs more than the head of the record.
// So the head becomes its own small field, written once at ingest, indexed,
// and a prefix regex against it is an index RANGE SCAN instead of a collection
// scan. MongoDB optimizes case-sensitive ^-anchored regexes on indexed fields
// exactly this way; the queries do not change shape, only what they read.
//
// 200 chars because the longest prefix any caller uses today is about eighty
// ("REPLY [OPT_OUT] -- " plus a long address), and the margin costs nothing.
// The number is exported so the read door can REFUSE the fast path rather than
// silently truncate a longer prefix -- an undercount here means mailing a man
// who already said no, so the fallback has to be explicit, not clever.
const HEAD_CHARS = 200;
function headOf(text) {
  return String(text || '').slice(0, HEAD_CHARS);
}

// ---- THE EMBEDDING, STORED AS BYTES INSTEAD OF AS A THOUSAND NUMBERS ----
// Aug 5 2026.
//
// THE MEASUREMENT. Atlas reports cleo.objects at 42,000 documents averaging
// 44.02 kB each -- 1.84 GB, and about three quarters of it is not content. An
// embedding is 3,072 dimensions, and BSON stores an array of numbers as 3,072
// DOUBLES: eight bytes for the number, plus a key string ("0", "1" ... "3071")
// and a type byte for every single element. scorer.py's own header measured the
// exact figures a week ago: 41,911 bytes as an array, 12,303 as float32 binary.
// 3.41x. The same 44 kB, seen from the storage side.
//
// AND WE THROW THE PRECISION AWAY ANYWAY. The scorer's first act on reading one
// of these is np.asarray(v, dtype=np.float32) -- it converts every double down
// to a float32 before it does any arithmetic. So the extra four bytes per
// dimension are stored, indexed, backed up, walked over and paid for, and then
// discarded on arrival. We are paying to carry precision to a door that throws
// it away at the threshold.
//
// THIS WAS TRIED ONCE AND REFUSED, AND THAT REFUSAL NO LONGER APPLIES.
// scorer.py's header records binData being rejected because "ENN went 12-70s ->
// 101-103s" -- but that test was against Atlas $vectorSearch, where the vectors
// live in a separate mongot index with its own internal representation, so
// shrinking the collection never shrank the working set. THE SCORER NO LONGER
// USES $vectorSearch. It holds its own matrix in memory and builds it from
// whatever bytes arrive. The matrix is bit-identical either way; only the
// document, the walk and the cold load get smaller.
//
// NOTHING IS MIGRATED. scorer.py reads BOTH shapes as of the same morning, so
// the 42,000 existing rows keep working untouched and new ones simply arrive
// smaller. There is no cutover, no rewrite, and no moment where half the pool
// is unreadable. Growth goes from 44 kB a record to about 12.
//
// ENDIANNESS: Float32Array and numpy's frombuffer both use native byte order,
// and both ends run little-endian x86. If a reader ever runs somewhere else,
// this is the line that breaks and this is the comment that says why.
function toBinaryEmbedding(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const f = Float32Array.from(arr);
  // Copy rather than view the underlying ArrayBuffer -- a view would keep the
  // whole Float32Array alive and can surprise the BSON serializer.
  return Buffer.from(new Uint8Array(f.buffer, f.byteOffset, f.byteLength));
}

// ---- Identity ----

function contentHash(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function objectIdFromHash(hash) {
  return 'obj_' + hash.slice(0, 32);
}

// ---- Chunking ----
//
// Split-then-pack: break on paragraph boundaries (\n\n). Pack paragraphs into
// chunks up to TARGET_CHUNK_CHARS. Any paragraph longer than target is hard-split
// at sentence boundaries, then at whitespace, then by raw character count as last resort.
// Deterministic — same content always produces same chunks.
function chunkContent(content) {
  if (!content || content.length <= CHUNK_THRESHOLD_CHARS) {
    return [content];
  }

  const paragraphs = content.split(/\n\s*\n/);
  const chunks = [];
  let buffer = '';

  for (const para of paragraphs) {
    if (para.length > TARGET_CHUNK_CHARS) {
      // Flush anything pending first.
      if (buffer.length > 0) {
        chunks.push(buffer);
        buffer = '';
      }
      // Hard-split this paragraph at sentence boundaries.
      const sentences = para.split(/(?<=[.!?])\s+/);
      let sub = '';
      for (const s of sentences) {
        if (s.length > TARGET_CHUNK_CHARS) {
          // Sentence itself is too long — hard-split by char count.
          if (sub.length > 0) { chunks.push(sub); sub = ''; }
          for (let i = 0; i < s.length; i += TARGET_CHUNK_CHARS) {
            chunks.push(s.slice(i, i + TARGET_CHUNK_CHARS));
          }
        } else if ((sub + ' ' + s).length > TARGET_CHUNK_CHARS) {
          chunks.push(sub);
          sub = s;
        } else {
          sub = sub.length > 0 ? sub + ' ' + s : s;
        }
      }
      if (sub.length > 0) chunks.push(sub);
    } else if ((buffer + '\n\n' + para).length > TARGET_CHUNK_CHARS) {
      chunks.push(buffer);
      buffer = para;
    } else {
      buffer = buffer.length > 0 ? buffer + '\n\n' + para : para;
    }
  }
  if (buffer.length > 0) chunks.push(buffer);

  // Merge a tiny tail into the previous chunk to avoid orphan fragments.
  if (chunks.length >= 2 && chunks[chunks.length - 1].length < MIN_TAIL_CHARS) {
    const tail = chunks.pop();
    chunks[chunks.length - 1] = chunks[chunks.length - 1] + '\n\n' + tail;
  }

  return chunks;
}

// ---- Provenance envelope (Chaos Q4) ----
//
// CORE (universal, always present): object_id, source_type, ingested_at, content_hash, trace_id.
// OPTIONAL (context, per content type): speaker, session_id, turn_index, client, metadata.
function buildProvenance({ object_id, source_type, ingested_at, content_hash, trace_id,
                           speaker, session_id, turn_index, client, metadata }) {
  const core = { object_id, source_type, ingested_at, content_hash, trace_id };
  const optional = {};
  if (speaker !== undefined) optional.speaker = speaker;
  if (session_id !== undefined) optional.session_id = session_id;
  if (turn_index !== undefined) optional.turn_index = turn_index;
  if (client !== undefined) optional.client = client;
  if (metadata !== undefined) optional.metadata = metadata;
  return { core, optional };
}

// ---- PUT ----
//
// Writes one object (or a parent + its children) to the objects collection.
// Idempotent: same userId + content_hash returns the existing object with duplicate=true.
// Partial-failure semantics (Chaos Q9): raw content is ALWAYS stored first. Embedding
// is best-effort — if it fails, status becomes 'failed_embedding' and the object is
// queued for retry (retry_pending=true), but the content is never lost.
async function putObject(db, userId, {
  content,
  client_timestamp,   // optional; client-provided event time
  source_type,        // required; 'conversation' | 'document' | 'email' | etc.
  source,             // optional; provider.interface.conversation_id format
  speaker,            // optional
  session_id,         // optional
  turn_index,         // optional
  trace_id,           // optional; generated if absent
  client,             // optional; 'ios' | 'web' | 'api' | ...
  metadata,           // optional; free-form passthrough
}) {
  if (typeof content !== 'string' || content.trim().length === 0) {
    const e = new Error('content required (non-empty string)');
    e.code = 'CONTENT_MISSING';
    throw e;
  }
  if (!source_type) {
    const e = new Error('source_type required');
    e.code = 'SOURCE_TYPE_MISSING';
    throw e;
  }

  const server_ingest_timestamp = new Date();
  const timestamp = client_timestamp ? new Date(client_timestamp) : server_ingest_timestamp;
  const hash = contentHash(content);
  const object_id = objectIdFromHash(hash);
  const effectiveTraceId = trace_id || ('trace_' + crypto.randomBytes(8).toString('hex'));

  // Dedup: check for existing object for this user with same content_hash.
  const existing = await db.collection('objects').findOne({
    userId, content_hash: hash
  });
  if (existing) {
    return {
      object_id: existing.object_id,
      ingested_at: existing.ingested_at,
      stored: true,
      embedded: !!existing.embedding,
      status: existing.status,
      chunk_count: existing.chunk_count || 1,
      duplicate: true,
      provenance: buildProvenance({
        object_id: existing.object_id,
        source_type: existing.source_type,
        ingested_at: existing.ingested_at,
        content_hash: existing.content_hash,
        trace_id: existing.trace_id,
        speaker: existing.speaker,
        session_id: existing.session_id,
        turn_index: existing.turn_index,
        client: existing.client,
        metadata: existing.metadata,
      }),
    };
  }

  const chunks = chunkContent(content);
  const isChunked = chunks.length > 1;

  // Attempt embedding for the primary (parent-or-whole) content.
  // Status reflects the actual outcome so callers can distinguish
  // 'stored-and-embedded' from 'stored-but-retry-pending'.
  let embeddingResult = null;
  let status = 'stored';
  let retry_pending = false;
  try {
    embeddingResult = await embed(content.slice(0, 8000), DEFAULT_EMBEDDING_SIZE);
    if (embeddingResult?.embedding) {
      status = 'embedded';
    } else {
      status = 'failed_embedding';
      retry_pending = true;
    }
  } catch (err) {
    console.error('[objects.putObject] embedding error:', err.message);
    status = 'failed_embedding';
    retry_pending = true;
  }

  const baseDoc = {
    _id: object_id,
    userId,
    object_id,
    content_hash: hash,
    content,
    head: headOf(content),
    content_length: content.length,
    source_type,
    source: source || null,
    speaker: speaker || null,
    session_id: session_id || null,
    turn_index: (turn_index === undefined || turn_index === null) ? null : turn_index,
    trace_id: effectiveTraceId,
    client: client || null,
    metadata: metadata || null,
    client_timestamp: client_timestamp ? new Date(client_timestamp) : null,
    server_ingest_timestamp,
    timestamp,
    ingested_at: server_ingest_timestamp,
    embedding: toBinaryEmbedding(embeddingResult?.embedding),
    embedding_model: embeddingResult?.model || null,
    embedding_dims: embeddingResult?.dims || null,
    embedding_encoding: embeddingResult?.embedding ? 'float32' : null,
    status,
    retry_pending,
    chunk_count: chunks.length,
    is_parent: isChunked,
    parent_object_id: null,
    chunk_index: null,
  };

  // Insert parent (or whole single-chunk object). Idempotent via unique _id.
  try {
    await db.collection('objects').insertOne(baseDoc);
  } catch (err) {
    if (err.code === 11000) {
      // Lost a dedup race to a concurrent write — load and return.
      const now = await db.collection('objects').findOne({ _id: object_id });
      return {
        object_id,
        ingested_at: now?.ingested_at || server_ingest_timestamp,
        stored: true,
        embedded: !!now?.embedding,
        status: now?.status || 'stored',
        chunk_count: now?.chunk_count || 1,
        duplicate: true,
        provenance: buildProvenance({
          object_id,
          source_type: now?.source_type || source_type,
          ingested_at: now?.ingested_at || server_ingest_timestamp,
          content_hash: hash,
          trace_id: now?.trace_id || effectiveTraceId,
          speaker: now?.speaker, session_id: now?.session_id,
          turn_index: now?.turn_index, client: now?.client, metadata: now?.metadata,
        }),
      };
    }
    throw err;
  }

  // If chunked, write child objects with their own embeddings.
  const children = [];
  if (isChunked) {
    for (let i = 0; i < chunks.length; i++) {
      const chunkText = chunks[i];
      const chunkHash = contentHash(chunkText);
      const chunkObjectId = objectIdFromHash(chunkHash);
      let chunkEmbedding = null;
      let chunkStatus = 'stored';
      let chunkRetryPending = false;
      try {
        chunkEmbedding = await embed(chunkText.slice(0, 8000), DEFAULT_EMBEDDING_SIZE);
        if (chunkEmbedding?.embedding) chunkStatus = 'embedded';
        else { chunkStatus = 'failed_embedding'; chunkRetryPending = true; }
      } catch (err) {
        console.error(`[objects.putObject] chunk ${i} embedding error:`, err.message);
        chunkStatus = 'failed_embedding';
        chunkRetryPending = true;
      }

      const chunkDoc = {
        _id: chunkObjectId,
        userId,
        object_id: chunkObjectId,
        content_hash: chunkHash,
        content: chunkText,
        head: headOf(chunkText),
        content_length: chunkText.length,
        source_type,
        source: source || null,
        speaker: speaker || null,
        session_id: session_id || null,
        turn_index: (turn_index === undefined || turn_index === null) ? null : turn_index,
        trace_id: effectiveTraceId,
        client: client || null,
        metadata: metadata || null,
        client_timestamp: client_timestamp ? new Date(client_timestamp) : null,
        server_ingest_timestamp,
        timestamp,
        ingested_at: server_ingest_timestamp,
        embedding: toBinaryEmbedding(chunkEmbedding?.embedding),
        embedding_model: chunkEmbedding?.model || null,
        embedding_dims: chunkEmbedding?.dims || null,
        embedding_encoding: chunkEmbedding?.embedding ? 'float32' : null,
        status: chunkStatus,
        retry_pending: chunkRetryPending,
        chunk_count: 1,
        is_parent: false,
        parent_object_id: object_id,
        chunk_index: i,
      };
      try {
        await db.collection('objects').insertOne(chunkDoc);
      } catch (err) {
        if (err.code !== 11000) throw err; // duplicate child chunk hash is fine
      }
      children.push({ object_id: chunkObjectId, chunk_index: i, status: chunkStatus });
    }
  }

  return {
    object_id,
    ingested_at: server_ingest_timestamp,
    stored: true,
    embedded: status === 'embedded',
    status,
    retry_pending,
    chunk_count: chunks.length,
    duplicate: false,
    children: isChunked ? children : undefined,
    provenance: buildProvenance({
      object_id, source_type,
      ingested_at: server_ingest_timestamp,
      content_hash: hash, trace_id: effectiveTraceId,
      speaker, session_id, turn_index, client, metadata,
    }),
  };
}

// ---- Index setup ----

async function ensureObjectIndexes(db) {
  await db.collection('objects').createIndex({ userId: 1, content_hash: 1 });
  await db.collection('objects').createIndex({ userId: 1, ingested_at: -1 });
  await db.collection('objects').createIndex({ userId: 1, timestamp: -1 });
  await db.collection('objects').createIndex({ userId: 1, source_type: 1, ingested_at: -1 });
  await db.collection('objects').createIndex({ userId: 1, session_id: 1, turn_index: 1 });
  await db.collection('objects').createIndex({ userId: 1, parent_object_id: 1, chunk_index: 1 });
  await db.collection('objects').createIndex({ userId: 1, retry_pending: 1 });

  // THE INDEX THAT ENDS THE QUOTA SCAN. Aug 7 2026, Eli.
  //
  // ingest.js counts parent objects against memoryLimit on EVERY WRITE, with
  // { userId, is_parent: { $ne: false } }. There was no index on is_parent, so
  // that count opened every document the user owns -- 41,547 of them at 41.9 kB
  // apiece -- before a single new object could be stored.
  //
  // MEASURED, Atlas Query Insights, 24h ending 2026-08-07 11:18Z:
  //   1,100 executions/day, avg 14.39 SECONDS each, 41,547.62 examined per
  //   returned value, 4.40 HOURS of execution time in a 24-hour day.
  // Third most expensive query shape on the cluster, and it ran on the ONE door
  // that must never be slow: the door in.
  //
  // With userId first and is_parent second, the count is answered from index
  // keys. A $ne cannot SEEK, but it can be satisfied by scanning the is_parent
  // range inside one userId -- tiny keys instead of 1.7 GB of documents.
  await db.collection('objects').createIndex(
    { userId: 1, is_parent: 1 },
    { name: 'userId_is_parent' }
  );

  // THE INDEX THAT ENDS THE COLLECTION SCAN. Jul 28 2026.
  // userId first (every query is user-scoped), then head (the prefix range),
  // then ingested_at so the time window is satisfied inside the same index
  // rather than by fetching documents. A prefix count now touches index keys
  // only -- it never has to open a single email body.
  await db.collection('objects').createIndex(
    { userId: 1, head: 1, ingested_at: 1 },
    { name: 'userId_head_ingested_at' }
  );
}

module.exports = {
  putObject,
  chunkContent,
  contentHash,
  objectIdFromHash,
  buildProvenance,
  ensureObjectIndexes,
  headOf,
  HEAD_CHARS,
  CHUNK_THRESHOLD_CHARS,
  TARGET_CHUNK_CHARS,
  DEFAULT_EMBEDDING_SIZE,
};
