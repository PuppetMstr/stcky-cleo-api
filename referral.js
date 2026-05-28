// /api/referral
//
// GET â€” returns the authenticated user's referral code, link, and stats.
// Generates a referral code on first call if the user doesn't have one yet.
//
// Auth: Bearer apiKey (user.apiKey) â€” anyone signed in can see their own referral data.

const { ObjectId } = require('mongodb');
const { auth, getDb, cors } = require('./_lib/auth');
const { ensureReferralCode } = require('./_lib/referral');

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

  const user = await auth(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const { code, link } = await ensureReferralCode(user._id);

    // Read fresh user state (auth() may have stale view if code was just generated)
    const db = await getDb();
    const fresh = await db.collection('users').findOne({ _id: user._id });

    const referrals = Array.isArray(fresh.referrals) ? fresh.referrals : [];
    const sales = Array.isArray(fresh.sales) ? fresh.sales : [];

    const total_referrals = referrals.length;
    const total_paid_referrals = referrals.filter(r => r.converted).length;
    const conversion_rate = total_referrals > 0
      ? Math.round((total_paid_referrals / total_referrals) * 100)
      : 0;
    const total_credit_earned = Number(fresh.total_credit_earned || 0);
    const pending_credit = Number(fresh.pending_credit || 0);
    const applied_credit = Number(fresh.applied_credit || 0);

    return res.status(200).json({
      referral_code: code,
      referral_link: link,
      stats: {
        total_referrals,
        total_paid_referrals,
        conversion_rate,
        total_credit_earned,
        pending_credit,
        applied_credit,
      },
      referrals: referrals.map(r => ({
        user_email: r.user_email,
        signup_date: r.signup_date,
        converted: !!r.converted,
        first_purchase: r.first_purchase || null,
      })),
      sales: sales.map(s => ({
        referee_email: s.referee_email,
        amount: s.amount,
        credit: s.commission,
        date: s.date,
        status: s.status,
      })),
    });
  } catch (e) {
    console.error('[referral] handler error', e);
    return res.status(500).json({ error: 'internal_error' });
  }
};
