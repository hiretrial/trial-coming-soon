// api/_lib/score-assessment-core.js
//
// Pure scoring function. Imported by both:
//   - api/score-assessment.js (thin HTTP wrapper for manual triggering)
//   - api/submit-assessment.js (called directly after submission)
//
// Why a shared module: Vercel serverless functions can't reliably call each
// other via HTTP (deployment-protection auth wall, fire-and-forget terminates
// the lambda before the request fires). Direct in-process call is faster,
// cleaner, and reliable.

import { callHaiku } from '../../lib/anthropic-with-logging.js';

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
  'waiter': 'Waiter/Waitress',
  'host': 'Host',
  'restaurant-manager': 'Restaurant Manager',
  'supervisor': 'Supervisor'
};

const SCORING_RUBRIC = `
SCORING RUBRIC (per question, 0-100):

90-100 (Exceptional): Shows mature judgement, considers multiple stakeholders, demonstrates the kind of thinking you'd expect from a senior, experienced operator. Specific, grounded, and reveals depth.

75-89 (Strong): Solid hospitality instincts. Shows they've thought about it. May be slightly idealistic or miss a nuance, but fundamentally on the right track.

60-74 (Capable): Competent answer. Demonstrates understanding of the situation. Lacks depth or specificity. Would benefit from coaching.

40-59 (Borderline): Surface-level. Generic. Maybe correct in principle but shows limited operational thinking. Could be either inexperienced or a poor fit.

20-39 (Concerning): Misses the point of the question. Reveals attitude issues, lack of empathy, or rigid thinking that would create friction in a real venue.

0-19 (Disqualifying): Reveals fundamentally incompatible values (bullying, discrimination, dishonesty) OR shows the candidate didn't actually engage with the question.

TIER THRESHOLDS (based on overall_score):
A (85+) - Strong recommendation to interview
B (70-84) - Worth an interview
C (55-69) - Borderline — interview if you need volume
D (<55) - Pass

RISK LEVEL:
low - No concerns about integrity, attitude, or values
medium - One or two answers raise questions that should be explored in interview
high - Significant red flags about character, judgement, or fit — venue should know

IMPORTANT GUIDELINES:
- Score the substance of their thinking, NOT writing quality, length, or grammar
- A short, sharp answer can score higher than a long, vague one
- Look for: specificity (mentions of real scenarios), perspective-taking, judgement, ownership
- Penalise: blame-shifting, vagueness, corporate-speak deflection, unwillingness to make a decision
- For 'integrity_honesty' questions: be especially alert to evasion or self-protective answers
- For 'leadership_ownership' questions: look for accountability vs blame
- For 'customer_reading' questions: look for empathy + situational awareness
- For 'anticipation_flow' questions: look for thinking ahead, not just reacting
`;

/**
 * Score an assessment via Haiku 4.5.
 * Returns { ok: true, overall_score, tier, integrity_score } on success,
 * or { ok: false, error, code } on failure.
 *
 * Codes: 'not_found' | 'wrong_status' | 'no_questions' | 'no_api_key'
 *        | 'api_error' | 'parse_error' | 'write_failed' | 'unexpected'
 */
