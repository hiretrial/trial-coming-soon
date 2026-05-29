// api/submit-assessment.js
//
// Candidate submits their completed assessment. This endpoint:
// 1. Validates token + payload
// 2. Writes answers + integrity signals to the assessments row
// 3. Marks status as 'submitted'
// 4. Calls scoreAssessment() in-process (no HTTP round-trip)
// 5. Returns success with the score

import { createClient } from '@supabase/supabase-js';
import { scoreAssessment } from './_lib/score-assessment-core.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { token, answers, integrity, consents } = req.body || {};

    // ─── 1. Validate ───
    if (!token || !answers || typeof answers !== 'object') {
      return res.status(400).json({ error: 'Missing or invalid payload' });
    }

    if (Object.keys(answers).length === 0) {
      return res.status(400).json({ error: 'No answers provided' });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // ─── 2. Load assessment ───
    const { data: assessment, error: loadErr } = await supabase
      .from('assessments')
      .select('id, status, expires_at, picked_question_ids')
      .eq('token', token)
      .maybeSingle();

    if (loadErr || !assessment) {
      return res.status(404).json({ error: 'Assessment not found' });
    }

    if (new Date(assessment.expires_at) < new Date()) {
      return res.status(410).json({ error: 'Assessment expired' });
    }

    if (assessment.status === 'submitted') {
      return res.status(409).json({ error: 'Already submitted' });
    }

    // ─── 3. Validate each picked question has an answer ───
    const pickedIds = assessment.picked_question_ids || [];
    const missingIds = pickedIds.filter(id => !answers[id] || answers[id].trim().length < 20);
    if (missingIds.length > 0) {
      return res.status(400).json({
        error: 'Some answers are too short or missing',
        missing_question_count: missingIds.length
      });
    }

    // ─── 4. Write submission to assessment row ───
    const { error: updateErr } = await supabase
      .from('assessments')
      .update({
        answers,
        status: 'submitted',
        submitted_at: new Date().toISOString(),
        paste_count: integrity?.pasteCount || 0,
        pasted_question_indices: integrity?.pastedQuestionIndices || [],
        tab_switch_count: integrity?.tabSwitchCount || 0,
        avg_response_time_seconds: integrity?.avgResponseTimeSeconds || 0,
        tier1_consent_at: consents?.tier1At || new Date().toISOString(),
        tier2_consent_at: consents?.tier2At || new Date().toISOString()
      })
      .eq('id', assessment.id);

    if (updateErr) {
      console.error('[submit-assessment] Update failed:', updateErr);
      return res.status(500).json({ error: 'Failed to save submission' });
    }

    console.log('[submit-assessment] Submitted, scoring inline:', assessment.id);

    // ─── 5. Score inline (~5-10s on Haiku) ───
    // Direct in-process call — no HTTP, no auth wall, no fire-and-forget weirdness.
    // Submission is already saved; if scoring fails, candidate still sees success
    // and the row can be re-scored manually via /api/score-assessment.
    const scoringResult = await scoreAssessment(supabase, assessment.id);

    if (scoringResult.ok) {
      console.log('[submit-assessment] Scoring complete:', {
        assessment_id: assessment.id,
        overall_score: scoringResult.overall_score,
        tier: scoringResult.tier
      });
    } else {
      console.error('[submit-assessment] Scoring failed (non-fatal):', scoringResult.error, scoringResult.code);
    }

    // ─── 6. Return success ───
    return res.status(200).json({
      ok: true,
      message: 'Assessment submitted successfully',
      scored: scoringResult.ok
    });

  } catch (err) {
    console.error('[submit-assessment] Unexpected error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
