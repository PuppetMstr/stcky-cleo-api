// /api/claim.js  (drops in at C:\Stcky\cleo-api\claim.js)
//
// STCKY signup + save endpoint.
// Called from stcky.ai — either the classic name+email signup form, OR the
// inline save-by-conversation form.
//
// Takes: { email, name, turns?: [{role:'sticky'|'user', text:'...'}] }
//   - turns is OPTIONAL as of 2026-06-25. A plain name+email signup with no
//     prior conversation is valid; when turns are present they're ingested.
// Returns: { token, name, user_id }
//   on duplicate email: 409 { error:'email_exists' }
//   on bad input:        400 { error:'invalid_*' }
//
// Side effects:
//   1. Inserts a new doc into the `users` collection with email/firstName/
//      lastName/apiKey matching the schema the auth path reads.
//      New users land tier:'paid' (full substrate from message one — "full
//      Monty"; throttle later if/when we choose).
//   2. Ingests any pre-auth turns into the substrate under the new apiKey,
//      via internal POST to /api/ingest (same Vercel project).
//
// Uses _lib/auth's getDb() + cors() helpers to match cleo-api conventions.
const crypto = require('crypto');
const { getDb, cors } = require('./_lib/auth');
const { findUserByReferralCode } = require('./_lib/referral');
// REFERRAL_INTEGRATION_INJECTED
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
  // turns OPTIONAL: default to empty array when absent/invalid (classic signup)
  const turns = Array.isArray(body.turns) ? body.turns : [];
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'invalid_email' });
  }
  if (!name) {
    return res.status(400).json({ error: 'invalid_name' });
  }

  // Optional referral capture. If body.referrer_token is provided and matches
  // an existing user's referral_code, stamp referred_by on the new user record.
  let referrerInfo = null;
  if (typeof body.referrer_token === 'string' && body.referrer_token.trim()) {
    try {
      const referrer = await findUserByReferralCode(body.referrer_token);
      if (referrer && referrer.email !== email) {
        referrerInfo = {
          referred_by: referrer._id,
          referrer_email: referrer.email,
        };
      }
    } catch (e) {
      console.error('[claim] referral lookup error', e.message);
      // graceful: continue without referral attribution
    }
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
      plan: 'paid',                        // full substrate from signup (full Monty)
      tier: 'paid',                        // <-- was 'user' (stateless); now substrate-aware from message one
      memoryLimit: 100000,
      timezone: null,                      // set from real browser tz (body.timezone) below; honest UTC at read-time if absent
      createdAt: now,                      // <-- renamed from `created_at`
      updatedAt: now,
      lastSeen: now,
      passwordHash: '',
      claimed_from: 'stcky.ai_first_touch',
      claimed_at: now
    };
    if (referrerInfo) {
      userDoc.referred_by = referrerInfo.referred_by;
      userDoc.referrer_email = referrerInfo.referrer_email;
    }

    // Campaign attribution (first-touch source), injected by referral-client.js.
    if (body.attribution && typeof body.attribution === 'object') {
      userDoc.attribution = body.attribution;
      userDoc.signup_source = body.attribution.utm_source || null;
      userDoc.signup_campaign = body.attribution.utm_campaign || null;
    }
    // Real browser timezone (closes the LA-default TODO above).
    if (typeof body.timezone === 'string' && body.timezone.trim()) {
      userDoc.timezone = body.timezone.trim();
    }

    const result = await users.insertOne(userDoc);
    const userId = result.insertedId;

    // Record this signup on the referrer's record (best-effort, non-blocking)
    if (referrerInfo) {
      try {
        await users.updateOne(
          { _id: referrerInfo.referred_by },
          {
            $push: {
              referrals: {
                user_email: email,
                user_id: userId,
                signup_date: now,
                converted: false,
                first_purchase: null,
              }
            },
            $inc: { total_referrals: 1 },
            $set: { updatedAt: now }
          }
        );
      } catch (e) {
        console.error('[claim] failed to record referral on referrer', e.message);
      }
    }
    // ingest pre-auth turns under the new user's apiKey (best-effort).
    // No-op for classic name+email signup (turns === []).
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
