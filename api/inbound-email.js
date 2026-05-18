// api/inbound-email.js
//
// Resend Inbound webhook handler — entry point for every candidate application.
//
// Flow:
// 1. Verify Resend's webhook signature
// 2. Lookup venue from `to` address
// 3. Detect role (Layer 1 single role → Layer 2 keyword scan → default fallback)
// 4. Find or create candidate
// 5. Mint assessment token with picked questions
// 6. Email candidate the assessment link (branded)
// 7. Forward original email + CV to venue's manager_email (branded)
// 8. Return 200 to Resend

import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';
import crypto from 'crypto';

// ─── Role keyword map (Layer 2) — ORDER MATTERS, specificity first ─────────
// "bar manager" must match before "bartender" or "bar" would match wrong.
const ROLE_KEYWORDS = [
  { role: 'restaurant-manager', patterns: ['restaurant manager', 'venue manager', 'general manager'] },
  { role: 'cafe-manager',       patterns: ['cafe manager', 'café manager'] },
  { role: 'duty-manager',       patterns: ['duty manager'] },
  { role: 'bar-manager',        patterns: ['bar manager'] },
  { role: 'supervisor',         patterns: ['shift supervisor', 'floor supervisor', 'supervisor'] },
  { role: 'bar-back',           patterns: ['bar back', 'bar-back', 'barback'] },
  { role: 'cafe-allrounder',    patterns: ['all-rounder', 'all rounder', 'allrounder', 'cafe all-rounder'] },
  { role: 'cafe-kitchen-hand',  patterns: ['kitchen hand', 'kitchen-hand', 'kitchenhand'] },
  { role: 'food-runner',        patterns: ['food runner', 'runner'] },
  { role: 'expediter',          patterns: ['expediter', 'expeditor', 'expo'] },
  { role: 'floor-staff',        patterns: ['floor staff', 'wait staff', 'waiter', 'waitress', 'server'] },
  { role: 'bartender',          patterns: ['bartender', 'bar tender'] },
  { role: 'barista',            patterns: ['barista'] },
  { role: 'host',               patterns: ['hostess', 'host'] }
];

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

const roleLabel = (r) => ROLE_LABELS[r] || r;

// ─── Vercel config — need raw body for signature verification ──────────────
export const config = {
  api: {
    bodyParser: false
  }
};

async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
// Verify Resend (Svix) webhook signature.
// Spec: https://docs.svix.com/receiving/verifying-payloads/how-manual
// Signed content = `{svix-id}.{svix-timestamp}.{rawBody}`
// HMAC-SHA256 using base64-decoded secret (the part after whsec_)
function verifyResendSignature(rawBody, headers, secret) {
  if (!secret) return false;

  const svixId = headers['svix-id'] || headers['webhook-id'];
  const svixTimestamp = headers['svix-timestamp'] || headers['webhook-timestamp'];
  const svixSignature = headers['svix-signature'] || headers['webhook-signature'];

  if (!svixId || !svixTimestamp || !svixSignature) {
    console.error('[verifyResendSignature] Missing svix headers');
    return false;
  }

  try {
    // Secret comes as "whsec_<base64>" — decode the base64 portion
    const secretBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
    const signedContent = `${svixId}.${svixTimestamp}.${rawBody.toString('utf8')}`;
    const expected = crypto
      .createHmac('sha256', secretBytes)
      .update(signedContent)
      .digest('base64');

    // Header is space-separated list of "v1,signature v1,signature ..."
    const candidates = svixSignature.split(' ')
      .map(s => {
        const parts = s.split(',');
        return parts.length === 2 ? parts[1] : null;
      })
      .filter(Boolean);

    return candidates.some(sig => {
      try {
        return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
      } catch { return false; }
    });
  } catch (err) {
    console.error('[verifyResendSignature] Error:', err);
    return false;
  }
}

  }
}

// Scan text for role keywords, but only consider venue.allowed_roles
function detectRoleFromText(text, allowedRoles) {
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const { role, patterns } of ROLE_KEYWORDS) {
    if (!allowedRoles.includes(role)) continue;
    if (patterns.some(p => lower.includes(p))) return role;
  }
  return null;
}

