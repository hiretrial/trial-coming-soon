// ═══════════════════════════════════════════════════════════════════
// api/eoi-submit.ts
//
// Vercel API route. Receives EOI form POST from hiretrial.com.au,
// validates, writes to Supabase eoi_submissions table, returns JSON,
// and fires a branded notification email to Anders via Resend.
//
// Env vars required (set in Vercel dashboard):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   RESEND_API_KEY
//   ANDERS_ALERT_EMAIL        (optional — defaults to anders@hiretrial.com.au)
//
// Form fields accepted (from index.html EOI form):
//   venue_name, contact_name, email (required)
//   state (optional — single dropdown on the minimal landing form)
//   _gotcha (honeypot — silently ignore if filled)
//
// Note: full qualification data (venue_type, suburb, postcode,
// hires_per_year, applications_per_role, frustration, timing) is now
// collected on the post-Loom qualifier form, not at landing. This
// endpoint accepts those fields if present (for backwards compatibility
// or direct posts) but does not require them.
// ═══════════════════════════════════════════════════════════════════

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

// ─── Config ───────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANDERS_ALERT_EMAIL = process.env.ANDERS_ALERT_EMAIL || 'anders@hiretrial.com.au';
const RESEND_API_KEY = process.env.RESEND_API_KEY;

// ─── Validation ───────────────────────────────────────────────────
const REQUIRED_FIELDS = ['venue_name', 'contact_name', 'email'] as const;
const ALLOWED_FIELDS = [
  'venue_name', 'contact_name', 'email',
  'state',
  // Below are accepted but not collected on the minimal landing form.
  // Retained for backwards compatibility and forward compat with the
  // post-Loom qualifier form that will eventually write into this table.
  'phone', 'venue_type', 'suburb', 'postcode',
  'hires_per_year', 'applications_per_role',
  'frustration', 'timing',
];

// Basic email regex — catches obvious garbage, not RFC-perfect
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateBody(body: any): { ok: boolean; error?: string; data?: any } {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Invalid request body' };
  }

  // Honeypot — silently "succeed" so bots think they got through
  if (body._gotcha && String(body._gotcha).trim() !== '') {
    return { ok: false, error: 'HONEYPOT' };
  }

  // Required fields
  for (const field of REQUIRED_FIELDS) {
    if (!body[field] || String(body[field]).trim() === '') {
      return { ok: false, error: `${field} is required` };
    }
  }

  // Email format
  if (!EMAIL_RE.test(String(body.email).trim())) {
    return { ok: false, error: 'Invalid email format' };
  }

  // Length sanity checks (prevents abuse)
  const lengthLimits: Record<string, number> = {
    venue_name: 200,
    contact_name: 200,
    email: 254,
    state: 10,
    phone: 50,
    venue_type: 100,
    suburb: 100,
    postcode: 10,
    hires_per_year: 50,
    applications_per_role: 50,
    frustration: 2000,
    timing: 100,
  };
  for (const [field, max] of Object.entries(lengthLimits)) {
    if (body[field] && String(body[field]).length > max) {
      return { ok: false, error: `${field} too long (max ${max})` };
    }
  }

  // Build clean payload — only allowed fields, trimmed
  const data: Record<string, string> = {};
  for (const field of ALLOWED_FIELDS) {
    if (body[field] != null && String(body[field]).trim() !== '') {
      data[field] = String(body[field]).trim();
    }
  }

  // Lowercase email for dedup-friendliness
  data.email = data.email.toLowerCase();

  return { ok: true, data };
}

