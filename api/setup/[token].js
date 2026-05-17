// api/setup/[token].js
//
// Token resolver — setup.html calls this on page load to get the deal info
// + whether payment has already happened.

import { createClient } from '@supabase/supabase-js';

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

    const { data: row, error } = await supabase
      .from('setup_tokens')
      .select('*')
      .eq('token', token)
      .maybeSingle();

    if (error) {
      console.error('[setup/token] Supabase error:', error);
      return res.status(500).json({ error: 'Database error' });
    }

    if (!row) {
      return res.status(404).json({ error: 'Token not found' });
    }

    if (new Date(row.expires_at) < new Date()) {
      return res.status(410).json({ error: 'Token expired' });
    }

    // Reshape DB row into format setup.html expects (matches MOCK_TOKENS)
    let payload;

    if (row.type === 'master') {
      payload = {
        type: 'master',
        groupOwnerName: row.group_owner_name || '',
        groupOwnerEmail: row.group_owner_email,
        businessName: row.business_name || row.group_owner_name || 'Your business',
        phase: row.phase,
        tier: row.plan_tier,
        venueCount: row.venue_count,
        billingCycle: 'monthly',
        monthly: parseFloat(row.monthly_price),
        perHire: parseFloat(row.per_hire_fee),
        annualYearly: null,
        // NEW: tell setup.html if payment is already confirmed
        paid: !!row.paid_at,
        paidAt: row.paid_at,
        venues: row.venue_count === 1
          ? [{ idx: 1, inbox: slugifyToInbox(row.business_name) }]
          : Array.from({ length: row.venue_count }, (_, i) => ({
              idx: i + 1,
              inbox: `${slugifyToInbox(row.business_name)}-${i + 1}@inbound.hiretrial.com.au`
            }))
      };
    } else if (row.type === 'venue') {
      payload = {
        type: 'venue',
        dispatcherName: row.group_owner_name || '',
        businessName: row.business_name || '',
        venueName: row.venue_name || '',
        venueInbox: row.venue_inbox || '',
        managerEmail: row.manager_email || '',
        managerName: row.manager_name || '',
        phase: row.phase,
        tier: row.plan_tier,
        // Venue-type tokens don't have their own payment — they inherit from master
        paid: true
      };
    }

    return res.status(200).json(payload);

  } catch (err) {
    console.error('[setup/token] Unexpected error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

function slugifyToInbox(name) {
  if (!name) return 'venue@inbound.hiretrial.com.au';
  const slug = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 40);
  return `${slug || 'venue'}@inbound.hiretrial.com.au`;
}