// Parse "Jane Smith <jane@example.com>" → { first_name, last_name }
function parseFromName(fromString) {
  if (!fromString) return { first_name: '', last_name: '' };
  const match = fromString.match(/^([^<]+)<.*>$/);
  const namePart = (match ? match[1] : fromString).trim().replace(/^["']|["']$/g, '');
  const parts = namePart.split(/\s+/);
  return {
    first_name: parts[0] || '',
    last_name: parts.slice(1).join(' ') || ''
  };
}

function parseFromEmail(fromString) {
  if (!fromString) return null;
  const match = fromString.match(/<([^>]+)>/);
  return (match ? match[1] : fromString).trim().toLowerCase();
}

// Pick stratified questions: 2 easy + 3 medium + 1 hard from the role's pool
async function pickQuestions(supabase, role) {
  const { data: pool, error } = await supabase
    .from('questions')
    .select('id, category, difficulty')
    .contains('roles', [role])
    .eq('status', 'active');

  if (error || !pool || pool.length === 0) {
    return { picked: [], audit: { error: 'no_questions_found', role } };
  }

  const byDifficulty = {
    easy: pool.filter(q => q.difficulty === 'easy'),
    medium: pool.filter(q => q.difficulty === 'medium'),
    hard: pool.filter(q => q.difficulty === 'hard')
  };

  const pickN = (arr, n) => {
    const shuffled = [...arr].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, n);
  };

  const picks = [
    ...pickN(byDifficulty.easy, 2),
    ...pickN(byDifficulty.medium, 3),
    ...pickN(byDifficulty.hard, 1)
  ];

  const categoryCounts = {};
  picks.forEach(q => { categoryCounts[q.category] = (categoryCounts[q.category] || 0) + 1; });

  return {
    picked: picks.map(q => q.id),
    audit: {
      role,
      pool_size: pool.length,
      picked_count: picks.length,
      by_difficulty: {
        easy: picks.filter(q => q.difficulty === 'easy').length,
        medium: picks.filter(q => q.difficulty === 'medium').length,
        hard: picks.filter(q => q.difficulty === 'hard').length
      },
      category_distribution: categoryCounts,
      picked_at: new Date().toISOString()
    }
  };
}

// ─── Main handler ──────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  try {
// 1. Verify signature
    const rawBody = await readRawBody(req);
    const secret = process.env.RESEND_WEBHOOK_SECRET;

    if (!verifyResendSignature(rawBody, req.headers, secret)) {
      console.error('[inbound-email] Invalid signature');
      return res.status(401).send('Invalid signature');
    }
    }

    const event = JSON.parse(rawBody.toString('utf8'));

    // 2. Only process email.received events
    if (event.type !== 'email.received') {
      console.log('[inbound-email] Ignoring event type:', event.type);
      return res.status(200).json({ ignored: true });
    }

    const emailData = event.data;
    const toAddress = (emailData.to?.[0] || '').toLowerCase().trim();
    const fromString = emailData.from || '';
    const subject = emailData.subject || '';
    const bodyText = emailData.text || emailData.html || '';
    const attachments = emailData.attachments || [];

    console.log('[inbound-email] Received:', { to: toAddress, from: fromString, subject });

    // 3. Lookup venue
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const { data: venue, error: venueErr } = await supabase
      .from('venues')
      .select('id, name, slug, inbound_address, allowed_roles, default_role, manager_email, manager_name, brand_logo_url, brand_primary_color, account_id')
      .eq('inbound_address', toAddress)
      .maybeSingle();

    if (venueErr || !venue) {
      console.warn('[inbound-email] Unknown venue inbox:', toAddress);
      return res.status(200).json({ ignored: 'unknown_venue' });
    }

    const allowedRoles = venue.allowed_roles || [];

    // 4. Detect role
    let detectedRole = null;
    let detectionMethod = 'unknown';

    if (allowedRoles.length === 1) {
      detectedRole = allowedRoles[0];
      detectionMethod = 'layer_1_single_role';
    }

    if (!detectedRole) {
      detectedRole = detectRoleFromText(subject, allowedRoles)
                  || detectRoleFromText(bodyText, allowedRoles);
      if (detectedRole) detectionMethod = 'layer_2_keyword';
    }

    if (!detectedRole && venue.default_role) {
      detectedRole = venue.default_role;
      detectionMethod = 'fallback_default_role';
    }

    if (!detectedRole) {
      console.warn('[inbound-email] Role detection failed for venue:', venue.slug);
      return res.status(200).json({ ignored: 'role_detection_failed', venue: venue.slug });
    }

    // 5. Extract candidate
    const candidateEmail = parseFromEmail(fromString);
    const { first_name, last_name } = parseFromName(fromString);

    if (!candidateEmail) {
      console.error('[inbound-email] No candidate email in:', fromString);
      return res.status(200).json({ ignored: 'no_candidate_email' });
    }

    // 6. Upsert candidate
    const { data: existingCandidate } = await supabase
      .from('candidates')
      .select('id')
      .eq('email', candidateEmail)
      .maybeSingle();

    let candidateId;
    if (existingCandidate) {
      candidateId = existingCandidate.id;
      await supabase
        .from('candidates')
        .update({ last_active_at: new Date().toISOString() })
        .eq('id', candidateId);
    } else {
      const { data: newCandidate, error: insertErr } = await supabase
        .from('candidates')
        .insert({
          first_name,
          last_name,
          email: candidateEmail,
          first_seen_at: new Date().toISOString(),
          last_active_at: new Date().toISOString()
        })
        .select('id')
        .single();

      if (insertErr) {
        console.error('[inbound-email] Candidate insert failed:', insertErr);
        return res.status(500).send('Database error');
      }
      candidateId = newCandidate.id;
    }

    // 7. Pick questions
    const { picked, audit } = await pickQuestions(supabase, detectedRole);

    if (picked.length === 0) {
      console.error('[inbound-email] No questions picked for role:', detectedRole);
      return res.status(500).send('No questions available');
    }

    // 8. Create assessment
    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const { data: assessment, error: assessErr } = await supabase
      .from('assessments')
      .insert({
        candidate_id: candidateId,
        venue_id: venue.id,
        role: detectedRole,
        status: 'pending',
        token,
        picked_question_ids: picked,
        picker_audit: { ...audit, detection_method: detectionMethod },
        expires_at: expiresAt,
        candidate_profile: {
          first_name,
          last_name,
          email: candidateEmail,
          source_subject: subject,
          source_from: fromString
        }
      })
      .select('id, token')
      .single();

    if (assessErr) {
      console.error('[inbound-email] Assessment insert failed:', assessErr);
      return res.status(500).send('Failed to create assessment');
    }

    // 9. Send candidate-back email
    const resend = new Resend(process.env.RESEND_API_KEY);
    const assessmentUrl = `https://hiretrial.com.au/assess.html?token=${token}`;

    try {
      await resend.emails.send({
        from: `${venue.name} via Trial. <hello@hiretrial.com.au>`,
        to: candidateEmail,
        reply_to: 'hello@hiretrial.com.au',
        subject: `Complete your trial for ${venue.name} — ${roleLabel(detectedRole)}`,
        html: candidateEmailHtml({
          firstName: first_name || 'there',
          venueName: venue.name,
          roleLabel: roleLabel(detectedRole),
          assessmentUrl
        })
      });
    } catch (err) {
      console.error('[inbound-email] Candidate email send failed:', err);
    }

    // 10. Forward to venue manager
    if (venue.manager_email) {
      try {
        const attachmentPayloads = [];
        for (const att of attachments) {
          if (att.download_url) {
            try {
              const resp = await fetch(att.download_url);
              const buf = Buffer.from(await resp.arrayBuffer());
              attachmentPayloads.push({
                filename: att.filename || 'attachment',
                content: buf
              });
            } catch (attErr) {
              console.warn('[inbound-email] Attachment fetch failed:', att.filename);
            }
          }
        }

        await resend.emails.send({
          from: `Trial. <hello@hiretrial.com.au>`,
          to: venue.manager_email,
          reply_to: candidateEmail,
          subject: `[Trial. — ${roleLabel(detectedRole)}] ${subject}`,
          html: forwardEmailHtml({
            venueName: venue.name,
            candidateName: `${first_name} ${last_name}`.trim() || candidateEmail,
            candidateEmail,
            roleLabel: roleLabel(detectedRole),
            originalSubject: subject,
            originalBody: bodyText
          }),
          attachments: attachmentPayloads
        });
      } catch (err) {
        console.error('[inbound-email] Forward email send failed:', err);
      }
    }

    console.log('[inbound-email] Success:', {
      venue: venue.slug,
      role: detectedRole,
      detectionMethod,
      assessmentId: assessment.id
    });

    return res.status(200).json({
      ok: true,
      assessment_id: assessment.id,
      role: detectedRole,
      detection_method: detectionMethod
    });

  } catch (err) {
    console.error('[inbound-email] Unexpected error:', err);
    return res.status(500).send('Server error');
  }
}

