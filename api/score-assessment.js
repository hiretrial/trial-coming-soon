// api/score-assessment.js
//
// Thin HTTP wrapper around the core scoring function.
// All actual scoring logic lives in api/_lib/score-assessment-core.js
// so it can be called directly from submit-assessment.js (no HTTP round-trip).
//
// This endpoint remains useful for:
//   - Manual re-scoring (curl or browser console)
//   - Future async/queue-based scoring workflows
//   - Webhook-triggered scoring from external systems

import { createClient } from '@supabase/supabase-js';
import { scoreAssessment } from './score-assessment-core.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { assessment_id } = req.body || {};
    if (!assessment_id) {
      return res.status(400).json({ error: 'Missing assessment_id' });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const result = await scoreAssessment(supabase, assessment_id);

    if (!result.ok) {
      const statusMap = {
        not_found: 404,
        wrong_status: 409,
        no_questions: 500,
        no_api_key: 500,
        api_error: 500,
        parse_error: 500,
        write_failed: 500,
        unexpected: 500
      };
      return res.status(statusMap[result.code] || 500).json({ error: result.error });
    }

    return res.status(200).json({
      ok: true,
      overall_score: result.overall_score,
      tier: result.tier,
      integrity_score: result.integrity_score,
      risk_level: result.risk_level
    });

  } catch (err) {
    console.error('[score-assessment] Unexpected error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
