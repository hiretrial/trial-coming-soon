// api/post-payment.js
//
// Stripe redirect handler. Stripe sends paid customers here with a session_id,
// we verify the payment, mint a one-time setup_token row in Supabase, then
// 302 the user to setup.html?token=<token>.
//
// This is the bridge between Stripe's `success_url` and our token-based setup
// flow. The token system was already in place for delegated multi-venue setup;
// we're just plugging Stripe into it.

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

// Map Stripe price IDs to plan metadata. When you add new prices in Stripe,
// add them here. Keep this map in sync with the live products.
//
// To find your price IDs: Stripe dashboard → Products → click a product →
// the price section shows IDs like `price_1ABC...`
const PLAN_BY_PRICE = {
  // === LIVE MODE ===
  // TODO: fill these in with actual live price IDs from Stripe
  // 'price_LIVE_solo_id_here':    { tier: 'solo',    venue_count: 1, monthly: 99.99, per_hire: 99 },
  // 'price_LIVE_starter_id_here': { tier: 'starter', venue_count: 3, monthly: 199,   per_hire: 89 },
  // 'price_LIVE_growth_id_here':  { tier: 'growth',  venue_count: 5, monthly: 349,   per_hire: 79 },

  // === TEST MODE ===
  // TODO: fill these in with actual test-mode price IDs if you want test flow to work
  // For tonight's test, we'll just use whatever Wave product you pay through —
  // the function below has a fallback that defaults to 'solo' if no match.
};

export default async function handler(req, res) {
  try {
    const sessionId = req.query.session_id;

    if (!sessionId) {
      console.error('[post-payment] No session_id in query');
      return res.redirect(302, '/setup.html'); // setup.html will render "invalid link"
    }

    // Pick the right Stripe key based on the session ID prefix.
    // Test sessions start with `cs_test_`, live with `cs_live_`.
    const isTest = sessionId.startsWith('cs_test_');
    const stripeKey = isTest
      ? process.env.STRIPE_SECRET_KEY_TEST
      : process.env.STRIPE_SECRET_KEY_LIVE;

    if (!stripeKey) {
      console.error('[post-payment] Missing Stripe key for mode:', isTest ? 'test' : 'live');
      return res.status(500).send('Server config error');
    }

    const stripe = new Stripe(stripeKey, { apiVersion: '2024-11-20.acacia' });

    // Pull the full checkout session — we need customer details, line items, subscription
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['customer', 'line_items', 'line_items.data.price']
    });

    console.log('[post-payment] Session retrieved:', sessionId, 'status:', session.payment_status);

    // Verify payment actually succeeded
    if (session.payment_status !== 'paid') {
      console.error('[post-payment] Session not paid:', session.payment_status);
      return res.status(400).send('Payment not completed');
    }

    // Extract details
    const customerEmail = session.customer_details?.email || session.customer?.email;
    const customerName = session.customer_details?.name || '';
    const businessName = session.custom_fields?.find(f => f.key === 'business_name')?.text?.value
                       || session.customer_details?.name
                       || '';
    const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
    const subscriptionId = session.subscription;

    // Figure out the plan from line items
    const lineItem = session.line_items?.data?.[0];
    const priceId = lineItem?.price?.id;
    let plan = PLAN_BY_PRICE[priceId];

    // Fallback if price not mapped — default to solo. We log so we notice.
    if (!plan) {
      console.warn('[post-payment] Unmapped price ID, defaulting to solo:', priceId);
      plan = { tier: 'solo', venue_count: 1, monthly: 99.99, per_hire: 99 };
    }

    // Write the setup_token row using service role (bypasses RLS)
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // Check if a token already exists for this session (idempotency — refresh-proof)
    const { data: existing } = await supabase
      .from('setup_tokens')
      .select('token')
      .eq('stripe_session_id', sessionId)
      .maybeSingle();

    let token;
    if (existing) {
      console.log('[post-payment] Token already exists for session, reusing:', existing.token);
      token = existing.token;
    } else {
      const { data: inserted, error: insertErr } = await supabase
        .from('setup_tokens')
        .insert({
          stripe_session_id: sessionId,
          stripe_customer_id: customerId,
          stripe_subscription_id: subscriptionId,
          plan_tier: plan.tier,
          venue_count: plan.venue_count,
          monthly_price: plan.monthly,
          per_hire_fee: plan.per_hire,
          phase: 'founding',
          business_name: businessName,
          group_owner_email: customerEmail,
          group_owner_name: customerName,
          type: 'master'
        })
        .select('token')
        .single();

      if (insertErr) {
        console.error('[post-payment] Supabase insert failed:', insertErr);
        return res.status(500).send('Setup token creation failed');
      }

      token = inserted.token;
      console.log('[post-payment] Created token:', token);
    }

    // Redirect to setup with the token
    return res.redirect(302, `/setup.html?token=${token}`);

  } catch (err) {
    console.error('[post-payment] Unexpected error:', err);
    return res.status(500).send('Something went wrong');
  }
}