// ─── Branded email templates ───────────────────────────────────────────────

function candidateEmailHtml({ firstName, venueName, roleLabel, assessmentUrl }) {
  return `<!DOCTYPE html>
<html lang="en-AU">
<head>
<meta charset="UTF-8">
<title>Your Trial. assessment</title>
</head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:Georgia,'Times New Roman',serif;color:#f8f6f0;">
<table cellpadding="0" cellspacing="0" width="100%" style="max-width:560px;margin:0 auto;background:#0a0a0a;padding:48px 32px;">
  <tr><td>
    <div style="font-family:'Playfair Display',Georgia,serif;font-size:32px;font-weight:900;letter-spacing:-0.6px;color:#f8f6f0;margin-bottom:48px;">
      Trial<span style="color:#c8a96e;">.</span>
    </div>
    <div style="font-size:11px;letter-spacing:0.28em;text-transform:uppercase;color:#c8a96e;font-weight:600;margin-bottom:16px;font-family:Arial,sans-serif;">
      Your assessment
    </div>
    <h1 style="font-family:'Playfair Display',Georgia,serif;font-weight:800;font-size:36px;line-height:1.1;letter-spacing:-1px;margin:0 0 16px 0;color:#f8f6f0;">
      Hi ${firstName} —<br><span style="font-style:italic;font-weight:500;color:#c8a96e;">${venueName}</span> wants to know how you'd handle their floor.
    </h1>
    <p style="font-size:15px;line-height:1.6;color:rgba(248,246,240,0.62);margin:24px 0;font-family:Arial,sans-serif;">
      Thanks for applying for the <strong style="color:#f8f6f0;font-weight:500;">${roleLabel}</strong> role at ${venueName}. Before they bring you in, they've asked for a quick trial — six scenario questions that take <strong style="color:#f8f6f0;font-weight:500;">about ten to twelve minutes</strong>. There are no right or wrong answers in the abstract — they want to see how <em>you</em> think.
    </p>
    <table cellpadding="0" cellspacing="0" style="margin:32px 0;">
      <tr><td style="background:#c8a96e;border-radius:8px;">
        <a href="${assessmentUrl}" style="display:inline-block;padding:14px 28px;color:#0a0a0a;text-decoration:none;font-family:Arial,sans-serif;font-weight:600;font-size:15px;letter-spacing:0.02em;">
          Begin your assessment &rarr;
        </a>
      </td></tr>
    </table>
    <p style="font-size:13px;line-height:1.6;color:rgba(248,246,240,0.42);margin:24px 0 0 0;font-family:Arial,sans-serif;">
      Your link expires in 7 days. If the button doesn't work, paste this into your browser: <br>
      <span style="color:#c8a96e;word-break:break-all;">${assessmentUrl}</span>
    </p>
    <div style="margin-top:48px;padding-top:24px;border-top:1px solid rgba(255,255,255,0.06);font-size:11px;line-height:1.7;color:rgba(248,246,240,0.42);text-align:center;font-family:Arial,sans-serif;">
      Trial. · hello@hiretrial.com.au · ABN 71 441 417 792
    </div>
  </td></tr>
</table>
</body>
</html>`;
}