export async function scoreAssessment(supabase, assessmentId) {
  try {
    // ─── 1. Load assessment ───
    const { data: assessment, error: aErr } = await supabase
      .from('assessments')
      .select(`
        id, token, role, status, answers, picked_question_ids,
        paste_count, tab_switch_count, pasted_question_indices,
        avg_response_time_seconds, candidate_profile, venue_id, candidate_id
      `)
      .eq('id', assessmentId)
      .maybeSingle();

    if (aErr || !assessment) {
      console.error('[score-core] Assessment not found:', assessmentId, aErr);
      return { ok: false, error: 'Assessment not found', code: 'not_found' };
    }

    if (assessment.status !== 'submitted') {
      console.warn('[score-core] Not in submitted status:', assessment.status);
      return { ok: false, error: 'Assessment is not awaiting scoring', code: 'wrong_status' };
    }

    // Load questions
    const { data: questions, error: qErr } = await supabase
      .from('questions')
      .select('id, text, category, difficulty')
      .in('id', assessment.picked_question_ids || []);

    if (qErr || !questions || questions.length === 0) {
      console.error('[score-core] Questions not found:', qErr);
      return { ok: false, error: 'Questions not found', code: 'no_questions' };
    }

    // ─── 2. Build prompt ───
    const roleLabel = ROLE_LABELS[assessment.role] || assessment.role;
    const candidateProfile = assessment.candidate_profile || {};
    const candidateName = candidateProfile.first_name
      ? `${candidateProfile.first_name} ${candidateProfile.last_name || ''}`.trim()
      : 'the candidate';

    const qaPairs = (assessment.picked_question_ids || [])
      .map((qid, idx) => {
        const q = questions.find(x => x.id === qid);
        if (!q) return null;
        const answer = (assessment.answers || {})[qid] || '';
        return {
          index: idx + 1,
          id: qid,
          category: q.category,
          difficulty: q.difficulty,
          text: q.text,
          answer
        };
      })
      .filter(Boolean);

    const promptText = buildScoringPrompt({
      candidateName,
      roleLabel,
      qaPairs,
      integrity: {
        pasteCount: assessment.paste_count || 0,
        tabSwitchCount: assessment.tab_switch_count || 0,
        pastedQuestionIndices: assessment.pasted_question_indices || [],
        avgResponseSeconds: assessment.avg_response_time_seconds || 0
      }
    });

    // ─── 3. Anthropic API call (via logging wrapper) ───
    let responseText;
    try {
      const result = await callHaiku({
        messages: [{ role: 'user', content: promptText }],
        max_tokens: 2000,
        endpoint: 'score-assessment/score',
        context: {
          assessment_id: assessment.id,
          candidate_id: assessment.candidate_id,
          venue_id: assessment.venue_id,
          role: assessment.role,
          question_count: qaPairs.length
        }
      });
      responseText = result.content;
    } catch (err) {
      console.error('[score-core] Anthropic API error:', err?.status || '?', (err?.message || '').slice(0, 500));
      await markScoringFailed(supabase, assessment.id, `API error ${err?.status || 'unknown'}`);
      return { ok: false, error: 'Scoring API call failed', code: 'api_error' };
    }

    // ─── 4. Parse JSON response ───
    const scoring = parseScoringResponse(responseText);
    if (!scoring) {
      console.error('[score-core] Could not parse JSON from:', responseText.slice(0, 500));
      await markScoringFailed(supabase, assessment.id, 'Could not parse AI response');
      return { ok: false, error: 'Scoring response parse failed', code: 'parse_error' };
    }

    // ─── 5. Integrity score ───
    let integrityScore = 100;
    if ((assessment.paste_count || 0) > 0) integrityScore -= 20;
    if ((assessment.paste_count || 0) > 2) integrityScore -= 20;
    if ((assessment.tab_switch_count || 0) > 3) integrityScore -= 15;
    if ((assessment.tab_switch_count || 0) > 10) integrityScore -= 20;
    if ((assessment.avg_response_time_seconds || 0) < 15) integrityScore -= 25;
    integrityScore = Math.max(0, Math.min(100, integrityScore));

    // ─── 6. Write back ───
    const { error: writeErr } = await supabase
      .from('assessments')
      .update({
        overall_score: scoring.overall_score,
        tier: scoring.tier,
        ai_summary: scoring.summary,
        ai_strengths: scoring.strengths,
        ai_concerns: scoring.concerns,
        ai_risk_level: scoring.risk_level,
        integrity_score: integrityScore,
        scored_at: new Date().toISOString()
      })
      .eq('id', assessment.id);

    if (writeErr) {
      console.error('[score-core] Write back failed:', writeErr);
      return { ok: false, error: 'Failed to save scoring', code: 'write_failed' };
    }

    console.log('[score-core] Scored successfully:', {
      assessment_id: assessment.id,
      overall_score: scoring.overall_score,
      tier: scoring.tier,
      risk_level: scoring.risk_level,
      integrity_score: integrityScore
    });

    return {
      ok: true,
      overall_score: scoring.overall_score,
      tier: scoring.tier,
      integrity_score: integrityScore,
      risk_level: scoring.risk_level
    };

  } catch (err) {
    console.error('[score-core] Unexpected error:', err);
    return { ok: false, error: 'Server error', code: 'unexpected' };
  }
}

