// api/inbound-email.js

import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';
import crypto from 'crypto';

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
  'bartender': 'Bartender', 'bar-back': 'Bar Back', 'bar-manager': 'Bar Manager',
  'barista': 'Barista', 'cafe-allrounder': 'Café All-Rounder',
  'cafe-kitchen-hand': 'Kitchen Hand', 'cafe-manager': 'Café Manager',
  'duty-manager': 'Duty Manager', 'expediter': 'Expediter',
  'floor-staff': 'Floor Staff', 'food-runner': 'Food Runner',
  'host': 'Host', 'restaurant-manager': 'Restaurant Manager', 'supervisor': 'Supervisor'
};

const roleLabel = (r) => ROLE_LABELS[r] || r;

export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verifyResendSignature(rawBody, headers, secret) {
  if (!secret) return false;
  const svixId = headers['svix-id'] || headers['webhook-id'];
  const svixTimestamp = headers['svix-timestamp'] || headers['webhook-timestamp'];
  const svixSignature = headers['svix-signature'] || headers['webhook-signature'];
  if (!svixId || !svixTimestamp || !svixSignature) return false;
  try {
    const secretBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
    const signedContent = `${svixId}.${svixTimestamp}.${rawBody.toString('utf8')}`;
    const expected = crypto.createHmac('sha256', secretBytes).update(signedContent).digest('base64');
    const candidates = svixSignature.split(' ')
      .map(s => { const p = s.split(','); return p.length === 2 ? p[1] : null; })
      .filter(Boolean);
    return candidates.some(sig => {
      try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); }
      catch { return false; }
    });
  } catch (err) {
    console.error('[verifyResendSignature] Error:', err);
    return false;
  }
}

function detectRoleFromText(text, allowedRoles) {
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const { role, patterns } of ROLE_KEYWORDS) {
    if (!allowedRoles.includes(role)) continue;
    if (patterns.some(p => lower.includes(p))) return role;
  }
  return null;
}

function parseFromEmail(fromString) {
  if (!fromString) return null;
  const match = fromString.match(/<([^>]+)>/);
  return (match ? match[1] : fromString).trim().toLowerCase();
}

function capitalise(s) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

async function fetchAttachmentBuffer(emailId, attachmentMetadata) {
  try {
    const apiKey = process.env.RESEND_API_KEY;
    const listResp = await fetch(
      `https://api.resend.com/emails/${emailId}/attachments`,
      { headers: { 'Authorization': `Bearer ${apiKey}` } }
    );

    if (!listResp.ok) {
      console.error('[fetchAttachmentBuffer] List failed:', listResp.status, await listResp.text());
      return null;
    }

    const listData = await listResp.json();
    const attachments = listData.data || listData.attachments || listData;

    if (!Array.isArray(attachments) || attachments.length === 0) {
      console.warn('[fetchAttachmentBuffer] No attachments:', JSON.stringify(listData));
      return null;
    }

    const match = attachments.find(a => a.id === attachmentMetadata.id) || attachments[0];
    if (!match || !match.download_url) {
      console.warn('[fetchAttachmentBuffer] No download_url:', JSON.stringify(match));
      return null;
    }

    const resp = await fetch(match.download_url);
    if (!resp.ok) {
      console.error('[fetchAttachmentBuffer] Download failed:', resp.status);
      return null;
    }
    const buffer = Buffer.from(await resp.arrayBuffer());
    return { buffer, filename: match.filename, content_type: match.content_type };
  } catch (err) {
    console.error('[fetchAttachmentBuffer] Error:', err);
    return null;
  }
}