function forwardEmailHtml({ venueName, candidateName, candidateEmail, roleLabel, originalSubject, originalBody }) {
  return `<!DOCTYPE html>
<html lang="en-AU">
<head>
<meta charset="UTF-8">
</head>
<body style="margin:0;padding:0;background:#f5f4f0;font-family:Arial,sans-serif;color:#0a0a0a;">
<table cellpadding="0" cellspacing="0" width="100%" style="max-width:640px;margin:0 auto;background:#ffffff;padding:32px;">
  <tr><td>
    <div style="font-family:'Playfair Display',Georgia,serif;font-size:24px;font-weight:900;letter-spacing:-0.4px;color:#0a0a0a;margin-bottom:24px;">
      Trial<span style="color:#c8a96e;">.</span>
    </div>
    <div style="background:rgba(200,169,110,0.08);border-left:3px solid #c8a96e;padding:16px 20px;border-radius:6px;margin-bottom:24px;">
      <div style="font-size:10px;letter-spacing:0.22em;text-transform:uppercase;color:#c8a96e;font-weight:600;margin-bottom:6px;">New application · ${roleLabel}</div>
      <div style="font-size:16px;font-weight:600;color:#0a0a0a;margin-bottom:2px;">${candidateName}</div>
      <div style="font-size:13px;color:rgba(0,0,0,0.6);">${candidateEmail}</div>
    </div>
    <p style="font-size:13.5px;line-height:1.6;color:rgba(0,0,0,0.7);margin:0 0 20px 0;">
      This is the original application as it landed in your Trial. inbox. The candidate's CV is attached. We've sent them their trial assessment — once they complete it, you'll see their score and summary in <a href="https://dashboard.hiretrial.com.au" style="color:#c8a96e;text-decoration:none;font-weight:500;">your dashboard</a>.
    </p>
    <div style="background:#f5f4f0;border-radius:6px;padding:20px;margin:20px 0;">
      <div style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:rgba(0,0,0,0.42);font-weight:600;margin-bottom:8px;">Original subject</div>
      <div style="font-size:14px;color:#0a0a0a;margin-bottom:16px;">${originalSubject}</div>
      <div style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:rgba(0,0,0,0.42);font-weight:600;margin-bottom:8px;">Original message</div>
      <div style="font-size:13px;color:rgba(0,0,0,0.7);line-height:1.6;white-space:pre-wrap;">${escapeHtml(originalBody)}</div>
    </div>
    <div style="margin-top:32px;padding-top:20px;border-top:1px solid rgba(0,0,0,0.06);font-size:11px;line-height:1.7;color:rgba(0,0,0,0.42);text-align:center;">
      Trial. · hello@hiretrial.com.au · ABN 71 441 417 792
    </div>
  </td></tr>
</table>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}
