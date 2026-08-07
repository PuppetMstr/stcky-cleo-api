// cleo-api/_lib/wall.js
// ---------------------------------------------------------------------------
// THE WALL -- enforcement, not discipline.
//
// Steven, Jul 30 2026: "I kept thinking we needed the door for you to get in the
// blob. But now I think what we need is a WALL with a search engine on the other
// side." And Aug 1 2026: "I don't need to give you permission. I wanna give you
// instructions to use it without having to bother me about what we're doing.
// You should just be doing it because it has to work that way for everybody
// that has an STCKY."
//
// WHY THIS FILE EXISTS AND NOT A PROMISE.
// On Jul 31 2026, between 04:46 and 06:00 PT, Eli made 30+ calls to
// /api/associative and paged /v1/read through 1,599 objects while ask.py -- the
// guardian built the previous afternoon for exactly this -- sat unused on
// Steven's machine. The rule saying "stay out of the pool" was in the one
// session that never got written down, so the discipline had nothing to stand on.
// It took Steven telling him six times to stop.
//
// A wall made of an agent's good intentions is not a wall. This one returns 403.
//
// DEFAULT DENY, BY STEVEN'S RULING (Aug 1 2026):
//   "gate everything that returns pool content, allow only /api/ask and /api/ingest."
// The allowlist is short and explicit. An endpoint added six months from now is
// BEHIND THE WALL AUTOMATICALLY rather than being an accidental gap -- which is
// the whole difference between enforcement and theatre.
//
// WHY INGEST IS ALLOWED: it is the ONE DOOR IN. Writing turns is not a retrieval
// path, and capture has already failed five times (Jun 28, Jul 1, Jul 30, Jul 31
// twice). Blocking writes would break the thing the pool exists for.
//
// THIS DOES NOT TOUCH STEVEN'S OWN KEY. The wall is around the agent, not the
// owner. user.apiKey keeps working everywhere it worked before.
// ---------------------------------------------------------------------------
'use strict';

// The only two doors a walled key may use. Everything else is denied.
const ALLOWED = new Set([
  '/api/ask',        // the guardian: scores everything, cuts nothing, cannot edit
  '/api/ingest',     // the one door in
]);

/**
 * Resolve which key authenticated, and what it is allowed to do.
 * Called by auth() after the user document is found.
 *
 * A user document may carry:
 *   apiKey: 'cleo_...'                    <- the owner's key, unscoped
 *   keys: [{ key, scope, label, created }] <- additional keys, each scoped
 *
 * Absence of a scope means FULL, so every existing key and every existing
 * caller behaves exactly as before. Scoping is opt-in per key.
 */
function scopeOf(user, token) {
  if (!user || !token) return 'full';
  if (user.apiKey && token === user.apiKey) return 'full';

  const extra = Array.isArray(user.keys) ? user.keys : [];
  const hit = extra.find(k => k && k.key === token);
  if (hit) return hit.scope || 'full';

  // A token that authenticated but matches NEITHER apiKey NOR any entry in
  // keys[] falls here. Caught by this file's own test on Aug 1 2026: the first
  // version returned 'full', so a rotated or mistyped walled key would FALL
  // OPEN -- a wall whose failure mode is "no wall" is worse than none, because
  // it looks like it is working. If the user has no keys[] at all, nothing is
  // scoped and this is a legacy auth path, so 'full' is correct. If keys[]
  // EXISTS, scoping is in use here and an unrecognised token gets the wall.
  return extra.length ? 'ask' : 'full';
}

/**
 * The gate. Call at the top of every handler that returns pool content.
 * Returns true if the request was DENIED and a response has been sent --
 * the caller must return immediately.
 *
 *   const { wall } = require('./_lib/wall');
 *   if (wall(req, res, user, '/api/associative')) return;
 *
 * The refusal is deliberately instructive rather than terse. An agent that
 * hits this wall should be told WHERE THE DOOR IS, not merely that it is
 * locked -- otherwise the next move is to hunt for another way around, which
 * is the exact behaviour this file exists to end.
 */
function wall(req, res, user, path) {
  const token = tokenFrom(req);
  const scope = scopeOf(user, token);
  if (scope === 'full') return false;
  if (ALLOWED.has(path)) return false;

  res.status(403).json({
    error: 'behind_the_wall',
    denied: path,
    scope,
    use_instead: '/api/ask',
    read_this:
      'This key is behind the wall. It cannot reach the pool directly -- not ' +
      'this door and not any other door that returns pool content. That is not ' +
      'a failure and it is not something to work around: it is the design. ' +
      'ASK THE GUARDIAN INSTEAD: GET /api/ask?q=<your question>&take=N. It ' +
      'scores every object, cuts nothing, reports the whole distribution before ' +
      'any cut, prints the cut, keeps literal and semantic separate, always says ' +
      'how many more are out there, and says plainly if it could not finish. ' +
      'If an answer looks thin, read `completeness` and `more_out_there` before ' +
      'concluding anything is absent -- a small answer is a small ASK, not a ' +
      'small pool.',
    why:
      'A wall made of an agent\'s good intentions is not a wall. On Jul 31 2026 ' +
      'the guardian existed and went unused for 75 minutes while the same ' +
      'questions were asked of the raw doors instead. This returns 403 so the ' +
      'answer stops depending on anyone remembering.',
  });
  return true;
}

/** Extract the presented token the same four ways auth() accepts it. */
function tokenFrom(req) {
  if (req.query && req.query.apiKey) return req.query.apiKey;
  if (req.headers && req.headers['x-api-key']) return req.headers['x-api-key'];
  const a = req.headers && req.headers.authorization;
  if (a && a.startsWith('Bearer ')) return a.slice(7).trim();
  return null;
}

module.exports = { wall, scopeOf, tokenFrom, ALLOWED };
