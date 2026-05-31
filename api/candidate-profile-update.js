// api/candidate-profile-update.js
//
// Updates candidate consent preferences from the profile page.
// Authenticated via unsubscribe_token — no login required.

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { token, field, value } = req.body || {};

  if (!token || !field || typeof value !== 'boolean') {
    return res.status(400).json({ error: 'Missing or invalid payload' });
  }

  const ALLOWED_FIELDS = ['talent_network_opt_in', 'score_reuse_consent'];
  if (!ALLOWED_FIELDS.includes(field)) {
    return res.status(400).json({ error: 'Invalid field' });
  }

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // ─── 1. Verify token resolves to a candidate ───
    const { data: candidate, error: cErr } = await supabase
      .from('candidates')
      .select('id')
      .eq('unsubscribe_token', token)
      .maybeSingle();

    if (cErr || !candidate) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    // ─── 2. Build update payload ───
    const update = { [field]: value };
    const now = new Date().toISOString();

    if (field === 'talent_network_opt_in') {
      if (value) {
        update.talent_network_opt_in_at = now;
        update.talent_network_opt_out_at = null;
        update.profile_visible = true;
      } else {
        update.talent_network_opt_out_at = now;
        update.profile_visible = false;
      }
    }

    if (field === 'score_reuse_consent') {
      update.score_reuse_consent_at = value ? now : null;
    }

    // ─── 3. Apply update ───
    const { error: updateErr } = await supabase
      .from('candidates')
      .update(update)
      .eq('id', candidate.id);

    if (updateErr) {
      console.error('[candidate-profile-update] Update failed:', updateErr);
      return res.status(500).json({ error: 'Update failed' });
    }

    console.log('[candidate-profile-update] Updated:', { candidate_id: candidate.id, field, value });
    return res.status(200).json({ ok: true, field, value });

  } catch (err) {
    console.error('[candidate-profile-update] Unexpected error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
