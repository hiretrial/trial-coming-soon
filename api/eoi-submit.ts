// ═══════════════════════════════════════════════════════════════════
// api/eoi-submit.ts
//
// Vercel API route. Receives EOI form POST from hiretrial.com.au,
// validates, writes to Supabase eoi_submissions table, returns JSON.
//
// Env vars required (set in Vercel dashboard):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   POSTMARK_SERVER_TOKEN     (optional — email stubs gracefully if missing)
//   ANDERS_ALERT_EMAIL        (optional — defaults to anders@hiretrial.com.au)
//
// Form fields accepted (from index.html EOI form):
//   venue_name, contact_name, email (required)
//   phone, venue_type, hires_per_year, applications_per_role,
//   frustration, timing
//   _gotcha (honeypot — silently ignore if filled)
// ═══════════════════════════════════════════════════════════════════

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

// ─── Config ───────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const POSTMARK_SERVER_TOKEN = process.env.POSTMARK_SERVER_TOKEN;
const ANDERS_ALERT_EMAIL = process.env.ANDERS_ALERT_EMAIL || 'anders@hiretrial.com.au';
const POSTMARK_FROM = process.env.POSTMARK_FROM_ADDRESS || 'hello@hiretrial.com.au';

// ─── Validation ───────────────────────────────────────────────────
const REQUIRED_FIELDS = ['venue_name', 'contact_name', 'email'] as const;
const ALLOWED_FIELDS = [
  'venue_name', 'contact_name', 'email', 'phone',
  'venue_type', 'hires_per_year', 'applications_per_role',
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
    phone: 50,
    venue_type: 100,
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

// ─── Postmark email stub ──────────────────────────────────────────
// Sends Anders a notification when an EOI lands. If POSTMARK_SERVER_TOKEN
// is missing (DKIM not verified yet), this returns silently without crashing.
async function notifyAnders(eoi: any): Promise<void> {
  if (!POSTMARK_SERVER_TOKEN) {
    console.log('[eoi] Postmark token missing — skipping notification email');
    return;
  }
  try {
    const subject = `🔔 New Trial. EOI — ${eoi.venue_name}`;
    const lines = [
      `New Founding Venue EOI just landed.`,
      ``,
      `Venue:        ${eoi.venue_name}`,
      `Contact:      ${eoi.contact_name}`,
      `Email:        ${eoi.email}`,
      `Phone:        ${eoi.phone || '—'}`,
      `Venue type:   ${eoi.venue_type || '—'}`,
      `Hires/year:   ${eoi.hires_per_year || '—'}`,
      `Apps/role:    ${eoi.applications_per_role || '—'}`,
      `Timing:       ${eoi.timing || '—'}`,
      ``,
      `Frustration:`,
      `${eoi.frustration || '(not provided)'}`,
      ``,
      `—`,
      `Reply within 24 hrs per the founding promise. Source of truth: Supabase eoi_submissions table.`,
    ];
    const textBody = lines.join('\n');

    const res = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-Postmark-Server-Token': POSTMARK_SERVER_TOKEN,
      },
      body: JSON.stringify({
        From: POSTMARK_FROM,
        To: ANDERS_ALERT_EMAIL,
        Subject: subject,
        TextBody: textBody,
        MessageStream: 'outbound',
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.warn('[eoi] Postmark notification failed:', res.status, err.slice(0, 200));
    } else {
      console.log('[eoi] Notification email sent to', ANDERS_ALERT_EMAIL);
    }
  } catch (e: any) {
    // Never throw from notification — submission must succeed regardless
    console.warn('[eoi] Notification error (non-fatal):', e?.message);
  }
}

// ─── Handler ──────────────────────────────────────────────────────
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS — only allow the live site origin in production, * for now during testing
  res.setHeader('Access-Control-Allow-Origin', '*');
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

  // Fire-and-forget notification (don't block response on Postmark)
  notifyAnders({ ...data }).catch(e => console.warn('[eoi] notifyAnders error:', e?.message));

  return res.status(200).json({
    ok: true,
    id: inserted.id,
    message: 'Received',
  });
}
