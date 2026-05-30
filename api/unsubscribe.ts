// ═══════════════════════════════════════════════════════════════════
// api/unsubscribe.ts
//
// Public endpoint — no auth required. One-click unsubscribe for
// Australian Spam Act 2003 compliance. Every commercial email sent
// by Trial. must include a functional unsubscribe link pointing here.
//
// Query params:
//   token   — unsubscribe_token (uuid) from venues or candidates table
//   type    — 'venue' | 'candidate' (defaults to 'venue')
//
// Flow:
//   1. Look up the token in the appropriate table
//   2. Flip email_opt_out = true, stamp email_opt_out_at
//   3. Redirect to /unsubscribed.html?type=venue|candidate
//
// Idempotent — re-clicking the same link is safe and still redirects
// to the confirmation page.
//
// Env vars required:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
// ═══════════════════════════════════════════════════════════════════

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PUBLIC_SITE_URL = process.env.PUBLIC_SITE_URL || 'https://hiretrial.com.au';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Allow GET (one-click email link) and POST (form submission)
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[unsubscribe] Missing SUPABASE env vars');
    return res.redirect(302, `${PUBLIC_SITE_URL}/unsubscribed.html?error=config`);
  }

  const token = (req.query.token as string) || (req.body?.token as string);
  const type = ((req.query.type as string) || (req.body?.type as string) || 'venue').toLowerCase();

  if (!token || typeof token !== 'string' || token.length < 10) {
    console.warn('[unsubscribe] Invalid or missing token');
    return res.redirect(302, `${PUBLIC_SITE_URL}/unsubscribed.html?error=invalid`);
  }

  if (type !== 'venue' && type !== 'candidate') {
    return res.redirect(302, `${PUBLIC_SITE_URL}/unsubscribed.html?error=invalid`);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const table = type === 'venue' ? 'venues' : 'candidates';

  try {
    // Look up by token
    const { data: row, error: lookupErr } = await admin
      .from(table)
      .select('id, email_opt_out')
      .eq('unsubscribe_token', token)
      .maybeSingle();

    if (lookupErr) {
      console.error(`[unsubscribe] Lookup failed on ${table}:`, lookupErr.message);
      return res.redirect(302, `${PUBLIC_SITE_URL}/unsubscribed.html?error=lookup`);
    }

    if (!row) {
      // Token not found — still redirect to confirmation so link isn't confusing
      console.warn(`[unsubscribe] Token not found in ${table}: ${token.slice(0, 8)}…`);
      return res.redirect(302, `${PUBLIC_SITE_URL}/unsubscribed.html?type=${type}`);
    }

    // Idempotent — already opted out, just confirm
    if (row.email_opt_out) {
      return res.redirect(302, `${PUBLIC_SITE_URL}/unsubscribed.html?type=${type}&already=1`);
    }

    // Flip the opt-out flag
    const { error: updateErr } = await admin
      .from(table)
      .update({
        email_opt_out: true,
        email_opt_out_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', row.id);

    if (updateErr) {
      console.error(`[unsubscribe] Update failed on ${table} id=${row.id}:`, updateErr.message);
      return res.redirect(302, `${PUBLIC_SITE_URL}/unsubscribed.html?error=update`);
    }

    console.log(`[unsubscribe] ✅ ${type} id=${row.id} opted out`);
    return res.redirect(302, `${PUBLIC_SITE_URL}/unsubscribed.html?type=${type}`);

  } catch (err: any) {
    console.error('[unsubscribe] Unexpected error:', err?.message);
    return res.redirect(302, `${PUBLIC_SITE_URL}/unsubscribed.html?error=unknown`);
  }
}
