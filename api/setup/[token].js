// api/setup/[token].js
//
// Token resolver — setup.html calls this on page load to figure out which
// scenario to render (master/venue, plan tier, business name, etc).
//
// Replaces the hardcoded MOCK_TOKENS map in setup.html. Validates the token
// is real, unexpired, unconsumed, then returns the same shape MOCK_TOKENS
// used so setup.html doesn't need to change shape.

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  // Pull the token from the dynamic path segment
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
      console.log('[setup/token] Token not found:', token);
      return res.status(404).json({ error: 'Token not found' });
    }

    // Check expiry
    if (new Date(row.expires_at) < new Date()) {
      console.log('[setup/token] Token expired:', token);
      return res.status(410).json({ error: 'Token expired' });
    }

    // Note: we deliberately don't block on consumed_at here. setup.html uses
    // localStorage to track per-token progress, so a returning user can finish
    // a flow they started even if they completed payment hours ago. The
    // consumed_at flag is set when password is set at the end of the flow —
    // and at that point Auth handles re-entry, not this endpoint.

    // Reshape the DB row into the format setup.html expects (matches MOCK_TOKENS)
    let payload;

    if (row.type === 'master') {
      // Master mode — group owner, paid, possibly multi-venue
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
        // Generate venue placeholder data — for solo this is one venue using
        // the business name as the slug source. For multi, the user names
        // each venue in the dispatch step (we don't pre-fill).
        venues: row.venue_count === 1
          ? [{ idx: 1, inbox: slugifyToInbox(row.business_name) }]
          : Array.from({ length: row.venue_count }, (_, i) => ({
              idx: i + 1,
              inbox: `${slugifyToInbox(row.business_name)}-${i + 1}@inbound.hiretrial.com.au`
            }))
      };
    } else if (row.type === 'venue') {
      // Venue mode — delegated manager. (Not used tonight, but plumbing is here
      // for when group owners dispatch to their managers.)
      payload = {
        type: 'venue',
        dispatcherName: row.group_owner_name || '',
        businessName: row.business_name || '',
        venueName: row.venue_name || '',
        venueInbox: row.venue_inbox || '',
        managerEmail: row.manager_email || '',
        managerName: row.manager_name || '',
        phase: row.phase,
        tier: row.plan_tier
      };
    }

    return res.status(200).json(payload);

  } catch (err) {
    console.error('[setup/token] Unexpected error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

// Slugify business name into an email-safe local-part.
// Matches the logic in setup.html (slugifyVenueName) for consistency.
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
