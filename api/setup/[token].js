// api/setup/[token].js
//
// Token resolver — setup.html calls this on page load to get the deal info
// + whether payment has already happened.
//
// READS FROM: venues.setup_token (NEW — written by approve-eoi.ts).
// Joins to accounts for tier/phase/pricing/billing info.
//
// Returns the 'master' shape setup.html expects. Multi-venue dispatch is a
// separate path (api/setup/dispatch/[token].js) for Starter/Growth tokens
// owned by the group owner — not built yet, deferred until first multi-venue
// Founding Partner signs up.

import { createClient } from '@supabase/supabase-js';

// ─── Pricing source of truth (matches approve-eoi.ts) ─────────────
// Lives here too because the resolver needs to return monthly + perHire to
// setup.html for the deal-confirmation card. If pricing ever changes, update
// both files — or extract to a shared module in api/_lib/.
const PRICING = {
  founding: {
    solo:    { monthly: 99.99, perHire: 99 },
    starter: { monthly: 199.00, perHire: 89 },
    growth:  { monthly: 349.00, perHire: 79 },
    enterprise: { monthly: null, perHire: null },
  },
  standard: {
    solo:    { monthly: 129.99, perHire: 79 },
    starter: { monthly: 249.00, perHire: 99 },
    growth:  { monthly: 499.00, perHire: 135 },
    enterprise: { monthly: null, perHire: null },
  },
};

// ─── Venue-count defaults per tier (matches approve-eoi.ts) ───────
const DEFAULT_VENUE_COUNT = {
  solo: 1,
  starter: 2,
  growth: 4,
  enterprise: 6,
};

export default async function handler(req, res) {
  const { token } = req.query;
  if (!token) {
    return res.status(400).json({ error: 'Missing token' });
  }

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // ─── Lookup venue by setup_token, pull joined account ───
    const { data: venue, error: vErr } = await supabase
      .from('venues')
      .select(`
        id,
        name,
        slug,
        inbound_address,
        status,
        manager_email,
        manager_name,
        contact_email,
        contact_name,
        setup_dispatched_at,
        setup_completed_at,
        account_id,
        accounts (
          id,
          business_name,
          billing_email,
          billing_contact_name,
          subscription_phase,
          subscription_tier,
          subscription_status,
          declared_venue_count,
          subscription_started_at
        )
      `)
      .eq('setup_token', token)
      .maybeSingle();

    if (vErr) {
      console.error('[setup/token] Supabase error:', vErr);
      return res.status(500).json({ error: 'Database error' });
    }
    if (!venue) {
      return res.status(404).json({ error: 'Token not found' });
    }
    if (!venue.accounts) {
      console.error('[setup/token] Venue has no account_id link:', venue.id);
      return res.status(500).json({ error: 'Venue missing account link' });
    }

    // ─── Expiry: 14 days from dispatch ─────────────────────────────
    // Approve-eoi.ts sets setup_dispatched_at on insert. If the link is older
    // than 14 days, refuse. Operator can re-dispatch from TrialHQ.
    if (venue.setup_dispatched_at) {
      const dispatchedAt = new Date(venue.setup_dispatched_at).getTime();
      const expiresAt = dispatchedAt + (14 * 24 * 60 * 60 * 1000);
      if (Date.now() > expiresAt) {
        return res.status(410).json({ error: 'Token expired' });
      }
    }

    const account = venue.accounts;
    const phase = account.subscription_phase; // 'founding' | 'standard'
    const tier = account.subscription_tier;   // 'solo' | 'starter' | 'growth' | 'enterprise'

    // Pricing lookup
    const price = PRICING[phase]?.[tier] || { monthly: null, perHire: null };

    // Venue count — use account's declared, fallback to tier default
    const venueCount = account.declared_venue_count || DEFAULT_VENUE_COUNT[tier] || 1;

    // Is this paid yet? Account-level source of truth.
    const isPaid = account.subscription_status === 'active';

    // ─── Shape the response setup.html expects ─────────────────────
    // For now, only 'master' type tokens exist (approve-eoi.ts creates one
    // venue + one account per EOI approval). Multi-venue dispatch deferred.
    const payload = {
      type: 'master',
      groupOwnerName: venue.manager_name || account.billing_contact_name || '',
      groupOwnerEmail: venue.manager_email || account.billing_email,
      businessName: account.business_name || venue.name,
      phase: phase,
      tier: tier,
      venueCount: venueCount,
      billingCycle: 'monthly', // annual unlocks at 6mo in dashboard
      monthly: price.monthly,
      perHire: price.perHire,
      annualYearly: null,
      paid: isPaid,
      paidAt: account.subscription_started_at,
      // Single-venue case: one row in venues array using this venue's inbound_address.
      // Multi-venue dispatch builds these dynamically once that flow ships.
      venues: [{
        idx: 1,
        inbox: venue.inbound_address,
      }],
    };

    return res.status(200).json(payload);

  } catch (err) {
    console.error('[setup/token] Unexpected error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
