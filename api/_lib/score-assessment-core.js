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

    // ─── 7. Update candidate last_assessed_at ───
    if (assessment.candidate_id) {
      const now = new Date();
      const validUntil = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
      const { error: tsErr } = await supabase
        .from('candidates')
        .update({
          last_assessed_at: now.toISOString(),
          assessment_valid_until: validUntil.toISOString()
        })
        .eq('id', assessment.candidate_id);
      if (tsErr) {
        console.error('[score-core] Failed to update last_assessed_at (non-fatal):', tsErr);
      }
    }

    // ─── 8. Send candidate results email ───
    try {
      const { data: candidate, error: cErr } = await supabase
        .from('candidates')
        .select('email, unsubscribe_token')
        .eq('id', assessment.candidate_id)
        .maybeSingle();

      if (candidate?.email) {
        const candidateName = assessment.candidate_profile?.first_name || 'there';
        const roleLabel = ROLE_LABELS[assessment.role] || assessment.role;
        const level = getCandidateLevel(scoring.tier);

        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: 'Trial. <hello@hiretrial.com.au>',
            to: candidate.email,
            subject: `Your Trial. assessment results`,
            html: buildCandidateResultsEmail({ candidateName, roleLabel, level, unsubscribeToken: candidate.unsubscribe_token })
          })
        });

        console.log('[score-core] Candidate results email sent:', candidate.email);
      }
    } catch (emailErr) {
      console.error('[score-core] Candidate results email failed (non-fatal):', emailErr);
    }

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

function getCandidateLevel(tier) {
  const levels = { 'A': 'Advanced', 'B': 'Intermediate', 'C': 'Foundation', 'D': 'Developing' };
  return levels[tier] || 'Foundation';
}

function buildCandidateResultsEmail({ candidateName, roleLabel, level, unsubscribeToken }) {
  const unsubUrl = unsubscribeToken
    ? `https://hiretrial.com.au/api/unsubscribe?token=${unsubscribeToken}&type=candidate`
    : 'https://hiretrial.com.au/unsubscribed.html?type=candidate';

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Your Trial. results</title></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:40px 20px;">
  <tr><td align="center">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;">

      <!-- Logo -->
      <tr><td style="padding-bottom:32px;">
        <span style="font-family:Georgia,serif;font-size:22px;font-weight:700;color:#f8f6f0;letter-spacing:-0.4px;">Trial<span style="color:#c8a96e;">.</span></span>
      </td></tr>

      <!-- Card -->
      <tr><td style="background:linear-gradient(160deg,#1f1a12 0%,#16120c 100%);border:1px solid rgba(200,169,110,0.35);border-radius:16px;padding:40px 36px;box-shadow:0 0 40px rgba(200,169,110,0.08);">

        <p style="margin:0 0 8px;font-size:11px;letter-spacing:0.24em;text-transform:uppercase;color:#c8a96e;font-weight:600;">Your assessment</p>
        <h1 style="margin:0 0 24px;font-family:Georgia,serif;font-size:28px;font-weight:700;color:#f8f6f0;line-height:1.2;">Thanks, ${candidateName}.</h1>

        <p style="margin:0 0 28px;font-size:15px;line-height:1.65;color:rgba(248,246,240,0.75);">
          You've completed your Trial. assessment for <strong style="color:#f8f6f0;">${roleLabel}</strong>. Here's how your responses were rated.
        </p>

        <!-- Score block -->
        <table width="100%" cellpadding="0" cellspacing="0" style="background:rgba(200,169,110,0.08);border:1px solid rgba(200,169,110,0.2);border-radius:12px;margin-bottom:28px;">
          <tr>
            <td style="padding:24px 28px;">
              <p style="margin:0 0 6px;font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:rgba(248,246,240,0.5);">Your result</p>
              <p style="margin:0;font-family:Georgia,serif;font-size:26px;font-weight:700;color:#c8a96e;">${roleLabel} — ${level}</p>
            </td>
          </tr>
        </table>

        <p style="margin:0 0 16px;font-size:14px;line-height:1.65;color:rgba(248,246,240,0.6);">
          Your results have been shared with the venue. They'll be in touch directly if they'd like to take things further. You don't need to do anything else from here.
        </p>

        <p style="margin:0;font-size:14px;line-height:1.65;color:rgba(248,246,240,0.6);">
          Questions? Email us at <a href="mailto:hello@hiretrial.com.au" style="color:#c8a96e;text-decoration:none;">hello@hiretrial.com.au</a>
        </p>

      </td></tr>

      <!-- Footer -->
      <tr><td style="padding-top:28px;text-align:center;">
        <p style="margin:0;font-size:11px;color:rgba(248,246,240,0.3);line-height:1.8;">
          Trial. &middot; ABN 71 441 417 792<br>
          <a href="${unsubUrl}" style="color:rgba(248,246,240,0.3);text-decoration:underline;">Unsubscribe</a>
        </p>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
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