async function extractNameFromCV(cvBuffer, contentType, filename) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('[extractNameFromCV] No ANTHROPIC_API_KEY');
    return null;
  }

  const isPDF = contentType?.includes('pdf') || filename?.toLowerCase().endsWith('.pdf');
  const isDOCX = contentType?.includes('wordprocessingml') || filename?.toLowerCase().endsWith('.docx');

  if (!isPDF && !isDOCX) {
    console.warn('[extractNameFromCV] Unsupported file type:', contentType, filename);
    return null;
  }

  try {
    let documentBlock;

    if (isPDF) {
      documentBlock = {
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: cvBuffer.toString('base64')
        }
      };
    } else {
      const formData = new FormData();
      formData.append('file', new Blob([cvBuffer], {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      }), filename);

      const uploadResp = await fetch('https://api.anthropic.com/v1/files', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'files-api-2025-04-14'
        },
        body: formData
      });

      if (!uploadResp.ok) {
        const err = await uploadResp.text();
        console.error('[extractNameFromCV] DOCX upload failed:', uploadResp.status, err);
        return null;
      }

      const uploaded = await uploadResp.json();
      documentBlock = {
        type: 'document',
        source: { type: 'file', file_id: uploaded.id }
      };
    }

    const messagesResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'files-api-2025-04-14'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: [
            documentBlock,
            {
              type: 'text',
              text: 'What is the candidate\'s full name in this CV? Respond with ONLY a JSON object: {"first_name": "X", "last_name": "Y"}. No other text, no markdown. If unsure, use empty strings.'
            }
          ]
        }]
      })
    });

    if (!messagesResp.ok) {
      const err = await messagesResp.text();
      console.error('[extractNameFromCV] Claude API error:', messagesResp.status, err);
      return null;
    }

    const data = await messagesResp.json();
    const responseText = data.content?.[0]?.text || '';
    const cleaned = responseText.trim()
      .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '');

    const parsed = JSON.parse(cleaned);
    if (!parsed.first_name) return null;

    return {
      first_name: capitalise(parsed.first_name.trim()),
      last_name: parsed.last_name ? capitalise(parsed.last_name.trim()) : ''
    };
  } catch (err) {
    console.error('[extractNameFromCV] Error:', err);
    return null;
  }
}

