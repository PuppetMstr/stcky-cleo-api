const { MongoClient, ObjectId } = require('mongodb');
const Stripe = require('stripe');

const uri = process.env.MONGODB_URI;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const STRIPE_PRICES = {
  PRO_MONTHLY: 'price_1T9p7FENhbMbSh1CHzQptdPJ',
  PRO_YEARLY: 'price_1T9p9nENhbMbSh1CYISqKP6l',
  TEAM_MONTHLY: 'price_1T9pJVENhbMbSh1CNhuFxcR6',
  TEAM_YEARLY: 'price_1T9pQtENhbMbSh1CEOWDvyKU'
};

const TIER_LIMITS = {
  free: { memoryLimit: 100, projectLimit: 3 },
  pro: { memoryLimit: 10000, projectLimit: 50 },
  team: { memoryLimit: 100000, projectLimit: 500 }
};

const PRICE_TO_TIER = {
  'price_1T9p7FENhbMbSh1CHzQptdPJ': 'pro',
  'price_1T9p9nENhbMbSh1CYISqKP6l': 'pro',
  'price_1T9pJVENhbMbSh1CNhuFxcR6': 'team',
  'price_1T9pQtENhbMbSh1CEOWDvyKU': 'team'
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

function getAction(url) {
  if (url.includes('/stripe/webhook')) return 'webhook';
  return 'checkout';
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Stripe-Signature');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  
  const action = getAction(req.url);
  
  // ============ WEBHOOK ============
  if (action === 'webhook') {
    const sig = req.headers['stripe-signature'];
    if (!sig) return res.status(400).json({ error: 'Missing stripe-signature header' });
    
    let event, rawBody;
    
    try {
      rawBody = await getRawBody(req);
      event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error('Webhook signature verification failed:', err.message);
      return res.status(400).json({ error: `Webhook Error: ${err.message}` });
    }
    
    console.log(`Stripe webhook received: ${event.type}`);
    
    try {
      const db = await getDb();
      
      switch (event.type) {
        case 'checkout.session.completed': await handleCheckoutCompleted(db, event.data.object); break;
        case 'customer.subscription.created':
        case 'customer.subscription.updated': await handleSubscriptionUpdate(db, event.data.object); break;
        case 'customer.subscription.deleted': await handleSubscriptionCanceled(db, event.data.object); break;
        case 'invoice.payment_failed': await handlePaymentFailed(db, event.data.object); break;
        default: console.log(`Unhandled event type: ${event.type}`);
      }
      
      return res.json({ received: true });
    } catch (error) {
      console.error('Webhook handler error:', error);
      return res.status(500).json({ error: 'Webhook handler failed' });
    }
  }
  
  // ============ CHECKOUT ============
  let { email, plan, billing, priceId } = req.body;
  
  if (!email) return res.status(400).json({ error: 'email is required' });
  
  if (!priceId && plan && billing) {
    const key = `${plan.toUpperCase()}_${billing.toUpperCase()}`;
    priceId = STRIPE_PRICES[key];
    if (!priceId) return res.status(400).json({ error: `Invalid plan/billing: ${plan}/${billing}` });
  }
  
  if (!priceId) return res.status(400).json({ error: 'priceId or (plan + billing) required' });
  
  try {
    const db = await getDb();
    const user = await db.collection('users').findOne({ email: email.toLowerCase() });
    
    if (!user) return res.status(404).json({ error: 'User not found. Please sign up first.' });
    
    let customerId = user.stripeCustomerId;
    
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { userId: user._id.toString() }
      });
      customerId = customer.id;
      await db.collection('users').updateOne({ _id: user._id }, { $set: { stripeCustomerId: customerId, updatedAt: new Date() }});
    }
    
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      success_url: `https://stcky.ai/dashboard?payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `https://stcky.ai/pricing?payment=canceled`,
      metadata: { userId: user._id.toString(), priceId },
      subscription_data: { metadata: { userId: user._id.toString() }}
    });
    
    res.json({ success: true, checkoutUrl: session.url, sessionId: session.id });
  } catch (error) {
    console.error('Stripe checkout error:', error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
};

// Webhook handlers
async function handleCheckoutCompleted(db, session) {
  const userId = session.metadata?.userId;
  const customerId = session.customer;
  const customerEmail = session.customer_email || session.customer_details?.email;
  
  let user;
  if (userId) user = await db.collection('users').findOne({ _id: new ObjectId(userId) });
  if (!user && customerId) user = await db.collection('users').findOne({ stripeCustomerId: customerId });
  if (!user && customerEmail) user = await db.collection('users').findOne({ email: customerEmail.toLowerCase() });
  if (!user) { console.error(`User not found for checkout: ${session.id}`); return; }
  
  await db.collection('users').updateOne({ _id: user._id }, { $set: { stripeCustomerId: customerId, paymentProvider: 'stripe', updatedAt: new Date() }});
  console.log(`Checkout completed for ${user.email}`);
}

async function handleSubscriptionUpdate(db, subscription) {
  const customerId = subscription.customer;
  const userId = subscription.metadata?.userId;
  
  let user;
  if (userId) user = await db.collection('users').findOne({ _id: new ObjectId(userId) });
  if (!user) user = await db.collection('users').findOne({ stripeCustomerId: customerId });
  if (!user) { console.error(`User not found for subscription: ${subscription.id}`); return; }
  
  const priceId = subscription.items.data[0]?.price?.id;
  const tier = PRICE_TO_TIER[priceId] || 'pro';
  const limits = TIER_LIMITS[tier];
  
  const updateData = {
    subscriptionId: subscription.id, subscriptionPriceId: priceId, subscriptionStatus: subscription.status,
    currentPeriodEnd: new Date(subscription.current_period_end * 1000), paymentProvider: 'stripe', updatedAt: new Date()
  };
  
  if (subscription.status === 'active' || subscription.status === 'trialing') {
    updateData.plan = tier;
    updateData.memoryLimit = limits.memoryLimit;
    updateData.projectLimit = limits.projectLimit;
  }
  
  await db.collection('users').updateOne({ _id: user._id }, { $set: updateData });
  console.log(`Subscription ${subscription.status} for ${user.email}: ${tier}`);
}

async function handleSubscriptionCanceled(db, subscription) {
  const user = await db.collection('users').findOne({ stripeCustomerId: subscription.customer });
  if (!user) { console.error(`User not found for canceled subscription: ${subscription.id}`); return; }
  
  await db.collection('users').updateOne({ _id: user._id }, { $set: {
    plan: 'free', memoryLimit: 100, projectLimit: 3, subscriptionStatus: 'canceled',
    currentPeriodEnd: new Date(subscription.current_period_end * 1000), updatedAt: new Date()
  }});
  console.log(`Subscription canceled for ${user.email}`);
}

async function handlePaymentFailed(db, invoice) {
  const user = await db.collection('users').findOne({ stripeCustomerId: invoice.customer });
  if (!user) return;
  await db.collection('users').updateOne({ _id: user._id }, { $set: { subscriptionStatus: 'past_due', updatedAt: new Date() }});
  console.log(`Payment failed for ${user.email}`);
}

module.exports.config = { api: { bodyParser: false } };
