// api/eoi-nudge-worker.ts
//
// Daily cron. Fires follow-up emails to EOI submissions that haven't
// booked a demo yet.
//
// Sequence:
//   Day 3  — "Did you get a chance to watch the walkthrough?"
//   Day 7  — "Founding Partner window closes 15 July — last nudge"
//
// Triggered by Vercel Cron (vercel.json schedule — run daily at 9am AEST).
// Secured by CRON_SECRET in Authorization header.
//
// Requires env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   RESEND_API_KEY
//   CRON_SECRET
//   LOOM_URL (optional — falls back to hiretrial.com.au/#walkthrough)

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const RESEND_API_KEY = process.env.RESEND_API_KEY!;
const CRON_SECRET = process.env.CRON_SECRET!;
const LOOM_URL = process.env.LOOM_URL || 'https://hiretrial.com.au/?ref=email';
const CALENDLY_URL = 'https://calendly.com/anders-hiretrial/demo';

function esc(s: string | undefined | null): string {
  if (s == null) return '—';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

function buildDay3Html(firstName: string, venueName: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Still keen? — Trial.</title></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:40px 20px;">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;">

  <tr><td style="padding-bottom:32px;">
    <span style="font-family:Georgia,serif;font-size:22px;font-weight:800;color:#f8f6f0;letter-spacing:-0.4px;">Trial<span style="color:#c8a96e;">.</span></span>
  </td></tr>

  <tr><td style="background:linear-gradient(160deg,#1f1a12 0%,#16120c 100%);border:1px solid rgba(200,169,110,0.35);border-radius:16px;padding:44px 40px 36px;box-shadow:0 0 48px rgba(200,169,110,0.08);">
    <p style="margin:0 0 8px;font-size:11px;letter-spacing:0.26em;text-transform:uppercase;color:#c8a96e;font-weight:600;font-family:Arial,sans-serif;">Following up</p>
    <h1 style="margin:0 0 20px;font-family:Georgia,serif;font-size:28px;font-weight:800;color:#f8f6f0;line-height:1.15;letter-spacing:-0.6px;">Did you get a chance to watch?</h1>

    <p style="margin:0 0 24px;font-size:15px;line-height:1.65;color:rgba(248,246,240,0.75);font-family:Arial,sans-serif;">
      Hey ${esc(firstName)} — just checking in. You registered your EOI for <strong style="color:#f8f6f0;">${esc(venueName)}</strong> a few days ago. If you haven't had a chance to watch the walkthrough yet, here it is again.
    </p>

    <table cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr><td style="background:#c8a96e;border-radius:10px;">
        <a href="https://hiretrial.com.au/?ref=email" style="display:inline-block;padding:15px 32px;color:#0a0a0a;text-decoration:none;font-family:Arial,sans-serif;font-weight:700;font-size:15px;letter-spacing:0.02em;">Watch the walkthrough &rarr;</a>
      </td></tr>
    </table>

    <p style="margin:0 0 24px;font-size:14px;line-height:1.65;color:rgba(248,246,240,0.6);font-family:Arial,sans-serif;">
      Once you've watched, book a demo and we'll walk through it live with your venue setup: <a href="${CALENDLY_URL}" style="color:#c8a96e;text-decoration:none;">Book a demo</a>
    </p>

    <p style="margin:0;font-size:13px;line-height:1.65;color:rgba(248,246,240,0.45);font-family:Arial,sans-serif;">
      Founding Partner pricing closes 15 July. After that it's gone. Just reply if you've got questions — comes straight to me.<br><br>
      — Anders
    </p>
  </td></tr>

  <tr><td style="padding-top:28px;text-align:center;">
    <p style="margin:0;font-size:11px;color:rgba(248,246,240,0.3);font-family:Arial,sans-serif;line-height:1.8;">
      Trial. &middot; ABN 71 441 417 792 &middot; <a href="mailto:hello@hiretrial.com.au" style="color:rgba(248,246,240,0.3);text-decoration:none;">hello@hiretrial.com.au</a>
    </p>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

function buildDay7Html(firstName: string, venueName: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Last chance — Trial.</title></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:40px 20px;">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;">

  <tr><td style="padding-bottom:32px;">
    <span style="font-family:Georgia,serif;font-size:22px;font-weight:800;color:#f8f6f0;letter-spacing:-0.4px;">Trial<span style="color:#c8a96e;">.</span></span>
  </td></tr>

  <tr><td style="background:linear-gradient(160deg,#1f1a12 0%,#16120c 100%);border:1px solid rgba(200,169,110,0.35);border-radius:16px;padding:44px 40px 36px;box-shadow:0 0 48px rgba(200,169,110,0.08);">
    <p style="margin:0 0 8px;font-size:11px;letter-spacing:0.26em;text-transform:uppercase;color:#c8a96e;font-weight:600;font-family:Arial,sans-serif;">Last nudge</p>
    <h1 style="margin:0 0 20px;font-family:Georgia,serif;font-size:28px;font-weight:800;color:#f8f6f0;line-height:1.15;letter-spacing:-0.6px;">Founding pricing closes 15 July.</h1>

    <p style="margin:0 0 24px;font-size:15px;line-height:1.65;color:rgba(248,246,240,0.75);font-family:Arial,sans-serif;">
      Hey ${esc(firstName)} — last one from me, I promise. You registered an EOI for <strong style="color:#f8f6f0;">${esc(venueName)}</strong> and I haven't heard back.
    </p>

    <p style="margin:0 0 24px;font-size:15px;line-height:1.65;color:rgba(248,246,240,0.75);font-family:Arial,sans-serif;">
      Founding Partner pricing — $89.99/mo, hire fee only if they stay 90 days — closes 15 July. After that, standard pricing applies and it's higher.
    </p>

    <p style="margin:0 0 28px;font-size:15px;line-height:1.65;color:rgba(248,246,240,0.75);font-family:Arial,sans-serif;">
      If now's not the right time, no worries at all. But if you're still interested — watch the walkthrough and book a demo before the window closes.
    </p>

    <table cellpadding="0" cellspacing="0" style="margin-bottom:16px;">
      <tr><td style="background:#c8a96e;border-radius:10px;">
        <a href="https://hiretrial.com.au/?ref=email" style="display:inline-block;padding:15px 32px;color:#0a0a0a;text-decoration:none;font-family:Arial,sans-serif;font-weight:700;font-size:15px;letter-spacing:0.02em;">Watch the walkthrough &rarr;</a>
      </td></tr>
    </table>

    <p style="margin:0 0 24px;font-size:14px;line-height:1.65;color:rgba(248,246,240,0.6);font-family:Arial,sans-serif;">
      <a href="${CALENDLY_URL}" style="color:#c8a96e;text-decoration:none;">Book your demo here</a>
    </p>

    <p style="margin:0;font-size:13px;line-height:1.65;color:rgba(248,246,240,0.45);font-family:Arial,sans-serif;">
      — Anders
    </p>
  </td></tr>

  <tr><td style="padding-top:28px;text-align:center;">
    <p style="margin:0;font-size:11px;color:rgba(248,246,240,0.3);font-family:Arial,sans-serif;line-height:1.8;">
      Trial. &middot; ABN 71 441 417 792 &middot; <a href="mailto:hello@hiretrial.com.au" style="color:rgba(248,246,240,0.3);text-decoration:none;">hello@hiretrial.com.au</a>
    </p>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const authHeader = req.headers.authorization || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const nowIso = new Date().toISOString();

  // Load EOIs with no demo booking and no opt-out
  const { data: eois, error } = await supabase
    .from('eoi_submissions')
    .select('id, venue_name, contact_name, email, created_at, calendly_booking_at, nudge_day3_sent_at, nudge_day7_sent_at, email_opt_out')
    .is('calendly_booking_at', null)
    .not('email_opt_out', 'is', true)
    .order('created_at', { ascending: true });

  if (error) {
    return res.status(500).json({ error: `Supabase query failed: ${error.message}` });
  }

  const results = [];

  const EOI_CLOSE_DATE = new Date('2026-07-15T23:59:59+10:00'); // 15 July 2026 AEST

  for (const eoi of eois || []) {
    const days = daysSince(eoi.created_at);
    const firstName = eoi.contact_name?.split(' ')[0] || eoi.contact_name || 'there';

    // Don't send nudges after EOI window closes
    if (new Date() > EOI_CLOSE_DATE) {
      console.log('[eoi-nudge] EOI window closed — skipping all nudges');
      break;
    }

    // Day 3 nudge — send if 3+ days since EOI and not yet sent
    if (days >= 3 && !eoi.nudge_day3_sent_at) {
      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'Anders at Trial. <hello@hiretrial.com.au>',
            to: eoi.email,
            reply_to: 'anders@hiretrial.com.au',
            subject: `Did you get a chance to watch the walkthrough?`,
            html: buildDay3Html(firstName, eoi.venue_name),
            tags: [{ name: 'category', value: 'eoi-nudge-day3' }],
          }),
        });

        await supabase.from('eoi_submissions').update({ nudge_day3_sent_at: nowIso }).eq('id', eoi.id);
        results.push({ id: eoi.id, venue: eoi.venue_name, nudge: 'day3', sent: true });
        console.log(`[eoi-nudge] Day 3 sent to ${eoi.email}`);
      } catch (e: any) {
        results.push({ id: eoi.id, venue: eoi.venue_name, nudge: 'day3', error: e.message });
      }
      continue;
    }

    // Day 7 nudge — send if 7+ days since EOI, day3 already sent, day7 not yet sent
    if (days >= 7 && eoi.nudge_day3_sent_at && !eoi.nudge_day7_sent_at) {
      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'Anders at Trial. <hello@hiretrial.com.au>',
            to: eoi.email,
            reply_to: 'anders@hiretrial.com.au',
            subject: `Founding Partner pricing closes 15 July — last nudge`,
            html: buildDay7Html(firstName, eoi.venue_name),
            tags: [{ name: 'category', value: 'eoi-nudge-day7' }],
          }),
        });

        await supabase.from('eoi_submissions').update({ nudge_day7_sent_at: nowIso }).eq('id', eoi.id);
        results.push({ id: eoi.id, venue: eoi.venue_name, nudge: 'day7', sent: true });
        console.log(`[eoi-nudge] Day 7 sent to ${eoi.email}`);
      } catch (e: any) {
        results.push({ id: eoi.id, venue: eoi.venue_name, nudge: 'day7', error: e.message });
      }
    }
  }

  return res.status(200).json({ ok: true, now: nowIso, processed: results.length, results });
}