// ─── HTML escape helper ───────────────────────────────────────────
function esc(s: string | undefined | null): string {
  if (s == null) return '—';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Resend email notification ─────────────────────────────────────
// Sends Anders a branded notification email when an EOI lands.
async function notifyAnders(eoi: any): Promise<void> {
  if (!RESEND_API_KEY) {
    console.log('[eoi] RESEND_API_KEY missing — skipping notification');
    return;
  }
  try {
    const subject = `New Trial. EOI — ${eoi.venue_name}`;

    // URL-encoded values for the mailto button
    const mailtoSubject = encodeURIComponent('Trial. — your founding venue enquiry');
    const mailtoBody = encodeURIComponent(
      `Hi ${eoi.contact_name},\n\nThanks for the EOI — great to hear from ${eoi.venue_name}.\n\n`
    );

    // Plain-text fallback (for clients that strip HTML)
    const textBody = [
      `New EOI just landed — venue is now on the walkthrough path.`,
      ``,
      `Venue:        ${eoi.venue_name}`,
      `Contact:      ${eoi.contact_name}`,
      `Email:        ${eoi.email}`,
      `State:        ${eoi.state || '(not provided)'}`,
      ``,
      `—`,
      `Qualification data (venue type, hires/yr, frustration, etc.)`,
      `will arrive separately if/when they fill the post-Loom qualifier.`,
      ``,
      `Source of truth: Supabase eoi_submissions table.`,
    ].join('\n');

    // ═══ Branded HTML email — gold-on-near-black, matches hiretrial.com.au ═══
    const htmlBody = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>New EOI — Trial.</title>
</head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:'Inter Tight',system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#f8f6f0;-webkit-font-smoothing:antialiased;">

<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:#0a0a0a;opacity:0;">
  New founding-venue EOI from ${esc(eoi.venue_name)} — ${esc(eoi.contact_name)}
</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0a0a0a;padding:40px 16px;">
  <tr>
    <td align="center">

      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#131313;border:1px solid rgba(248,246,240,0.08);border-radius:4px;">

        <tr>
          <td style="padding:40px 40px 24px 40px;border-bottom:1px solid rgba(248,246,240,0.08);">
            <span style="font-family:'Cormorant Garamond',Georgia,'Times New Roman',serif;font-weight:600;font-size:26px;letter-spacing:-0.02em;color:#f8f6f0;">Trial</span><span style="font-family:'Cormorant Garamond',Georgia,'Times New Roman',serif;font-weight:600;font-size:30px;color:#c8a96e;">.</span>
          </td>
        </tr>

        <tr>
          <td style="padding:36px 40px 8px 40px;">
            <div style="font-size:11px;letter-spacing:0.22em;text-transform:uppercase;color:#c8a96e;font-weight:500;">
              New EOI &middot; Walkthrough sent
            </div>
          </td>
        </tr>
        <tr>
          <td style="padding:0 40px 32px 40px;">
            <h1 style="margin:0;font-family:'Cormorant Garamond',Georgia,'Times New Roman',serif;font-weight:500;font-size:32px;line-height:1.2;letter-spacing:-0.01em;color:#f8f6f0;">
              ${esc(eoi.venue_name)}
            </h1>
            <div style="margin-top:8px;font-size:14px;color:rgba(248,246,240,0.48);letter-spacing:0.02em;">
              ${esc(eoi.contact_name)}
            </div>
          </td>
        </tr>

        <tr>
          <td style="padding:0 40px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">

              <tr>
                <td style="padding:16px 0;border-top:1px solid rgba(248,246,240,0.08);font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:rgba(248,246,240,0.48);width:140px;vertical-align:top;">Email</td>
                <td style="padding:16px 0;border-top:1px solid rgba(248,246,240,0.08);font-size:15px;color:#f8f6f0;vertical-align:top;">
                  <a href="mailto:${esc(eoi.email)}" style="color:#c8a96e;text-decoration:none;">${esc(eoi.email)}</a>
                </td>
              </tr>

              <tr>
                <td style="padding:16px 0;border-top:1px solid rgba(248,246,240,0.08);border-bottom:1px solid rgba(248,246,240,0.08);font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:rgba(248,246,240,0.48);vertical-align:top;">State</td>
                <td style="padding:16px 0;border-top:1px solid rgba(248,246,240,0.08);border-bottom:1px solid rgba(248,246,240,0.08);font-size:15px;color:#f8f6f0;vertical-align:top;">${esc(eoi.state)}</td>
              </tr>

            </table>
          </td>
        </tr>

        <tr>
          <td style="padding:32px 40px 0 40px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:rgba(200,169,110,0.06);border:1px solid rgba(200,169,110,0.18);border-radius:4px;">
              <tr>
                <td style="padding:18px 22px;">
                  <div style="font-size:10px;letter-spacing:0.22em;text-transform:uppercase;color:rgba(248,246,240,0.48);font-weight:500;margin-bottom:8px;">
                    Funnel stage
                  </div>
                  <div style="font-size:14px;line-height:1.55;color:rgba(248,246,240,0.72);">
                    Lead has registered. Walkthrough (Loom) is now visible to them. Qualification data &mdash; venue type, hires/year, current process, frustration &mdash; will arrive separately if they complete the post-Loom qualifier.
                  </div>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <tr>
          <td style="padding:40px 40px 8px 40px;" align="left">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="background:#c8a96e;border-radius:2px;">
                  <a href="mailto:${esc(eoi.email)}?subject=${mailtoSubject}&body=${mailtoBody}"
                     style="display:inline-block;padding:14px 28px;font-family:'Inter Tight',system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;font-weight:500;letter-spacing:0.08em;text-transform:uppercase;color:#0a0a0a;text-decoration:none;">
                    Reply to this lead &rarr;
                  </a>
                </td>
              </tr>
            </table>
            <div style="margin-top:14px;font-size:12px;color:rgba(248,246,240,0.48);letter-spacing:0.02em;">
              Or just hit Reply &mdash; it goes straight to ${esc(eoi.contact_name)}.
            </div>
          </td>
        </tr>

        <tr>
          <td style="padding:48px 40px 40px 40px;border-top:1px solid rgba(248,246,240,0.08);">
            <div style="font-family:'Cormorant Garamond',Georgia,'Times New Roman',serif;font-weight:600;font-size:18px;color:#f8f6f0;">Trial<span style="color:#c8a96e;font-size:20px;">.</span></div>
            <div style="margin-top:8px;font-size:11px;letter-spacing:0.08em;color:rgba(248,246,240,0.28);">
              Hospitality hiring, built by operators.
            </div>
            <div style="margin-top:18px;font-size:11px;letter-spacing:0.06em;color:rgba(248,246,240,0.28);">
              ABN 71 441 417 792 &middot; Australia
            </div>
          </td>
        </tr>

      </table>

    </td>
  </tr>
</table>

</body>
</html>`;

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Trial. <notifications@hiretrial.com.au>',
        to: [ANDERS_ALERT_EMAIL],
        reply_to: eoi.email,
        subject,
        text: textBody,
        html: htmlBody,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.warn('[eoi] Resend notification failed:', res.status, err.slice(0, 200));
    } else {
      console.log('[eoi] ✅ Notification email sent to', ANDERS_ALERT_EMAIL);
    }
  } catch (e: any) {
    console.warn('[eoi] Notification error (non-fatal):', e?.message);
  }
}

// ─── Handler ──────────────────────────────────────────────────────
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS — locked to live site origin
  const origin = req.headers.origin as string | undefined;
  const allowedOrigins = ['https://hiretrial.com.au', 'https://www.hiretrial.com.au'];
  const corsOrigin = origin && allowedOrigins.includes(origin) ? origin : 'https://hiretrial.com.au';
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Env sanity check
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[eoi] Missing SUPABASE env vars');
    return res.status(500).json({ error: 'Server misconfiguration' });
  }

  // Parse body — Vercel auto-parses JSON, but form posts can come as
  // application/x-www-form-urlencoded which Vercel also handles
  const body = req.body || {};

  const validation = validateBody(body);
  if (!validation.ok) {
    // Honeypot — pretend success so bots don't retry / iterate
    if (validation.error === 'HONEYPOT') {
      console.log('[eoi] Honeypot triggered, fake-succeeding');
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: validation.error });
  }

  const data = validation.data!;

  // Capture IP + UA for spam audit
  const submittedIp =
    (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
    (req.headers['x-real-ip'] as string) ||
    '';
  const submittedUserAgent = (req.headers['user-agent'] as string) || '';

  // Write to Supabase
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: inserted, error } = await supabase
    .from('eoi_submissions')
    .insert({
      ...data,
      source: 'eoi_form',
      submitted_ip: submittedIp,
      submitted_user_agent: submittedUserAgent,
    })
    .select('id, venue_name, contact_name, email, created_at')
    .single();

  if (error) {
    console.error('[eoi] Supabase insert failed:', error);
    return res.status(500).json({ error: 'Could not save submission. Please email hello@hiretrial.com.au directly.' });
  }

  console.log(`[eoi] ✅ ${inserted.venue_name} (${inserted.email}) — id ${inserted.id}`);

  // Fire-and-forget notification (don't block response on Resend)
  await notifyAnders({ ...data }).catch(e => console.warn('[eoi] notifyAnders error:', e?.message));

  return res.status(200).json({
    ok: true,
    id: inserted.id,
    message: 'Received',
  });
}
