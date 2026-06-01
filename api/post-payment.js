// api/post-payment.js
//
// Stripe redirects here after Checkout completes.
// Looks up the venue via client_reference_id (setup_token), flips the
// account to 'active', stores Stripe IDs, then redirects to setup.html.

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

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

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status !== 'paid') {
      return res.status(400).send('Payment not completed');
    }

    const setupToken = session.client_reference_id;
    if (!setupToken) {
      console.error('[post-payment] No client_reference_id on session', sessionId);
      return res.status(400).send('Missing setup token reference');
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // Lookup venue + account by setup_token
    const { data: venue, error: vErr } = await supabase
      .from('venues')
      .select('id, account_id, name, manager_name, manager_email, inbound_address, accounts(id, subscription_status, billing_email, subscription_tier)')
      .eq('setup_token', setupToken)
      .maybeSingle();

    if (vErr || !venue) {
      console.error('[post-payment] Venue lookup failed:', vErr);
      return res.status(404).send('Venue not found for this session');
    }
    if (!venue.accounts) {
      return res.status(500).send('Venue missing account link');
    }

    // Idempotency — if account is already active, just redirect
    if (venue.accounts.subscription_status === 'active') {
      return res.redirect(302, `/setup.html?token=${setupToken}`);
    }

    const customerId = typeof session.customer === 'string'
      ? session.customer
      : session.customer?.id;
    const subscriptionId = typeof session.subscription === 'string'
      ? session.subscription
      : session.subscription?.id;

    const nowIso = new Date().toISOString();

    // Update account → active
    const { error: accErr } = await supabase
      .from('accounts')
      .update({
        subscription_status: 'active',
        subscription_started_at: nowIso,
        stripe_customer_id: customerId,
        stripe_subscription_id: subscriptionId,
        updated_at: nowIso,
      })
      .eq('id', venue.account_id);

    if (accErr) {
      console.error('[post-payment] Account update failed:', accErr);
      return res.status(500).send('Account activation failed');
    }

    // Mirror Stripe IDs onto the venue row (handy for venue-level views)
    const { error: vUpdErr } = await supabase
      .from('venues')
      .update({
        stripe_customer_id: customerId,
        stripe_subscription_id: subscriptionId,
        updated_at: nowIso,
      })
      .eq('id', venue.id);

    if (vUpdErr) {
      console.warn('[post-payment] Venue mirror update failed (account already active):', vUpdErr);
      // Non-fatal — account is active, venue mirror is bonus
    }

    console.log(`[post-payment] ✅ Activated account ${venue.account_id} via token ${setupToken}`);

    // ─── Send welcome email ───
    try {
      const { sendVenueWelcomeEmail } = await import('../lib/welcome-email.js');
      await sendVenueWelcomeEmail({
        to: venue.manager_email || venue.accounts?.billing_email,
        venueName: venue.name,
        contactName: venue.manager_name,
        inboundAddress: venue.inbound_address,
        planKey: venue.accounts?.subscription_tier || 'solo',
        dashboardUrl: 'https://dashboard.hiretrial.com.au',
      });
      console.log('[post-payment] Welcome email sent:', venue.name);
    } catch (emailErr) {
      console.error('[post-payment] Welcome email failed (non-fatal):', emailErr);
    }

    return res.redirect(302, `/setup.html?token=${setupToken}`);

  } catch (err) {
    console.error('[post-payment] Error:', err);
    return res.status(500).send('Something went wrong');
  }
}
