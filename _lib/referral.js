// _lib/referral.js
// STCKY referral system â€” code generation, lookups, link building.
// Adapted from C:\travel-platform\backend\models\Partner.js Mongoose pattern,
// translated to raw MongoDB driver and the cleo.users single-collection model.

const crypto = require('crypto');
const { ObjectId } = require('mongodb');
const { getDb } = require('./auth');

const REFERRAL_BASE_URL = process.env.REFERRAL_BASE_URL || 'https://stcky.ai';
const MAX_CODE_ATTEMPTS = 10;

// Build a candidate referral code in the shape FIRSTNAME26AB
// where FIRSTNAME = up to 6 letters of firstName (uppercase),
//       26 = last two digits of current year,
//       AB = 2 random base36 chars (0-9 A-Z)
function buildCode(firstName) {
  const namePart = (firstName || 'STCKY')
    .replace(/[^a-zA-Z]/g, '')
    .toUpperCase()
    .substring(0, 6) || 'STCKY';
  const yearPart = new Date().getFullYear().toString().slice(-2);
  // 2 chars from base36 â€” crypto.randomBytes gives hex, mod-friendly slice
  const randomPart = crypto.randomBytes(2).toString('hex').toUpperCase().substring(0, 2);
  return `${namePart}${yearPart}${randomPart}`;
}

function buildLink(code) {
  return `${REFERRAL_BASE_URL}/?ref=${code}`;
}

// Lazy-create the unique index on referral_code. Sparse so users without a
// code don't conflict. Safe to call repeatedly â€” MongoDB ignores duplicate
// index creation.
async function ensureReferralCodeIndex(db) {
  try {
    await db.collection('users').createIndex(
      { referral_code: 1 },
      { unique: true, sparse: true, name: 'referral_code_unique' }
    );
  } catch (e) {
    // Index may already exist with different options â€” leave it.
  }
}

// Look up the user's referral code, generating one if absent.
// Returns { code, link } from the user record.
async function ensureReferralCode(userId) {
  const db = await getDb();
  await ensureReferralCodeIndex(db);

  const users = db.collection('users');
  let userObjectId;
  try { userObjectId = (userId instanceof ObjectId) ? userId : new ObjectId(userId); }
  catch (e) { throw new Error(`invalid userId: ${userId}`); }

  const user = await users.findOne({ _id: userObjectId });
  if (!user) throw new Error(`user ${userId} not found`);

  if (user.referral_code) {
    return {
      code: user.referral_code,
      link: user.referral_link || buildLink(user.referral_code),
    };
  }

  // Generate unique code with collision retry
  let code = null;
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
    const candidate = buildCode(user.firstName);
    const existing = await users.findOne({ referral_code: candidate });
    if (!existing) { code = candidate; break; }
  }
  if (!code) {
    // Fallback to timestamp-based code if 10 attempts all collide
    code = `STCKY${Date.now().toString(36).toUpperCase()}`;
  }

  const link = buildLink(code);
  await users.updateOne(
    { _id: user._id },
    { $set: { referral_code: code, referral_link: link, updatedAt: new Date() } }
  );

  return { code, link };
}

// Find a user by their referral code (case-insensitive).
async function findUserByReferralCode(code) {
  if (!code || typeof code !== 'string') return null;
  const normalized = code.trim().toUpperCase();
  if (!normalized) return null;
  const db = await getDb();
  return db.collection('users').findOne({ referral_code: normalized });
}

module.exports = {
  ensureReferralCode,
  findUserByReferralCode,
  buildLink,
  buildCode, // exported for testing/inspection
};
