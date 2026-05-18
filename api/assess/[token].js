// api/assess/[token].js
//
// Assessment token resolver — assess.html calls this on page load.
//
// Validates the token, checks expiry, and returns:
// - Venue branding (name, logo, primary colour)
// - Role
// - Questions to answer (the full text + metadata for each picked question)
// - Status (so we can show "already submitted" or "expired" states)

import { createClient } from '@supabase/supabase-js';

const ROLE_LABELS = {
  'bartender': 'Bartender',
  'bar-back': 'Bar Back',
  'bar-manager': 'Bar Manager',
  'barista': 'Barista',
  'cafe-allrounder': 'Café All-Rounder',
  'cafe-kitchen-hand': 'Kitchen Hand',
  'cafe-manager': 'Café Manager',
  'duty-manager': 'Duty Manager',
  'expediter': 'Expediter',
  'floor-staff': 'Floor Staff',
  'food-runner': 'Food Runner',
  'host': 'Host',
  'restaurant-manager': 'Restaurant Manager',
  'supervisor': 'Supervisor'
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

    // ─── 1. Load assessment by token ───
    const { data: assessment, error: aErr } = await supabase
      .from('assessments')
      .select(`
        id,
        token,
        role,
        status,
        picked_question_ids,
        expires_at,
        started_at,
        submitted_at,
        candidate_profile,
        venue_id,
        candidate_id
      `)
      .eq('token', token)
      .maybeSingle();

    if (aErr) {
      console.error('[assess/token] DB error:', aErr);
      return res.status(500).json({ error: 'Database error' });
    }

    if (!assessment) {
      return res.status(404).json({ error: 'Assessment not found' });
    }

    // ─── 2. Check expiry ───
    if (new Date(assessment.expires_at) < new Date()) {
      return res.status(410).json({ 
        error: 'expired',
        message: 'This assessment link has expired. Please contact the venue if you need a new one.'
      });
    }

    // ─── 3. Check status — if already submitted, return a friendly state ───
    if (assessment.status === 'submitted' || assessment.status === 'scored' || assessment.status === 'awaiting_review') {
      return res.status(200).json({
        status: 'already_submitted',
        message: 'You\'ve already completed this assessment. The venue will be in touch soon.'
      });
    }

    // ─── 4. Load venue branding ───
    const { data: venue, error: vErr } = await supabase
      .from('venues')
      .select('id, name, slug, brand_logo_url, brand_primary_color')
      .eq('id', assessment.venue_id)
      .maybeSingle();

    if (vErr || !venue) {
      console.error('[assess/token] Venue lookup failed:', vErr);
      return res.status(500).json({ error: 'Venue not found' });
    }

    // ─── 5. Load the picked questions (full text + metadata) ───
    const questionIds = assessment.picked_question_ids || [];
    if (questionIds.length === 0) {
      console.error('[assess/token] Assessment has no picked questions:', assessment.id);
      return res.status(500).json({ error: 'No questions assigned to this assessment' });
    }

    const { data: questions, error: qErr } = await supabase
      .from('questions')
      .select('id, text, category, difficulty')
      .in('id', questionIds);

    if (qErr || !questions || questions.length === 0) {
      console.error('[assess/token] Failed to load questions:', qErr);
      return res.status(500).json({ error: 'Failed to load questions' });
    }

    // Preserve the picked order (Supabase doesn't guarantee in() order)
    const questionsInOrder = questionIds
      .map(id => questions.find(q => q.id === id))
      .filter(Boolean);

    // ─── 6. Mark as started if first time loading ───
    if (!assessment.started_at) {
      await supabase
        .from('assessments')
        .update({ 
          started_at: new Date().toISOString(),
          status: 'in_progress'
        })
        .eq('id', assessment.id);
    }

    // ─── 7. Return everything assess.html needs ───
    return res.status(200).json({
      status: 'ready',
      assessment: {
        id: assessment.id,
        token: assessment.token,
        role: assessment.role,
        roleLabel: ROLE_LABELS[assessment.role] || assessment.role,
        candidateProfile: assessment.candidate_profile || {},
        expiresAt: assessment.expires_at
      },
      venue: {
        name: venue.name,
        slug: venue.slug,
        brandLogoUrl: venue.brand_logo_url,
        brandPrimaryColor: venue.brand_primary_color || '#c8a96e'
      },
      questions: questionsInOrder.map((q, idx) => ({
        index: idx + 1,
        totalCount: questionsInOrder.length,
        id: q.id,
        text: q.text,
        category: q.category,
        difficulty: q.difficulty
      }))
    });

  } catch (err) {
    console.error('[assess/token] Unexpected error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
