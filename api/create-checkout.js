// api/create-checkout.js
//
// Creates a Stripe Checkout Session for a venue's setup_token.
// Called by setup.html when the user clicks "Pay".
//
// Body: { token: string }
// Returns: { checkout_url: string }

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const TEST_MODE = process.env.TEST_MODE === 'true';

const PRICE_IDS = {
  live: {
    founding: {
      solo:    'price_1TY20MJ8Zl4UEY21ceaQ5LX7',
      starter: 'price_1TY27AJ8Zl4UEY21ruN0GEBA',
      growth:  'price_1TY28OJ8Zl4UEY21WTrHqIIO',
    },
  },
  test: {
    founding: {
      solo:    'price_1TVnt7J8Zl4UEY21g6LT4aQf',
      starter: 'price_1TVpb4J8Zl4UEY212fUJFetT',
      growth:  'price_1TVpcWJ8Zl4UEY21nq6BaldQ',
    },
  },
};

const PUBLIC_SITE_URL = process.env.PUBLIC_SITE_URL || 'https://hiretrial.com.au';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://hiretrial.com.au');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ error: 'Missing token' });

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // Lookup venue + account
    const { data: venue, error: vErr } = await supabase
      .from('venues')
      .select(`
        id,
        name,
        manager_email,
        manager_name,
        account_id,
        accounts (
          id,
          business_name,
          billing_email,
          subscription_phase,
          subscription_tier,
          subscription_status,
          stripe_customer_id
        )
      `)
      .eq('setup_token', token)
      .maybeSingle();

    if (vErr || !venue) {
      console.error('[create-checkout] Venue lookup failed:', vErr);
      return res.status(404).json({ error: 'Venue not found' });
    }
    if (!venue.accounts) {
      return res.status(500).json({ error: 'Venue missing account link' });
    }

    const account = venue.accounts;

    // Already paid — bounce back to setup.html
    if (account.subscription_status === 'active') {
      return res.status(200).json({
        checkout_url: `${PUBLIC_SITE_URL}/setup.html?token=${token}`,
        already_paid: true,
      });
    }

    const phase = account.subscription_phase;
    const tier = account.subscription_tier;
    const priceSet = TEST_MODE ? PRICE_IDS.test : PRICE_IDS.live;
    const priceId = priceSet[phase]?.[tier];

    if (!priceId) {
      console.error('[create-checkout] No price ID for', phase, tier, TEST_MODE ? '(test)' : '(live)');
      return res.status(500).json({ error: `No price configured for ${phase} ${tier}` });
    }

    const stripeKey = TEST_MODE
      ? process.env.STRIPE_SECRET_KEY_TEST
      : process.env.STRIPE_SECRET_KEY_LIVE;

    const stripe = new Stripe(stripeKey, {
      apiVersion: '2024-11-20.acacia',
    });

    const customerEmail = venue.manager_email || account.billing_email;

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: account.stripe_customer_id ? undefined : customerEmail,
      customer: account.stripe_customer_id || undefined,
      client_reference_id: token,
      automatic_tax: { enabled: true },
      customer_update: account.stripe_customer_id ? { address: 'auto', name: 'auto' } : undefined,
      tax_id_collection: { enabled: true },
      billing_address_collection: 'required',
      success_url: `${PUBLIC_SITE_URL}/api/post-payment?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${PUBLIC_SITE_URL}/setup.html?token=${token}`,
      metadata: {
        venue_id: venue.id,
        account_id: account.id,
        setup_token: token,
        phase: phase,
        tier: tier,
      },
      subscription_data: {
        metadata: {
          venue_id: venue.id,
          account_id: account.id,
          phase: phase,
          tier: tier,
        },
      },
    });

    return res.status(200).json({ checkout_url: session.url });

  } catch (err) {
    console.error('[create-checkout] Error:', err);
    return res.status(500).json({ error: err.message || 'Checkout creation failed' });
  }
}
