// stripe.js
// STCKY billing handler. Routes both /api/stripe/checkout and /api/stripe/webhook
// based on req.url.
//
// Tier model (matches chat.js):
//   basic        - free, localStorage only, stateless /api/chat
//   paid         - $9/mo or $90/yr, server-side substrate, substrate-aware /api/chat
//   basic-grace  - was paid, cancelled or never converted; same routing as basic
//                  (stateless), but flagged for warm-conversion email campaign
//   founder      - Steven
//
// Required env vars (set in Vercel):
//   MONGODB_URI            - Atlas connection string
//   STRIPE_SECRET_KEY      - sk_live_... from Stripe dashboard
//   STRIPE_WEBHOOK_SECRET  - whsec_... from Stripe webhook endpoint setup

const { MongoClient, ObjectId } = require('mongodb');
const Stripe = require('stripe');

const uri = process.env.MONGODB_URI;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// STCKY prices in Mediaseduction Stripe account, created May 24 2026
const STRIPE_PRICES = {
  PAID_MONTHLY: 'price_1Tad25EJLJxQRRt2Ne8SmCGn',  // $9/mo
  PAID_YEARLY:  'price_1TacoZEJLJxQRRt2L83pdNDd',  // $90/yr
};

// Every active price maps to tier 'paid'. Single-tier launch.
const PRICE_TO_TIER = {
  [STRIPE_PRICES.PAID_MONTHLY]: 'paid',
  [STRIPE_PRICES.PAID_YEARLY]:  'paid',
};

async function getDb() {
  const client = new MongoClient(uri);
  await client.connect();
  return client.db('cleo');
}

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function isWebhook(req) {
  return (req.url || '').includes('/stripe/webhook');
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Stripe-Signature, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (isWebhook(req)) return handleWebhook(req, res);
  return handleCheckout(req, res);
};

// ===================== CHECKOUT =====================
// Body: { email, plan?, billing?, priceId? }
//   - Either priceId directly, OR (plan + billing) which we resolve.
//   - plan ignored for now (single-tier launch); billing in {monthly|yearly}.
async function handleCheckout(req, res) {
  // bodyParser is off file-wide (required for webhook signature verification),
  // so checkout reads + parses the raw body here.
  let body;
  try {
    const raw = await getRawBody(req);
    body = raw ? JSON.parse(raw) : {};
  } catch (err) {
    return res.status(400).json({ error: 'invalid json body' });
  }

  let { email, plan, billing, priceId } = body;

  if (!email) return res.status(400).json({ error: 'email is required' });
  if (typeof email !== 'string') return res.status(400).json({ error: 'email must be a string' });

  if (!priceId && billing) {
    const key = `PAID_${String(billing).toUpperCase()}`;
    priceId = STRIPE_PRICES[key];
    if (!priceId) {
      return res.status(400).json({ error: `Invalid billing period: ${billing}. Use 'monthly' or 'yearly'.` });
    }
  }

  if (!priceId) {
    return res.status(400).json({ error: "priceId or billing ('monthly' | 'yearly') required" });
  }

  try {
    const db = await getDb();
    const user = await db.collection('users').findOne({ email: email.toLowerCase() });

    if (!user) {
      // Don't auto-create here; signup happens via /api/claim. Tell caller to sign up first.
      return res.status(404).json({ error: 'User not found. Please sign up first.' });
    }

    // Get or create Stripe customer
    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { userId: user._id.toString() },
      });
      customerId = customer.id;
      await db.collection('users').updateOne(
        { _id: user._id },
        { $set: { stripeCustomerId: customerId, updatedAt: new Date() } }
      );
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      success_url: 'https://stcky.ai/success.html?payment=success&session_id={CHECKOUT_SESSION_ID}',
      cancel_url:  'https://stcky.ai/pricing?payment=canceled',
      metadata: { userId: user._id.toString(), priceId },
      subscription_data: { metadata: { userId: user._id.toString() } },
    });

    return res.status(200).json({
      success: true,
      checkoutUrl: session.url,
      sessionId: session.id,
    });
  } catch (error) {
    console.error('[stripe checkout] error:', error.message);
    return res.status(500).json({ error: 'Failed to create checkout session' });
  }
}

