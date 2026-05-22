// /api/login-verify.js  (drops in at C:\Stcky\cleo-api\login-verify.js)
//
// STCKY magic-link verification endpoint.
// User clicks the magic link in their email; this handler runs.
//
// Takes: GET ?token=<one-time>
// Returns: 302 redirect to https://stcky.ai/#apiKey=<user's apiKey>
//
// On invalid/expired/used token: redirect to https://stcky.ai/?login_error=<reason>
// so the frontend can render an error state.
//
// Side effects:
//   1. Marks the login_token as used=true so it can't be replayed.
//   2. Updates the user's lastSeen timestamp.

const { getDb, cors } = require('./_lib/auth');

const FRONTEND_BASE = process.env.STCKY_FRONTEND_BASE || 'https://stcky.ai';

function redirectWithError(res, reason) {
  res.statusCode = 302;
  res.setHeader('Location', `${FRONTEND_BASE}/?login_error=${encodeURIComponent(reason)}`);
  return res.end();
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // Parse token from query string. Works whether req.query is provided by the
  // platform or we have to parse req.url ourselves.
  let token = null;
  if (req.query && typeof req.query.token === 'string') {
    token = req.query.token;
  } else if (req.url) {
    try {
      const u = new URL(req.url, 'https://stcky.ai');
      token = u.searchParams.get('token');
    } catch (e) { /* fall through */ }
  }

  if (!token || typeof token !== 'string' || token.length < 16) {
    return redirectWithError(res, 'invalid_token');
  }

  try {
    const db = await getDb();
    const tokens = db.collection('login_tokens');
    const users = db.collection('users');

    const record = await tokens.findOne({ token });
    if (!record) {
      return redirectWithError(res, 'invalid_token');
    }
    if (record.used) {
      return redirectWithError(res, 'token_used');
    }
    if (record.expiresAt && new Date(record.expiresAt) < new Date()) {
      return redirectWithError(res, 'token_expired');
    }

    // Look up the user the token belongs to
    const user = await users.findOne({ _id: record.userId });
    if (!user || !user.apiKey) {
      return redirectWithError(res, 'user_not_found');
    }

    // Mark token used (one-time enforcement)
    await tokens.updateOne(
      { _id: record._id },
      { $set: { used: true, usedAt: new Date() } }
    );

    // Touch user's lastSeen
    await users.updateOne(
      { _id: user._id },
      { $set: { lastSeen: new Date() } }
    );

    // Redirect to frontend with apiKey in URL fragment.
    // Fragment is intentional -- it never gets sent to servers / logs,
    // and the frontend reads it via window.location.hash on load.
    const target = `${FRONTEND_BASE}/#apiKey=${encodeURIComponent(user.apiKey)}`;
    res.statusCode = 302;
    res.setHeader('Location', target);
    return res.end();
  } catch (e) {
    console.error('login-verify handler exception', e);
    return redirectWithError(res, 'server_error');
  }
};
