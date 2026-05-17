// api/post-payment.js
//
// Stripe redirect handler. Either:
// 1. Token already exists (TrialHQ created it before payment) → mark it paid
// 2. No token yet (static link / today's testing) → create one, mark it paid

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const PLAN_BY_PRICE = {
  // Fill in real Stripe price IDs later
};

export default async function handler(req, res) {
  try {
    const sessionId = req.query.session_id;
    if (!sessionId) return res.redirect(302, '/setup.html');

    const isTest = sessionId.startsWith('cs_test_');
    const stripeKey = isTest
      ? process.env.STRIPE_SECRET_KEY_TEST
      : process.env.STRIPE_SECRET_KEY_LIVE;

    if (!stripeKey) return res.status(500).send('Server config error');

    const stripe = new Stripe(stripeKey, { apiVersion: '2024-11-20.acacia' });

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['customer', 'line_items', 'line_items.data.price']
    });

    if (session.payment_status !== 'paid') {
      return res.status(400).send('Payment not completed');
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // ─── Scenario 1: token already exists (TrialHQ flow) ───
    if (session.client_reference_id) {
      const { data: existingToken } = await supabase
        .from('setup_tokens')
        .select('token, paid_at')
        .eq('token', session.client_reference_id)
        .maybeSingle();

      if (existingToken) {
        if (!existingToken.paid_at) {
          await supabase
            .from('setup_tokens')
            .update({
              paid_at: new Date().toISOString(),
              stripe_session_id_paid: sessionId
            })
            .eq('token', existingToken.token);
        }
        return res.redirect(302, `/setup.html?token=${existingToken.token}`);
      }
    }

    // ─── Scenario 2: no token yet — create one (today's static-link flow) ───
    const customerEmail = session.customer_details?.email || session.customer?.email;
    const customerName = session.customer_details?.name || '';
    const businessName = session.custom_fields?.find(f => f.key === 'business_name')?.text?.value
                       || session.customer_details?.name || '';
    const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
    const subscriptionId = session.subscription;

    const lineItem = session.line_items?.data?.[0];
    const priceId = lineItem?.price?.id;
    let plan = PLAN_BY_PRICE[priceId] || { tier: 'solo', venue_count: 1, monthly: 99.99, per_hire: 99 };

    // Idempotency — don't double-create if same session redirects twice
    const { data: existingBySession } = await supabase
      .from('setup_tokens')
      .select('token')
      .eq('stripe_session_id', sessionId)
      .maybeSingle();

    let token;
    if (existingBySession) {
      token = existingBySession.token;
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
          type: 'master',
          paid_at: new Date().toISOString(),
          stripe_session_id_paid: sessionId
        })
        .select('token')
        .single();

      if (insertErr) return res.status(500).send('Setup token creation failed');
      token = inserted.token;
    }

    return res.redirect(302, `/setup.html?token=${token}`);

  } catch (err) {
    console.error('[post-payment] Error:', err);
    return res.status(500).send('Something went wrong');
  }
}
