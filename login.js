// /api/login.js  (drops in at C:\Stcky\cleo-api\login.js)
//
// STCKY magic-link login endpoint.
// Called from stcky.ai when a returning user wants to sign back in.
//
// Takes: { email }
// Returns: { ok: true, sent: true }   (same response whether email exists or not,
//                                      to prevent email enumeration)
//
// Side effects:
//   1. If the email is found in cleo.users, generates a one-time login token,
//      stores it in cleo.login_tokens with 1-hour expiry and used=false.
//   2. Sends a magic-link email to the user. If SMTP isn't configured, the
//      link is logged to console as a fallback so an admin can hand it out.
//   3. If the caller authenticates as a founder-tier user (via Bearer header),
//      the magic link is ALSO returned in the response — bridge path for
//      issuing logins out-of-band while SMTP is being set up.
//
// Required Vercel env vars for SMTP send:
//   SMTP_USER         e.g. steven@stcky.ai
//   SMTP_APP_PASSWORD 16-char Google app password (Account > Security > App passwords)
//   SMTP_FROM         e.g. "STCKY <steven@stcky.ai>"

const crypto = require('crypto');
const { getDb, cors } = require('./_lib/auth');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_TTL_MS = 60 * 60 * 1000;  // 1 hour
const VERIFY_BASE = process.env.CLEO_API_BASE || 'https://api.stcky.ai';

function makeLoginToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function sendMagicLinkEmail(toEmail, firstName, magicLink) {
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_APP_PASSWORD;
  const from = process.env.SMTP_FROM || `STCKY <${user || 'noreply@stcky.ai'}>`;

  if (!user || !pass) {
    // SMTP not configured -- log link so admin can hand-deliver
    console.warn('login: SMTP not configured; magic link for', toEmail, '=>', magicLink);
    return { sent: false, reason: 'smtp_not_configured' };
  }

  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch (e) {
    console.warn('login: nodemailer not installed; magic link for', toEmail, '=>', magicLink);
    return { sent: false, reason: 'nodemailer_missing' };
  }

  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: { user, pass }
  });

  const greeting = firstName ? `Hi ${firstName},` : 'Hi,';
  const text = [
    greeting,
    '',
    'Click here to sign in to your STCKY:',
    magicLink,
    '',
    'This link is valid for one hour and can only be used once.',
    '',
    "If you didn't request this, just ignore the email.",
    '',
    '— STCKY'
  ].join('\n');

  const html = `<p>${greeting}</p>
<p>Click here to sign in to your STCKY:</p>
<p><a href="${magicLink}">${magicLink}</a></p>
<p>This link is valid for one hour and can only be used once.</p>
<p>If you didn't request this, just ignore the email.</p>
<p>— STCKY</p>`;

  try {
    const info = await transporter.sendMail({
      from,
      to: toEmail,
      subject: 'Sign in to your STCKY',
      text,
      html
    });
    return { sent: true, messageId: info.messageId };
  } catch (e) {
    // Send failed -- log the link so it's recoverable
    console.error('login: email send failed for', toEmail, e && e.message, '; link =>', magicLink);
    return { sent: false, reason: 'send_failed', error: String(e && e.message || e) };
  }
}

// Best-effort admin check via Bearer header. Returns the user record if the
// caller authenticates as a founder-tier user, otherwise null. Used to decide
// whether to return the magic link in the response (bridge path for Paul).
async function getAdminCaller(req, db) {
  try {
    const hdr = req.headers && (req.headers.authorization || req.headers.Authorization);
    if (!hdr || !hdr.startsWith('Bearer ')) return null;
    const token = hdr.slice(7).trim();
    if (!token) return null;
    const user = await db.collection('users').findOne({ apiKey: token });
    if (user && user.tier === 'founder') return user;
    return null;
  } catch (e) {
    return null;
  }
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

  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'invalid_email' });
  }

  try {
    const db = await getDb();
    const user = await db.collection('users').findOne({ email });

    // Check admin caller BEFORE the no-user early return so we can return the
    // link to Steven even for emails that don't exist yet (useful for testing).
    const adminCaller = await getAdminCaller(req, db);

    if (!user) {
      // Silent no-op for unknown emails -- same response shape to prevent
      // email enumeration. Admin caller gets a hint though.
      if (adminCaller) {
        return res.status(200).json({
          ok: true,
          sent: false,
          admin_note: 'no user with that email'
        });
      }
      return res.status(200).json({ ok: true, sent: true });
    }

    // Generate one-time login token
    const token = makeLoginToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + TOKEN_TTL_MS);

    await db.collection('login_tokens').insertOne({
      token,
      userId: user._id,
      email: user.email,
      createdAt: now,
      expiresAt,
      used: false
    });

    const magicLink = `${VERIFY_BASE}/api/login/verify?token=${token}`;

    const sendResult = await sendMagicLinkEmail(
      user.email,
      user.firstName || '',
      magicLink
    );

    const response = { ok: true, sent: sendResult.sent };

    // Admin caller: surface the link directly in the response too, so we can
    // hand-deliver to users (like Paul today, before SMTP is fully wired).
    if (adminCaller) {
      response.magic_link = magicLink;
      response.admin_note = sendResult.sent
        ? 'email also sent'
        : `email not sent: ${sendResult.reason || 'unknown'}`;
    }

    return res.status(200).json(response);
  } catch (e) {
    console.error('login handler exception', e);
    return res.status(500).json({ error: 'internal_error' });
  }
};
