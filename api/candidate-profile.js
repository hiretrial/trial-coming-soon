// api/candidate-profile.js
//
// Returns a candidate's profile data for the profile page.
// Authenticated via unsubscribe_token — no login required.

import { createClient } from '@supabase/supabase-js';

const ROLE_LABELS = {
  'bartender': 'Bartender', 'bar-back': 'Bar Back', 'bar-manager': 'Bar Manager',
  'barista': 'Barista', 'cafe-allrounder': 'Café All-Rounder',
  'cafe-kitchen-hand': 'Kitchen Hand', 'cafe-manager': 'Café Manager',
  'duty-manager': 'Duty Manager', 'expediter': 'Expediter',
  'waiter': 'Waiter/Waitress', 'host': 'Host',
  'restaurant-manager': 'Restaurant Manager', 'supervisor': 'Supervisor'
};

function getCandidateLevel(tier) {
  return { 'A': 'Advanced', 'B': 'Intermediate', 'C': 'Foundation', 'D': 'Developing' }[tier] || 'Foundation';
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { token } = req.query;
  if (!token) {
    return res.status(400).json({ error: 'Missing token' });
  }

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // ─── 1. Load candidate by unsubscribe_token ───
    const { data: candidate, error: cErr } = await supabase
      .from('candidates')
      .select(`
        id, first_name, last_name, email,
        talent_network_opt_in, talent_network_opt_in_at,
        score_reuse_consent, score_reuse_consent_at,
        last_assessed_at, assessment_valid_until,
        availability_status, profile_visible
      `)
      .eq('unsubscribe_token', token)
      .maybeSingle();

    if (cErr || !candidate) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    // ─── 2. Load their scored assessments ───
    const { data: assessments } = await supabase
      .from('assessments')
      .select('id, role, tier, overall_score, scored_at')
      .eq('candidate_id', candidate.id)
      .not('tier', 'is', null)
      .not('overall_score', 'is', null)
      .order('scored_at', { ascending: false });

    // Deduplicate by role — keep most recent score per role
    const roleMap = {};
    for (const a of (assessments || [])) {
      if (!roleMap[a.role]) {
        roleMap[a.role] = {
          role: a.role,
          roleLabel: ROLE_LABELS[a.role] || a.role,
          tier: a.tier,
          level: getCandidateLevel(a.tier),
          scoredAt: a.scored_at
        };
      }
    }

    const scoresFresh = candidate.assessment_valid_until
      ? new Date(candidate.assessment_valid_until) > new Date()
      : false;

    return res.status(200).json({
      ok: true,
      candidate: {
        firstName: candidate.first_name || '',
        lastName: candidate.last_name || '',
        talentNetworkOptIn: candidate.talent_network_opt_in || false,
        scoreReuseConsent: candidate.score_reuse_consent || false,
        lastAssessedAt: candidate.last_assessed_at || null,
        assessmentValidUntil: candidate.assessment_valid_until || null,
        scoresFresh,
        availabilityStatus: candidate.availability_status || 'open'
      },
      scores: Object.values(roleMap)
    });

  } catch (err) {
    console.error('[candidate-profile] Unexpected error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