async function markScoringFailed(supabase, assessmentId, reason) {
  await supabase
    .from('assessments')
    .update({
      ai_summary: `⚠️ Scoring failed: ${reason}. Manual review required.`
    })
    .eq('id', assessmentId);
}

function buildScoringPrompt({ candidateName, roleLabel, qaPairs, integrity }) {
  const qaText = qaPairs.map(qa => `
QUESTION ${qa.index} (category: ${qa.category}, difficulty: ${qa.difficulty})
${qa.text}

ANSWER:
${qa.answer}
`).join('\n---\n');

  return `You are an experienced Australian hospitality operator scoring an applicant's responses to a pre-hire assessment. You score with the conservatism and judgement of someone who's hired hundreds of front-of-house staff and seen what works in real venues.

CANDIDATE: ${candidateName}
ROLE: ${roleLabel}

${SCORING_RUBRIC}

INTEGRITY SIGNALS (for context — do NOT factor into per-question scoring, just note in concerns if extreme):
- Paste events: ${integrity.pasteCount}
- Tab switches: ${integrity.tabSwitchCount}
- Average time per question: ${Math.round(integrity.avgResponseSeconds)} seconds
${integrity.pastedQuestionIndices.length > 0 ? `- Pasted on questions: ${integrity.pastedQuestionIndices.map(i => i+1).join(', ')}` : ''}

QUESTIONS & ANSWERS:
${qaText}

YOUR TASK:
Score each answer, then produce an overall summary. Respond with ONLY a JSON object (no markdown fences, no preamble) in this exact structure:

{
  "per_question_scores": [
    {"question_index": 1, "score": 0-100, "reasoning": "one sentence"},
    ...
  ],
  "overall_score": 0-100 (weighted average — give slightly more weight to higher-difficulty questions),
  "tier": "A" | "B" | "C" | "D",
  "summary": "2-3 sentence summary the venue manager reads first. Tell them whether to interview and why.",
  "strengths": [
    "Specific strength 1",
    "Specific strength 2",
    "Specific strength 3"
  ],
  "concerns": [
    "Specific concern 1 — what to probe in interview",
    "Specific concern 2",
    "Specific concern 3"
  ],
  "risk_level": "low" | "medium" | "high"
}

Be honest. Be specific. Cite which questions inform your strengths/concerns where relevant. Score the SUBSTANCE of thinking, not writing quality.`;
}

function parseScoringResponse(text) {
  if (!text) return null;

  let cleaned = text.trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '');

  try {
    const parsed = JSON.parse(cleaned);

    if (typeof parsed.overall_score !== 'number') return null;
    if (!['A', 'B', 'C', 'D'].includes(parsed.tier)) return null;
    if (!['low', 'medium', 'high'].includes(parsed.risk_level)) return null;
    if (typeof parsed.summary !== 'string') return null;
    if (!Array.isArray(parsed.strengths)) return null;
    if (!Array.isArray(parsed.concerns)) return null;

    parsed.overall_score = Math.max(0, Math.min(100, Math.round(parsed.overall_score)));

    return parsed;
  } catch (err) {
    console.error('[parseScoringResponse] JSON parse failed:', err.message);
    return null;
  }
}