async function extractCandidateName(emailId, attachments, fromString, bodyText, candidateEmail) {
  if (attachments && attachments.length > 0) {
    const cv = attachments.find(a => {
      const ct = a.content_type || '';
      const fn = (a.filename || '').toLowerCase();
      return ct.includes('pdf') || ct.includes('wordprocessingml') || fn.endsWith('.pdf') || fn.endsWith('.docx');
    });

    if (cv) {
      console.log('[extractCandidateName] Trying Level 0 (CV):', cv.filename);
      const fetched = await fetchAttachmentBuffer(emailId, cv);
      if (fetched) {
        const cvName = await extractNameFromCV(fetched.buffer, fetched.content_type, fetched.filename);
        if (cvName && cvName.first_name) {
          console.log('[extractCandidateName] Level 0 success:', cvName);
          return { ...cvName, source: 'cv_claude' };
        }
      }
    }
  }

  const cleanBody = bodyText
    ? bodyText
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    : '';

  if (fromString) {
    const match = fromString.match(/^([^<]+)<.*>$/);
    if (match) {
      const raw = match[1].trim().replace(/^["']|["']$/g, '');
      if (raw && !raw.includes('@')) {
        const parts = raw.split(/\s+/).filter(Boolean);
        if (parts.length >= 1 && /^[A-Za-zÀ-ÿ'-]+/.test(parts[0])) {
          return {
            first_name: capitalise(parts[0]),
            last_name: parts.slice(1).map(capitalise).join(' '),
            source: 'header_display_name'
          };
        }
      }
    }
  }

  if (cleanBody) {
    const sigRegex = /(?:cheers|thanks|regards|sincerely|kind regards|best regards|best|yours|warmly|—|--)[,.\s]+\s*([a-zà-ÿ'-]+(?:\s+[a-zà-ÿ'-]+)?)\b/i;
    const sigMatch = cleanBody.match(sigRegex);
    if (sigMatch && sigMatch[1]) {
      const parts = sigMatch[1].trim().split(/\s+/).filter(Boolean);
      if (parts.length >= 1) {
        return {
          first_name: capitalise(parts[0]),
          last_name: parts.slice(1).map(capitalise).join(' '),
          source: 'body_signature'
        };
      }
    }

    const introRegex = /(?:i['']m|my name is|this is)\s+([a-zà-ÿ'-]+(?:\s+[a-zà-ÿ'-]+)?)\b/i;
    const introMatch = cleanBody.match(introRegex);
    if (introMatch && introMatch[1]) {
      const parts = introMatch[1].trim().split(/\s+/).filter(Boolean);
      if (parts.length >= 1) {
        return {
          first_name: capitalise(parts[0]),
          last_name: parts.slice(1).map(capitalise).join(' '),
          source: 'body_intro'
        };
      }
    }
  }

  if (candidateEmail) {
    const username = candidateEmail.split('@')[0];
    const parts = username.split(/[._\-+]+/)
      .filter(p => p && /^[a-zA-Z]+$/.test(p))
      .map(capitalise);
    if (parts.length >= 1) {
      return { first_name: parts[0], last_name: parts.slice(1).join(' '), source: 'email_username' };
    }
  }

  return { first_name: '', last_name: '', source: 'none' };
}

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
    ...pickN(byDifficulty.easy, 3),
    ...pickN(byDifficulty.medium, 5),
    ...pickN(byDifficulty.hard, 2)
  ];

  const categoryCounts = {};
  picks.forEach(q => { categoryCounts[q.category] = (categoryCounts[q.category] || 0) + 1; });

  return {
    picked: picks.map(q => q.id),
    audit: {
      role, pool_size: pool.length, picked_count: picks.length,
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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  try {
    const rawBody = await readRawBody(req);
    const secret = process.env.RESEND_WEBHOOK_SECRET;

    if (!verifyResendSignature(rawBody, req.headers, secret)) {
      return res.status(401).send('Invalid signature');
    }

    const event = JSON.parse(rawBody.toString('utf8'));
    if (event.type !== 'email.received') {
      return res.status(200).json({ ignored: true });
    }

    const emailData = event.data;
    const emailId = emailData.email_id;
    const toAddress = (emailData.to?.[0] || '').toLowerCase().trim();
    const fromString = emailData.from || '';
    const subject = emailData.subject || '';
    const bodyText = emailData.text || emailData.html || '';
    const attachments = emailData.attachments || [];

    console.log('[inbound-email] Received:', { to: toAddress, from: fromString, subject, attachmentCount: attachments.length });
    console.log('[inbound-email] Full event.data keys:', Object.keys(emailData));
    console.log('[inbound-email] email_id field:', emailData.email_id);
    console.log('[inbound-email] id field:', emailData.id);
    console.log('[inbound-email] Raw attachment metadata:', JSON.stringify(attachments[0]));

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const resend = new Resend(process.env.RESEND_API_KEY);

    const { data: venue, error: venueErr } = await supabase
      .from('venues')
      .select('id, name, slug, inbound_address, allowed_roles, default_role, manager_email, manager_name, brand_logo_url, brand_primary_color, account_id')
      .eq('inbound_address', toAddress)
      .maybeSingle();

    if (venueErr || !venue) {
      console.warn('[inbound-email] Unknown venue:', toAddress);
      return res.status(200).json({ ignored: 'unknown_venue' });
    }

    const allowedRoles = venue.allowed_roles || [];
    let detectedRole = null;
    let detectionMethod = 'unknown';

    if (allowedRoles.length === 1) {
      detectedRole = allowedRoles[0];
      detectionMethod = 'layer_1_single_role';
    }
    if (!detectedRole) {
      detectedRole = detectRoleFromText(subject, allowedRoles) || detectRoleFromText(bodyText, allowedRoles);
      if (detectedRole) detectionMethod = 'layer_2_keyword';
    }
    if (!detectedRole && venue.default_role) {
      detectedRole = venue.default_role;
      detectionMethod = 'fallback_default_role';
    }
    if (!detectedRole) {
      return res.status(200).json({ ignored: 'role_detection_failed', venue: venue.slug });
    }

    const candidateEmail = parseFromEmail(fromString);
    const { first_name, last_name, source: nameSource } = await extractCandidateName(
      emailId, attachments, fromString, bodyText, candidateEmail
    );
    console.log('[inbound-email] Name extracted via:', nameSource, '→', first_name, last_name);

    if (!candidateEmail) {
      return res.status(200).json({ ignored: 'no_candidate_email' });
    }

    const { data: existingCandidate } = await supabase
      .from('candidates').select('id').eq('email', candidateEmail).maybeSingle();

    let candidateId;
    if (existingCandidate) {
      candidateId = existingCandidate.id;
      if (first_name) {
        await supabase.from('candidates')
          .update({ first_name, last_name, last_active_at: new Date().toISOString() })
          .eq('id', candidateId);
      } else {
        await supabase.from('candidates')
          .update({ last_active_at: new Date().toISOString() })
          .eq('id', candidateId);
      }
    } else {
      const { data: newCandidate, error: insertErr } = await supabase
        .from('candidates').insert({
          first_name, last_name, email: candidateEmail,
          first_seen_at: new Date().toISOString(), last_active_at: new Date().toISOString()
        }).select('id').single();
      if (insertErr) {
        console.error('[inbound-email] Candidate insert failed:', insertErr);
        return res.status(500).send('Database error');
      }
      candidateId = newCandidate.id;
    }

    const { picked, audit } = await pickQuestions(supabase, detectedRole);
    if (picked.length === 0) {
      return res.status(500).send('No questions available');
    }

    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const { data: assessment, error: assessErr } = await supabase
      .from('assessments').insert({
        candidate_id: candidateId, venue_id: venue.id, role: detectedRole,
        status: 'in_progress', token, picked_question_ids: picked,
        picker_audit: { ...audit, detection_method: detectionMethod, name_source: nameSource },
        expires_at: expiresAt,
        candidate_profile: { first_name, last_name, email: candidateEmail, source_subject: subject, source_from: fromString }
      }).select('id, token').single();

    if (assessErr) {
      console.error('[inbound-email] Assessment insert failed:', assessErr);
      return res.status(500).send('Failed to create assessment');
    }

    const assessmentUrl = `https://hiretrial.com.au/assess.html?token=${token}`;
    const displayName = first_name || 'there';

    try {
      await resend.emails.send({
        from: `${venue.name} via Trial. <hello@hiretrial.com.au>`,
        to: candidateEmail, reply_to: 'hello@hiretrial.com.au',
        subject: `Complete your trial for ${venue.name} — ${roleLabel(detectedRole)}`,
        html: candidateEmailHtml({
          firstName: displayName, venueName: venue.name,
          roleLabel: roleLabel(detectedRole), assessmentUrl
        })
      });
    } catch (err) {
      console.error('[inbound-email] Candidate email send failed:', err);
    }

    if (venue.manager_email) {
      try {
        const attachmentPayloads = [];
        let resendAttachments = [];
        try {
          const listResp = await fetch(
            `https://api.resend.com/emails/${emailId}/attachments`,
            { headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}` } }
          );
          if (listResp.ok) {
            const listData = await listResp.json();
            resendAttachments = listData.data || listData.attachments || listData || [];
          }
        } catch (e) {
          console.warn('[inbound-email] Attachment list failed for forward:', e);
        }

        for (const att of (resendAttachments || [])) {
          if (att.download_url) {
            try {
              const resp = await fetch(att.download_url);
              const buf = Buffer.from(await resp.arrayBuffer());
              attachmentPayloads.push({ filename: att.filename || 'attachment', content: buf });
            } catch (e) {
              console.warn('[inbound-email] Attachment fetch failed:', att.filename);
            }
          }
        }

        await resend.emails.send({
          from: `Trial. <hello@hiretrial.com.au>`,
          to: venue.manager_email, reply_to: candidateEmail,
          subject: `[Trial. — ${roleLabel(detectedRole)}] ${subject}`,
          html: forwardEmailHtml({
            venueName: venue.name,
            candidateName: `${first_name} ${last_name}`.trim() || candidateEmail,
            candidateEmail, roleLabel: roleLabel(detectedRole),
            originalSubject: subject, originalBody: bodyText
          }),
          attachments: attachmentPayloads
        });
      } catch (err) {
        console.error('[inbound-email] Forward email send failed:', err);
      }
    }

    console.log('[inbound-email] Success:', { venue: venue.slug, role: detectedRole, nameSource, assessmentId: assessment.id });
    return res.status(200).json({ ok: true, assessment_id: assessment.id });

  } catch (err) {
    console.error('[inbound-email] Unexpected error:', err);
    return res.status(500).send('Server error');
  }
}

function candidateEmailHtml({ firstName, venueName, roleLabel, assessmentUrl }) {
  return `<!DOCTYPE html>
<html lang="en-AU"><head><meta charset="UTF-8"><title>Your Trial. assessment</title></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:Georgia,'Times New Roman',serif;color:#f8f6f0;">
<table cellpadding="0" cellspacing="0" width="100%" style="max-width:560px;margin:0 auto;background:#0a0a0a;padding:48px 32px;">
  <tr><td>
    <div style="font-family:'Playfair Display',Georgia,serif;font-size:32px;font-weight:900;letter-spacing:-0.6px;color:#f8f6f0;margin-bottom:48px;">Trial<span style="color:#c8a96e;">.</span></div>
    <div style="font-size:11px;letter-spacing:0.28em;text-transform:uppercase;color:#c8a96e;font-weight:600;margin-bottom:16px;font-family:Arial,sans-serif;">Your assessment</div>
    <h1 style="font-family:'Playfair Display',Georgia,serif;font-weight:800;font-size:36px;line-height:1.1;letter-spacing:-1px;margin:0 0 16px 0;color:#f8f6f0;">
      Hi ${firstName} —<br><span style="font-style:italic;font-weight:500;color:#c8a96e;">${venueName}</span> wants to know how you'd handle their floor.
    </h1>
    <p style="font-size:15px;line-height:1.6;color:rgba(248,246,240,0.62);margin:24px 0;font-family:Arial,sans-serif;">
      Thanks for applying for the <strong style="color:#f8f6f0;font-weight:500;">${roleLabel}</strong> role at ${venueName}. Before they bring you in, they've asked for a quick trial — ten scenario questions that take <strong style="color:#f8f6f0;font-weight:500;">about twelve to fifteen minutes</strong>. There are no right or wrong answers in the abstract — they want to see how <em>you</em> think.
    </p>
    <table cellpadding="0" cellspacing="0" style="margin:32px 0;"><tr><td style="background:#c8a96e;border-radius:8px;">
      <a href="${assessmentUrl}" style="display:inline-block;padding:14px 28px;color:#0a0a0a;text-decoration:none;font-family:Arial,sans-serif;font-weight:600;font-size:15px;letter-spacing:0.02em;">Begin your assessment &rarr;</a>
    </td></tr></table>
    <p style="font-size:13px;line-height:1.6;color:rgba(248,246,240,0.42);margin:24px 0 0 0;font-family:Arial,sans-serif;">
      Your link expires in 7 days. If the button doesn't work, paste this into your browser:<br>
      <span style="color:#c8a96e;word-break:break-all;">${assessmentUrl}</span>
    </p>
    <div style="margin-top:48px;padding-top:24px;border-top:1px solid rgba(255,255,255,0.06);font-size:11px;line-height:1.7;color:rgba(248,246,240,0.42);text-align:center;font-family:Arial,sans-serif;">Trial. · hello@hiretrial.com.au · ABN 71 441 417 792</div>
  </td></tr></table>
</body></html>`;
}

function forwardEmailHtml({ venueName, candidateName, candidateEmail, roleLabel, originalSubject, originalBody }) {
  return `<!DOCTYPE html>
<html lang="en-AU"><head><meta charset="UTF-8"><title>New application via Trial.</title></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:Georgia,'Times New Roman',serif;color:#f8f6f0;">
<table cellpadding="0" cellspacing="0" width="100%" style="max-width:600px;margin:0 auto;background:#0a0a0a;padding:48px 32px;">
  <tr><td>
    <div style="font-family:'Playfair Display',Georgia,serif;font-size:28px;font-weight:900;letter-spacing:-0.5px;color:#f8f6f0;margin-bottom:40px;">Trial<span style="color:#c8a96e;">.</span></div>
    <div style="font-size:11px;letter-spacing:0.28em;text-transform:uppercase;color:#c8a96e;font-weight:600;margin-bottom:14px;font-family:Arial,sans-serif;">New application &middot; ${roleLabel}</div>
    <h1 style="font-family:'Playfair Display',Georgia,serif;font-weight:700;font-size:30px;line-height:1.15;letter-spacing:-0.6px;margin:0 0 6px 0;color:#f8f6f0;">${candidateName}</h1>
    <div style="font-size:14px;color:rgba(248,246,240,0.52);margin-bottom:32px;font-family:Arial,sans-serif;">
      <a href="mailto:${candidateEmail}" style="color:#c8a96e;text-decoration:none;">${candidateEmail}</a>
    </div>
    <p style="font-size:14.5px;line-height:1.65;color:rgba(248,246,240,0.72);margin:0 0 28px 0;font-family:Arial,sans-serif;">
      Original application as it landed in your Trial<span style="color:#c8a96e;">.</span> inbox for <strong style="color:#f8f6f0;font-weight:500;">${venueName}</strong>. CV attached. We've sent the candidate their assessment — score lands in <a href="https://dashboard.hiretrial.com.au" style="color:#c8a96e;text-decoration:none;font-weight:500;">your dashboard</a> shortly.
    </p>
    <div style="background:rgba(255,255,255,0.025);border:1px solid rgba(255,255,255,0.07);border-radius:10px;padding:24px;margin:24px 0;">
      <div style="font-size:10px;letter-spacing:0.24em;text-transform:uppercase;color:#c8a96e;font-weight:600;margin-bottom:10px;font-family:Arial,sans-serif;">Original subject</div>
      <div style="font-size:15px;color:#f8f6f0;margin-bottom:24px;font-family:Arial,sans-serif;font-weight:500;">${escapeHtml(originalSubject)}</div>
      <div style="font-size:10px;letter-spacing:0.24em;text-transform:uppercase;color:#c8a96e;font-weight:600;margin-bottom:10px;font-family:Arial,sans-serif;">Original message</div>
      <div style="font-size:13.5px;color:rgba(248,246,240,0.72);line-height:1.65;white-space:pre-wrap;font-family:Arial,sans-serif;">${escapeHtml(originalBody)}</div>
    </div>
    <div style="font-size:13px;color:rgba(248,246,240,0.42);margin:32px 0 0 0;font-family:Arial,sans-serif;line-height:1.5;">Reply to this email to respond directly to <strong style="color:rgba(248,246,240,0.62);font-weight:500;">${candidateName}</strong>.</div>
    <div style="margin-top:48px;padding-top:24px;border-top:1px solid rgba(255,255,255,0.06);font-size:11px;line-height:1.7;color:rgba(248,246,240,0.42);text-align:center;font-family:Arial,sans-serif;">Trial<span style="color:#c8a96e;">.</span> &middot; hello@hiretrial.com.au &middot; ABN 71 441 417 792</div>
  </td></tr></table>
</body></html>`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