// ===================== WEBHOOK =====================
async function handleWebhook(req, res) {
  const sig = req.headers['stripe-signature'];
  if (!sig) return res.status(400).json({ error: 'Missing stripe-signature header' });

  let event;
  try {
    const rawBody = await getRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[stripe webhook] signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  console.log(`[stripe webhook] event: ${event.type} (${event.id})`);

  try {
    const db = await getDb();

    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(db, event.data.object);
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await handleSubscriptionUpdate(db, event.data.object);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionCanceled(db, event.data.object);
        break;
      case 'invoice.payment_failed':
        await handlePaymentFailed(db, event.data.object);
        break;
      default:
        console.log(`[stripe webhook] unhandled event type: ${event.type}`);
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error('[stripe webhook] handler error:', error.message);
    return res.status(500).json({ error: 'Webhook handler failed' });
  }
}

// Find user by metadata userId, then stripeCustomerId, then email
async function findUser(db, { metadataUserId, customerId, email }) {
  if (metadataUserId) {
    try {
      const u = await db.collection('users').findOne({ _id: new ObjectId(metadataUserId) });
      if (u) return u;
    } catch (e) { /* invalid ObjectId, fall through */ }
  }
  if (customerId) {
    const u = await db.collection('users').findOne({ stripeCustomerId: customerId });
    if (u) return u;
  }
  if (email) {
    const u = await db.collection('users').findOne({ email: email.toLowerCase() });
    if (u) return u;
  }
  return null;
}

async function handleCheckoutCompleted(db, session) {
  const user = await findUser(db, {
    metadataUserId: session.metadata && session.metadata.userId,
    customerId: session.customer,
    email: session.customer_email || (session.customer_details && session.customer_details.email),
  });
  if (!user) {
    console.error(`[stripe] user not found for checkout session ${session.id}`);
    return;
  }

  // Persist customer link if not already set. Tier flip happens via subscription.updated,
  // which fires immediately after checkout for subscription mode.
  await db.collection('users').updateOne(
    { _id: user._id },
    { $set: {
        stripeCustomerId: session.customer,
        paymentProvider: 'stripe',
        lastCheckoutAt: new Date(),
        updatedAt: new Date(),
    } }
  );
  console.log(`[stripe] checkout completed for ${user.email}`);
}

async function handleSubscriptionUpdate(db, subscription) {
  const user = await findUser(db, {
    metadataUserId: subscription.metadata && subscription.metadata.userId,
    customerId: subscription.customer,
  });
  if (!user) {
    console.error(`[stripe] user not found for subscription ${subscription.id}`);
    return;
  }

  const priceId = subscription.items && subscription.items.data[0] && subscription.items.data[0].price && subscription.items.data[0].price.id;
  const mappedTier = PRICE_TO_TIER[priceId] || 'paid';

  const updateData = {
    subscriptionId: subscription.id,
    subscriptionPriceId: priceId,
    subscriptionStatus: subscription.status,
    currentPeriodEnd: subscription.current_period_end ? new Date(subscription.current_period_end * 1000) : null,
    cancelAtPeriodEnd: !!subscription.cancel_at_period_end,
    paymentProvider: 'stripe',
    updatedAt: new Date(),
  };

  // Tier flips only on active/trialing. Other statuses leave tier alone here;
  // cancellation and payment-failure are handled in their own webhook events.
  if (subscription.status === 'active' || subscription.status === 'trialing') {
    updateData.tier = mappedTier;
    // Clear grace flag if user was in grace and is now back on paid
    updateData.grace_started_at = null;
  }

  await db.collection('users').updateOne({ _id: user._id }, { $set: updateData });
  console.log(`[stripe] subscription ${subscription.status} for ${user.email}: tier=${updateData.tier || user.tier}`);

  // If subscription is now active/trialing, check for referral conversion credit.
  if (updateData.tier === 'paid') {
    const freshUser = await db.collection('users').findOne({ _id: user._id });
    await maybeProcessReferralConversion(db, freshUser);
  }
}

async function handleSubscriptionCanceled(db, subscription) {
  const user = await findUser(db, {
    metadataUserId: subscription.metadata && subscription.metadata.userId,
    customerId: subscription.customer,
  });
  if (!user) {
    console.error(`[stripe] user not found for canceled subscription ${subscription.id}`);
    return;
  }

  // Warm handoff: don't drop straight to basic.
  // Move to basic-grace with timestamp; email/UI layer uses this to invite reactivation.
  // Substrate is preserved server-side indefinitely; chat.js routes them through stateless
  // mode same as basic until they reactivate.
  await db.collection('users').updateOne(
    { _id: user._id },
    { $set: {
        tier: 'basic-grace',
        grace_started_at: new Date(),
        subscriptionStatus: 'canceled',
        currentPeriodEnd: subscription.current_period_end ? new Date(subscription.current_period_end * 1000) : null,
        updatedAt: new Date(),
    } }
  );
  console.log(`[stripe] subscription canceled for ${user.email} -> tier=basic-grace`);
}

async function handlePaymentFailed(db, invoice) {
  const user = await findUser(db, { customerId: invoice.customer });
  if (!user) {
    console.error(`[stripe] user not found for failed invoice ${invoice.id}`);
    return;
  }

  // Don't change tier on first failure. Stripe retries 3 times over ~3 weeks.
  // If Stripe eventually cancels, customer.subscription.deleted webhook fires
  // and handleSubscriptionCanceled does the basic-grace transition.
  await db.collection('users').updateOne(
    { _id: user._id },
    { $set: {
        subscriptionStatus: 'past_due',
        lastPaymentFailedAt: new Date(),
        updatedAt: new Date(),
    } }
  );
  console.log(`[stripe] payment failed for ${user.email}`);
}


// REFERRAL_CREDIT_INJECTED
// When a user's subscription becomes active for the first time, check whether
// they were referred. If yes, credit the referrer's Stripe customer balance
// with $9 (one-time per referee), mark the referral as converted, and record
// the credit on the referrer's record.
async function maybeProcessReferralConversion(db, user) {
  try {
    if (!user || !user.referred_by) return;

    let referrerObjectId;
    try { referrerObjectId = new ObjectId(user.referred_by); }
    catch (e) { return; }

    const referrer = await db.collection('users').findOne({ _id: referrerObjectId });
    if (!referrer) return;

    // Already credited for this specific referee?
    const userIdStr = user._id.toString();
    const alreadyCredited = (referrer.sales || []).some(s =>
      s.referee_user_id && s.referee_user_id.toString() === userIdStr
    );
    if (alreadyCredited) {
      console.log('[referral] already credited', referrer.email, 'for', user.email);
      return;
    }

    // Ensure referrer has a Stripe customer (create one if needed)
    let stripeCustomerId = referrer.stripeCustomerId;
    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: referrer.email,
        metadata: { userId: referrer._id.toString(), origin: 'referral_credit' }
      });
      stripeCustomerId = customer.id;
      await db.collection('users').updateOne(
        { _id: referrer._id },
        { $set: { stripeCustomerId, updatedAt: new Date() } }
      );
    }

    // Credit $9 to the referrer's Stripe customer balance.
    // Negative amount = balance increase = credit applied to next invoice.
    await stripe.customers.createBalanceTransaction(stripeCustomerId, {
      amount: -900,
      currency: 'usd',
      description: 'STCKY referral credit: ' + user.email + ' converted',
    });

    const now = new Date();

    // Mark the referee as converted in referrer's referrals[] array.
    await db.collection('users').updateOne(
      { _id: referrer._id, 'referrals.user_email': user.email },
      {
        $set: {
          'referrals.$.converted': true,
          'referrals.$.first_purchase': now,
          updatedAt: now,
        }
      }
    );

    // Append the sale and increment totals.
    await db.collection('users').updateOne(
      { _id: referrer._id },
      {
        $push: {
          sales: {
            referee_user_id: user._id,
            referee_email: user.email,
            amount: 9,
            commission: 9,
            date: now,
            status: 'paid',
          }
        },
        $inc: {
          total_paid_referrals: 1,
          total_credit_earned: 9,
          pending_credit: 9,
        },
        $set: { updatedAt: now }
      }
    );

    console.log('[referral] credited', referrer.email, '$9 for', user.email, 'conversion');
  } catch (err) {
    // Never let a referral error break the subscription update flow.
    console.error('[referral] processing error (non-fatal):', err.message);
  }
}

// File-wide raw body required for webhook signature verification.
// Checkout branch parses JSON itself from raw.
module.exports.config = { api: { bodyParser: false } };
