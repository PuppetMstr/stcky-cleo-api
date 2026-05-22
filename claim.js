// /api/claim.js  (drops in at C:\Stcky\cleo-api\claim.js)
//
// STCKY save-by-conversation endpoint.
// Called from stcky.ai when a user submits the inline save form.
//
// Takes: { email, name, turns: [{role:'sticky'|'user', text:'...'}] }
// Returns: { token, name, user_id }
//   on duplicate email: 409 { error:'email_exists' }
//   on bad input:        400 { error:'invalid_*' }
//
// Side effects:
//   1. Inserts a new doc into the `users` collection with email/firstName/
//      lastName/apiKey matching the schema the auth path reads.
//   2. Ingests every pre-auth turn into the substrate under the new apiKey,
//      via internal POST to /api/ingest (same Vercel project).
//
// Uses _lib/auth's getDb() + cors() helpers to match cleo-api conventions.
const crypto = require('crypto');
const { getDb, cors } = require('./_lib/auth');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INGEST_BASE = process.env.CLEO_API_BASE || 'https://api.stcky.ai';
function makeToken() {
  return 'cleo_' + crypto.randomBytes(16).toString('hex');
}
module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  // body parsing
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); }
    catch (e) { return res.status(400).json({ error: 'invalid_json' }); }
  }
  body = body || {};
  const email = (typeof body.email === 'string') ? body.email.trim().toLowerCase() : '';
  const name = (typeof body.name === 'string') ? body.name.trim() : '';
  const turns = Array.isArray(body.turns) ? body.turns : null;
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'invalid_email' });
  }
  if (!name) {
    return res.status(400).json({ error: 'invalid_name' });
  }
  if (!turns) {
    return res.status(400).json({ error: 'invalid_turns' });
  }
  // Split `name` into firstName/lastName -- matches schema other code reads.
  // First token = firstName, remainder = lastName. Single-word names land
  // entirely in firstName.
  const nameParts = name.split(/\s+/);
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ') || '';
  try {
    const db = await getDb();
    const users = db.collection('users');
    // duplicate check
    const existing = await users.findOne({ email });
    if (existing) {
      return res.status(409).json({
        error: 'email_exists',
        message: 'That email is already claimed. Login flow is coming soon.'
      });
    }
    // create user -- schema matches what auth() reads (apiKey, not token)
    const token = makeToken();
    const now = new Date();
    const userDoc = {
      email,
      firstName,
      lastName,
      apiKey: token,                       // <-- field renamed from `token`
      plan: 'free',
      tier: 'user',
      memoryLimit: 100,
      timezone: 'America/Los_Angeles',     // TODO: derive from request headers later
      createdAt: now,                      // <-- renamed from `created_at`
      updatedAt: now,
      lastSeen: now,
      passwordHash: '',
      claimed_from: 'stcky.ai_first_touch',
      claimed_at: now
    };
    const result = await users.insertOne(userDoc);
    const userId = result.insertedId;
    // ingest pre-auth turns under the new user's apiKey (best-effort)
    const ingestUrl = INGEST_BASE + '/api/ingest';
    const ingested = [];
    const failed = [];
    for (const t of turns) {
      if (!t || typeof t.text !== 'string' || !t.text.trim()) continue;
      const speaker = (t.role === 'sticky') ? 'STCKY' : firstName || name;
      try {
        const r = await fetch(ingestUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token
          },
          body: JSON.stringify({
            content: t.text,
            source_type: 'conversation',
            speaker
          })
        });
        if (r.ok) {
          const j = await r.json();
          if (j && j.object_id) ingested.push(j.object_id);
        } else {
          failed.push({ status: r.status });
        }
      } catch (e) {
        failed.push({ err: String(e && e.message || e) });
      }
    }
    if (failed.length) {
      console.error('claim: partial ingest', { ingested: ingested.length, failed });
    }
    // Response shape unchanged -- frontend reads `token`, stashes in localStorage
    return res.status(200).json({
      token,
      name,
      user_id: userId.toString(),
      ingested_count: ingested.length
    });
  } catch (e) {
    console.error('claim handler exception', e);
    return res.status(500).json({ error: 'internal_error' });
  }
};