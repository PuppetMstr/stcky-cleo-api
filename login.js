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

// ---------------------------------------------------------------------------
// A SIX-DIGIT CODE, BECAUSE A LINK ONLY WORKS ON THE DEVICE THAT RECEIVES IT.
// Added Jul 18 2026.
//
// Steven asked for a sign-in link on his phone. It arrived -- on his iPad. His
// iPhone's mail had not synced since the 18th of the previous month, so the
// link was sitting on a screen three feet from the device that needed it, and
// it is single-use, so opening it on the iPad would have spent it there.
//
// THAT IS NOT AN EDGE CASE. People read mail on one device and use apps on
// another all day long. A magic link silently assumes those are the same
// device, and when they are not it fails in a way the person cannot diagnose
// -- it just looks like the email never came.
//
// A code travels by eye. Read it off whatever screen has the mail, type it
// into whatever screen has the app. No assumption about devices at all.
//
// Six digits, one hour, one use, same lifetime as the link -- they are two
// doors onto the same one-time token, not two systems.
function makeLoginCode() {
  // crypto-random, not Math.random: this is a credential, short enough to be
  // typed and therefore short enough to be guessed if it were predictable.
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

async function sendMagicLinkEmail(toEmail, firstName, magicLink, code) {
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
    'Your sign-in code is:',
    '',
    '    ' + code,
    '',
    'Type it into STCKY on whichever device you want to use.',
    '',
    'Or, if you are reading this on that same device, just tap here:',
    magicLink,
    '',
    'The code and the link are the same sign-in. Either one works, once,',
    'and both stop working in an hour.',
    '',
    "If you didn't request this, just ignore the email.",
    '',
    '— STCKY'
  ].join('\n');

  const html = `<p>${greeting}</p>
<p>Your sign-in code is:</p>
<p style="font-size:32px;font-family:monospace;letter-spacing:6px;margin:18px 0"><b>${code}</b></p>
<p>Type it into STCKY on whichever device you want to use.</p>
<p>Or, if you're reading this on that same device, just tap here:<br>
<a href="${magicLink}">${magicLink}</a></p>
<p>The code and the link are the same sign-in. Either one works, once, and both stop working in an hour.</p>
<p>If you didn't request this, just ignore the email.</p>
<p>— STCKY</p>`;

  try {
    const info = await transporter.sendMail({
      from,
      to: toEmail,
      subject: `${code} is your STCKY sign-in code`,
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

  // =========================================================================
  // REDEEM A CODE.  POST { email, code }  ->  { ok:true, apiKey }
  //
  // The other half of the code path. Same one-time token underneath as the
  // link, same one-hour life, same single use -- the person just carried it
  // with their eyes instead of with a tap.
  // =========================================================================
  if (typeof body.code === 'string' && body.code.trim()) {
    const codeIn = body.code.replace(/\D/g, '');
    const emailIn = (typeof body.email === 'string') ? body.email.trim().toLowerCase() : '';
    if (codeIn.length !== 6 || !EMAIL_RE.test(emailIn)) {
      return res.status(400).json({ error: 'invalid_code' });
    }
    try {
      const db = await getDb();

      // =================================================================
      // A SIX-DIGIT CODE WITH UNLIMITED GUESSES IS A THREE-DIGIT CODE.
      // Added Jul 28 2026, when Steven asked how to make sign-in as secure
      // as possible for the people using this.
      //
      // Until this block, redeeming was one lookup -- {email, code,
      // used:false} -- with NO attempt counter and NO lockout. Six digits
      // is a million possibilities, which sounds like a lot until you
      // notice that nothing was counting. An attacker who knows somebody's
      // email can request a code themselves (that mails it to the victim,
      // who ignores it), and then simply guess, in parallel, for the full
      // hour the code is alive. A million guesses at a few hundred a second
      // is not an attack that needs a research budget. It needs an
      // afternoon.
      //
      // THIS IS A BIGGER HOLE THAN THE FOUNDER KEY WAS. The founder key
      // required being the founder. This required knowing an email address.
      //
      // Five wrong codes locks that address's redemption for fifteen
      // minutes. It does not lock the ACCOUNT -- the owner can still ask
      // for a fresh code and use it -- so an attacker cannot lock a real
      // person out by guessing at them. It only stops the guessing.
      // =================================================================
      const attempts = db.collection('login_attempts');
      const nowT = new Date();
      const att = await attempts.findOne({ _id: emailIn });
      if (att && att.lockedUntil && new Date(att.lockedUntil) > nowT) {
        return res.status(429).json({
          error: 'too_many_attempts',
          message: 'Too many wrong codes. Wait a few minutes, then ask for a new one.',
        });
      }

      const rec = await db.collection('login_tokens').findOne({
        email: emailIn, code: codeIn, used: false,
      });
      // ONE MESSAGE FOR EVERY FAILURE. Wrong code, expired code, already-used
      // code and unknown email must be indistinguishable, or this becomes a
      // way to find out which addresses have accounts.
      const bad = { error: 'bad_code', message: 'That code is wrong or expired. Ask for a new one.' };

      const registerFailure = async () => {
        const WINDOW_MS = 15 * 60 * 1000;
        const MAX_FAILS = 5;
        const fresh = att && att.firstFailAt && (nowT - new Date(att.firstFailAt)) < WINDOW_MS;
        const fails = (fresh ? (att.fails || 0) : 0) + 1;
        await attempts.updateOne(
          { _id: emailIn },
          {
            $set: {
              fails,
              firstFailAt: fresh ? att.firstFailAt : nowT,
              lastFailAt: nowT,
              lockedUntil: fails >= MAX_FAILS ? new Date(nowT.getTime() + WINDOW_MS) : null,
            },
          },
          { upsert: true }
        );
      };

      if (!rec || (rec.expiresAt && new Date(rec.expiresAt) < new Date())) {
        await registerFailure();
        return res.status(401).json(bad);
      }
      const u = await db.collection('users').findOne({ _id: rec.userId });
      if (!u || !u.apiKey) {
        await registerFailure();
        return res.status(401).json(bad);
      }

      await db.collection('login_tokens').updateOne(
        { _id: rec._id }, { $set: { used: true, usedAt: new Date() } });
      await db.collection('users').updateOne(
        { _id: u._id }, { $set: { lastSeen: new Date() } });
      // A good code clears the counter. Someone who eventually gets it right
      // is a person fumbling a typo, not an attack in progress.
      await attempts.deleteOne({ _id: emailIn });
      return res.status(200).json({ ok: true, apiKey: u.apiKey });
    } catch (e) {
      console.error('login code redeem exception', e);
      return res.status(500).json({ error: 'internal_error' });
    }
  }

  const email = (typeof body.email === 'string') ? body.email.trim().toLowerCase() : '';

  // WHERE TO LAND THEM AFTER THEY CLICK. Added Jul 18 2026.
  //
  // Steven, on the voice app asking for a key: "Most people, I couldn't have any
  // idea what their key is... They don't need to know that there's a key. We need
  // to be able to put it in for them so they get it seamlessly."
  //
  // He is right, and the fix was already built -- this magic link. The only gap
  // was that it always dropped people on the home page, so signing in from the
  // voice app sent you somewhere else and you had to find your way back.
  //
  // A person should end up where they started. Path only, same origin, no host
  // accepted from the caller -- an open redirect on a link that carries a
  // credential in its destination would be a genuine hole.
  let next = typeof body.next === 'string' ? body.next.trim() : '';
  if (!/^\/[A-Za-z0-9._~\-\/]*$/.test(next)) next = '';

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
    const code = makeLoginCode();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + TOKEN_TTL_MS);

    // ONE LIVE CODE PER ADDRESS. Added Jul 28 2026 alongside the attempt
    // limit above. Every unused token was staying valid for its full hour,
    // so asking for three codes meant three live six-digit numbers against
    // the same account and three times the chance a guesser hits one. It
    // also confuses real people, who typically type the newest code and
    // expect the old one to be dead. Issuing a new code kills the old ones.
    await db.collection('login_tokens').updateMany(
      { email: user.email, used: false },
      { $set: { used: true, usedAt: now, superseded: true } }
    );

    await db.collection('login_tokens').insertOne({
      token,
      code,                    // the same sign-in, carried by eye instead of by tap
      userId: user._id,
      email: user.email,
      createdAt: now,
      expiresAt,
      used: false,
      next: next || null,      // land them back where they signed in from
    });

    const magicLink = `${VERIFY_BASE}/api/login/verify?token=${token}`;

    // =====================================================================
    // THE FOUNDER DOES NOT GET OTHER PEOPLE'S SIGN-INS. Closed Jul 28 2026.
    //
    // Steven, today, stating the model he believed was already true:
    //   "I cannot reach into their account. I cannot take stuff out. I can
    //    put stuff in, and that's it."
    //
    // That IS the model, and it is built -- in admin-ingest.js. Founder tier,
    // cross-user WRITE only, every object tagged metadata.admin_ingest so the
    // crossing is auditable. It cannot read. It is the right door and it stays.
    //
    // This file had a second door nobody meant to leave open. getAdminCaller
    // below returned the magic link AND the six-digit code, in the response
    // body, for ANY email, to any founder-tier key. Redeeming either one hands
    // back THAT USER'S apiKey (login-verify.js redirects to
    // stcky.ai/#apiKey=<their key>; the code path returns it outright). That
    // key is full access -- read included. Not putting things in. Being them.
    //
    // It was written as a deliberate stopgap -- the comment above still names
    // Paul, "before SMTP is fully wired." SMTP is wired now; the code goes to
    // the person's own mailbox. The stopgap outlived its reason and quietly
    // contradicted the one promise the product is sold on.
    //
    // So: a founder can still request a sign-in for anyone -- that sends the
    // code to THEIR mailbox, which is help. What comes back to the caller is
    // only confirmation that it was sent. The credential goes to the person
    // who owns the pool, and to nobody else.
    //
    // Still allowed: a founder pulling their OWN link for their own account.
    // That is not a boundary crossing; it is signing in.
    //
    // WHAT THIS COSTS: if someone cannot reach their own email, no one can
    // sign in for them. That is a real support cost and it is the correct
    // one -- the alternative is a key to every private pool in the product,
    // and "it's yours and it stays yours" cannot survive that key existing.
    // If account recovery for people locked out of their mail is needed, it
    // should be built as recovery, in the open, not as a founder side door.
    // =====================================================================
    const adminIsSelf = adminCaller && String(adminCaller._id) === String(user._id);

    const sendResult = await sendMagicLinkEmail(
      user.email,
      user.firstName || '',
      magicLink,
      code
    );

    const response = { ok: true, sent: sendResult.sent };

    // A founder may pull their OWN sign-in from the response. For anyone
    // else's account the credential goes to that person's mailbox and the
    // caller gets confirmation only -- see the note above.
    if (adminCaller && adminIsSelf) {
      response.magic_link = magicLink;
      response.code = code;
      response.admin_note = sendResult.sent
        ? 'email also sent'
        : `email not sent: ${sendResult.reason || 'unknown'}`;
    } else if (adminCaller) {
      response.admin_note = sendResult.sent
        ? 'Sign-in code emailed to ' + user.email + '. It is not returned here -- founder tier ' +
          'can write into another pool (/api/admin/ingest) but cannot sign in as its owner. ' +
          'They read the code from their own mail.'
        : 'Account exists, but the email did NOT send (' + (sendResult.reason || 'unknown') + '). ' +
          'The code is not returned here. Fix the mail path -- there is no side door.';
    }

    return res.status(200).json(response);
  } catch (e) {
    console.error('login handler exception', e);
    return res.status(500).json({ error: 'internal_error' });
  }
};
