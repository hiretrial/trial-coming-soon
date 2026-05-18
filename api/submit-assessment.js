// api/submit-assessment.js
//
// Candidate submits their completed assessment. This endpoint:
// 1. Validates token + payload
// 2. Writes answers + integrity signals to the assessments row
// 3. Marks status as 'submitted'
// 4. Triggers async scoring (fire-and-forget — candidate doesn't wait)
// 5. Returns success

import { createClient } from '@supabase/supabase-js';

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

    // ─── 2. Load the assessment to confirm it exists, isn't expired, isn't already submitted ───
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

    if (['submitted', 'scored', 'awaiting_review'].includes(assessment.status)) {
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

    // ─── 4. Update the assessment row ───
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

    // ─── 5. Trigger async scoring (fire-and-forget) ───
    // Candidate doesn't wait for scoring. The scoring function runs in background.
    triggerScoring(assessment.id).catch(err => {
      console.error('[submit-assessment] Scoring trigger failed (non-fatal):', err);
    });

    // ─── 6. Done — return success to candidate ───
    return res.status(200).json({
      ok: true,
      message: 'Assessment submitted successfully'
    });

  } catch (err) {
    console.error('[submit-assessment] Unexpected error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

// Fire-and-forget call to the scoring endpoint.
// Uses internal HTTP call (Vercel serverless functions can't share runtime).
async function triggerScoring(assessmentId) {
  const baseUrl = process.env.VERCEL_URL 
    ? `https://${process.env.VERCEL_URL}` 
    : 'https://hiretrial.com.au';
  
  // Don't await the response — we're firing and forgetting
  fetch(`${baseUrl}/api/score-assessment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assessment_id: assessmentId })
  }).catch(err => {
    console.error('[triggerScoring] fetch failed:', err);
  });
}
