// api/score-assessment.js
//
// Haiku 4.5 scoring brain. Called fire-and-forget by submit-assessment.
//
// 1. Load the assessment, questions, candidate, venue
// 2. Build a structured prompt with rubric
// 3. Call Anthropic API
// 4. Parse JSON response
// 5. Write scores back to assessments row (status stays 'submitted')

import { createClient } from '@supabase/supabase-js';

const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

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

// ─── The scoring rubric (becomes part of the prompt) ───
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

    // ─── 1. Load assessment + related data ───
    const { data: assessment, error: aErr } = await supabase
      .from('assessments')
      .select(`
        id, token, role, status, answers, picked_question_ids,
        paste_count, tab_switch_count, pasted_question_indices,
        avg_response_time_seconds, candidate_profile, venue_id, candidate_id
      `)
      .eq('id', assessment_id)
      .maybeSingle();

    if (aErr || !assessment) {
      console.error('[score-assessment] Assessment not found:', assessment_id, aErr);
      return res.status(404).json({ error: 'Assessment not found' });
    }

    if (assessment.status !== 'submitted') {
      console.warn('[score-assessment] Assessment not in submitted status:', assessment.status);
      return res.status(409).json({ error: 'Assessment is not awaiting scoring' });
    }

    // Load questions
    const { data: questions, error: qErr } = await supabase
      .from('questions')
      .select('id, text, category, difficulty')
      .in('id', assessment.picked_question_ids || []);

    if (qErr || !questions || questions.length === 0) {
      console.error('[score-assessment] Questions not found:', qErr);
      return res.status(500).json({ error: 'Questions not found' });
    }

    // ─── 2. Build the prompt ───
    const roleLabel = ROLE_LABELS[assessment.role] || assessment.role;
    const candidateProfile = assessment.candidate_profile || {};
    const candidateName = candidateProfile.first_name 
      ? `${candidateProfile.first_name} ${candidateProfile.last_name || ''}`.trim() 
      : 'the candidate';

    // Build question + answer pairs in picked order
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
          answer: answer
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

    // ─── 3. Call Anthropic API ───
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) {
      console.error('[score-assessment] ANTHROPIC_API_KEY missing');
      return res.status(500).json({ error: 'Scoring service unavailable' });
    }

    const apiResp = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 2000,
        messages: [{ role: 'user', content: promptText }]
      })
    });

    if (!apiResp.ok) {
      const errText = await apiResp.text();
      console.error('[score-assessment] Anthropic API error:', apiResp.status, errText);
      await markScoringFailed(supabase, assessment.id, `API error ${apiResp.status}`);
      return res.status(500).json({ error: 'Scoring API call failed' });
    }

    const apiData = await apiResp.json();
    const responseText = apiData.content?.[0]?.text || '';

    // ─── 4. Parse JSON response ───
    const scoring = parseScoringResponse(responseText);
    if (!scoring) {
      console.error('[score-assessment] Could not parse JSON from:', responseText.slice(0, 500));
      await markScoringFailed(supabase, assessment.id, 'Could not parse AI response');
      return res.status(500).json({ error: 'Scoring response parse failed' });
    }

    // ─── 5. Compute integrity score ───
    // Simple model: start at 100, deduct for red flags
    let integrityScore = 100;
    if ((assessment.paste_count || 0) > 0) integrityScore -= 20;
    if ((assessment.paste_count || 0) > 2) integrityScore -= 20;
    if ((assessment.tab_switch_count || 0) > 3) integrityScore -= 15;
    if ((assessment.tab_switch_count || 0) > 10) integrityScore -= 20;
    if ((assessment.avg_response_time_seconds || 0) < 15) integrityScore -= 25;
    integrityScore = Math.max(0, Math.min(100, integrityScore));

    // ─── 6. Write back to assessment ───
    // Status stays 'submitted'. Scoring outcome lives in overall_score/tier/ai_summary.
    // Venue marks 'reviewed' from the dashboard when they action it.
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
      console.error('[score-assessment] Write back failed:', writeErr);
      return res.status(500).json({ error: 'Failed to save scoring' });
    }

    console.log('[score-assessment] Scored successfully:', {
      assessment_id: assessment.id,
      overall_score: scoring.overall_score,
      tier: scoring.tier,
      risk_level: scoring.risk_level,
      integrity_score: integrityScore
    });

    // TODO Step 8: send venue manager notification email here

    return res.status(200).json({
      ok: true,
      overall_score: scoring.overall_score,
      tier: scoring.tier
    });

  } catch (err) {
    console.error('[score-assessment] Unexpected error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

async function markScoringFailed(supabase, assessmentId, reason) {
  // Status stays 'submitted' — failure is communicated via ai_summary
  // so the dashboard can flag it for manual review without breaking the enum.
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
  
  // Strip any markdown fences if Haiku added them
  let cleaned = text.trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '');

  try {
    const parsed = JSON.parse(cleaned);
    
    // Validate required fields
    if (typeof parsed.overall_score !== 'number') return null;
    if (!['A', 'B', 'C', 'D'].includes(parsed.tier)) return null;
    if (!['low', 'medium', 'high'].includes(parsed.risk_level)) return null;
    if (typeof parsed.summary !== 'string') return null;
    if (!Array.isArray(parsed.strengths)) return null;
    if (!Array.isArray(parsed.concerns)) return null;

    // Clamp overall_score to 0-100
    parsed.overall_score = Math.max(0, Math.min(100, Math.round(parsed.overall_score)));

    return parsed;
  } catch (err) {
    console.error('[parseScoringResponse] JSON parse failed:', err.message);
    return null;
  }
}
