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
    embedding: embeddingResult?.embedding || null,
    embedding_model: embeddingResult?.model || null,
    embedding_dims: embeddingResult?.dims || null,
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
        embedding: chunkEmbedding?.embedding || null,
        embedding_model: chunkEmbedding?.model || null,
        embedding_dims: chunkEmbedding?.dims || null,
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
}

module.exports = {
  putObject,
  chunkContent,
  contentHash,
  objectIdFromHash,
  buildProvenance,
  ensureObjectIndexes,
  CHUNK_THRESHOLD_CHARS,
  TARGET_CHUNK_CHARS,
  DEFAULT_EMBEDDING_SIZE,
};
