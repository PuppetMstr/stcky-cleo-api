// upload.js
//
// POST /api/upload
//
// Accepts a base64-encoded file, optionally stores the raw bytes in Vercel Blob,
// extracts the file's content (vision read for images, UTF-8 for text), and
// ingests that content into the user's substrate as an object -- same write path
// as ingest.js, so an uploaded screenshot is recalled like any other turn.
//
// Request body (JSON):
//   { filename: string, mime: string, data_base64: string }
//
// Response:
//   { success, object_id, file: { url, name, type, size }, extracted }
//
// Notes:
//  - Vercel serverless request bodies cap at ~4.5 MB; base64 inflates ~33%, so
//    the practical file ceiling here is ~3 MB. Larger files / PDFs are the v2
//    upgrade (client-direct-to-Blob upload, which bypasses the body limit).
//  - Raw-file storage is OPTIONAL: if BLOB_READ_WRITE_TOKEN is unset, the file
//    isn't persisted but the extracted content still enters the substrate, so
//    the feature works before a Blob store is provisioned.

const { getDb, auth, cors } = require('./_lib/auth');
const { putObject } = require('./_lib/objects');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
// Align with chat.js's MODEL if you want a single source of truth.
const VISION_MODEL = process.env.VISION_MODEL || 'claude-sonnet-4-6';

const MAX_BYTES = 3 * 1024 * 1024; // ~3 MB decoded keeps the base64 body under Vercel's 4.5 MB cap
const ALLOWED = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
  'text/plain', 'text/markdown', 'text/csv',
]);

async function visionExtract(buffer, mime) {
  const r = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: VISION_MODEL,
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mime, data: buffer.toString('base64') } },
          { type: 'text', text: 'Transcribe all text in this image verbatim, then briefly note any non-text visual content (charts, photos, layout). This becomes the user\'s durable memory of the file, so be complete and factual. No preamble.' },
        ],
      }],
    }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`vision_${r.status}: ${t.slice(0, 200)}`);
  }
  const data = await r.json();
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

async function maybeStoreBlob(buffer, filename, mime, userId) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return null; // Blob not configured yet -- skip raw-file storage.
  const { put } = require('@vercel/blob');
  const safe = String(filename || 'file').replace(/[^\w.\-]/g, '_');
  const blob = await put(`uploads/${userId}/${Date.now()}-${safe}`, buffer, {
    access: 'public',
    contentType: mime,
    token,
  });
  return blob.url;
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await auth(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const { filename, mime, data_base64 } = req.body || {};

    if (!data_base64 || typeof data_base64 !== 'string') {
      return res.status(400).json({ error: 'data_base64 required', code: 'FILE_MISSING' });
    }
    if (!mime || !ALLOWED.has(mime)) {
      return res.status(415).json({ error: `Unsupported file type: ${mime || 'unknown'}` });
    }

    const buffer = Buffer.from(data_base64, 'base64');
    if (buffer.length === 0) return res.status(400).json({ error: 'empty file' });
    if (buffer.length > MAX_BYTES) {
      return res.status(413).json({ error: 'File too large (max ~3 MB in this version)' });
    }

    // 1) Store raw file if Blob is configured (optional in v1).
    let fileUrl = null;
    try {
      fileUrl = await maybeStoreBlob(buffer, filename, mime, user._id);
    } catch (e) {
      console.error('[UPLOAD] blob store failed:', e.message);
    }

    // 2) Extract content -- vision for images, UTF-8 for text.
    let extracted = '';
    try {
      if (mime.startsWith('image/')) {
        extracted = await visionExtract(buffer, mime);
      } else {
        extracted = buffer.toString('utf8').slice(0, 200000);
      }
    } catch (e) {
      console.error('[UPLOAD] extract failed:', e.message);
      extracted = `[Upload: ${filename || 'file'} stored, but content extraction failed.]`;
    }

    // 3) Ingest the extracted content into the substrate as an object.
    const db = await getDb();
    const header = `[Uploaded file: ${filename || 'file'}]` + (fileUrl ? `\nURL: ${fileUrl}` : '');
    const result = await putObject(db, user._id, {
      content: `${header}\n\n${extracted}`,
      source_type: 'upload',
      speaker: user.name || user.email || 'user',
      client: 'web',
      metadata: { filename: filename || null, mime, file_url: fileUrl, bytes: buffer.length },
    });

    console.log(`[UPLOAD] ${user._id} | ${mime} | ${buffer.length}b | obj=${result.object_id}`);

    return res.status(201).json({
      success: true,
      object_id: result.object_id,
      file: { url: fileUrl, name: filename || null, type: mime, size: buffer.length },
      extracted,
    });
  } catch (err) {
    console.error('[UPLOAD] error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
};
