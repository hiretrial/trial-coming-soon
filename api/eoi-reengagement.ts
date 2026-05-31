// api/eoi-reengagement.ts
//
// One-shot cron. Fires on 17 August 2026 (public launch day).
// Sends a re-engagement email to every EOI that:
//   - Submitted before 15 July (EOI window)
//   - Never booked a Calendly demo
//   - Has not opted out of email
//   - Has not already received this email
//
// Offer: re-engagement pricing (better than public, worse than founding)
//   Solo $109.99/mo | Starter $169.99/mo | Growth $299.99/mo
// Urgency: book a demo within 24 hours to lock this rate
//
// Triggered by Vercel Cron (vercel.json — run once on 17 Aug at 9am AEST = 11pm UTC 16 Aug)
// Secured by CRON_SECRET in Authorization header.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const RESEND_API_KEY = process.env.RESEND_API_KEY!;
const CRON_SECRET = process.env.CRON_SECRET!;

const CALENDLY_REENGAGEMENT_URL = 'https://calendly.com/anders-hiretrial/demo?utm_source=reengagement';
const EOI_WINDOW_CLOSE = new Date('2026-07-15T23:59:59+10:00');
const LAUNCH_DATE = new Date('2026-05-01T00:00:00+10:00'); // TEMP TEST — change back to 2026-08-17 after testing
const OFFER_EXPIRY_HOURS = 24;

function esc(s: string | undefined | null): string {
  if (s == null) return '—';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildReengagementHtml(firstName: string, venueName: string, offerExpiry: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>We just went live — Trial.</title></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:40px 20px;">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;">

  <tr><td style="padding-bottom:32px;">
    <span style="font-family:Georgia,serif;font-size:22px;font-weight:800;color:#f8f6f0;letter-spacing:-0.4px;">Trial<span style="color:#c8a96e;">.</span></span>
  </td></tr>

  <tr><td style="background:linear-gradient(160deg,#1f1a12 0%,#16120c 100%);border:1px solid rgba(200,169,110,0.35);border-radius:16px;padding:44px 40px 36px;box-shadow:0 0 48px rgba(200,169,110,0.08);">

    <p style="margin:0 0 8px;font-size:11px;letter-spacing:0.26em;text-transform:uppercase;color:#c8a96e;font-weight:600;font-family:Arial,sans-serif;">We're live</p>
    <h1 style="margin:0 0 20px;font-family:Georgia,serif;font-size:30px;font-weight:800;color:#f8f6f0;line-height:1.15;letter-spacing:-0.6px;">We just went live — and we've kept a spot for you.</h1>

    <p style="margin:0 0 20px;font-size:15px;line-height:1.65;color:rgba(248,246,240,0.75);font-family:Arial,sans-serif;">
      Hey ${esc(firstName)} — Trial. opened to the public today. Founding Partner pricing is gone.
    </p>

    <p style="margin:0 0 24px;font-size:15px;line-height:1.65;color:rgba(248,246,240,0.75);font-family:Arial,sans-serif;">
      But because <strong style="color:#f8f6f0;">${esc(venueName)}</strong> registered early, we've held one last offer — just for you, just for the next 24 hours.
    </p>

    <!-- Offer block -->
    <table width="100%" cellpadding="0" cellspacing="0" style="background:rgba(200,169,110,0.08);border:1px solid rgba(200,169,110,0.25);border-radius:12px;margin-bottom:28px;">
      <tr><td style="padding:22px 26px;">
        <p style="margin:0 0 12px;font-size:10px;letter-spacing:0.22em;text-transform:uppercase;color:rgba(248,246,240,0.45);font-family:Arial,sans-serif;">Your exclusive offer — expires ${esc(offerExpiry)}</p>
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="font-size:13px;color:rgba(248,246,240,0.55);font-family:Arial,sans-serif;padding-bottom:8px;">Solo</td>
            <td align="right" style="font-size:13px;color:#f8f6f0;font-weight:600;font-family:Arial,sans-serif;padding-bottom:8px;">$109.99/mo</td>
          </tr>
          <tr>
            <td style="font-size:13px;color:rgba(248,246,240,0.55);font-family:Arial,sans-serif;padding-bottom:8px;">Starter</td>
            <td align="right" style="font-size:13px;color:#f8f6f0;font-weight:600;font-family:Arial,sans-serif;padding-bottom:8px;">$169.99/mo</td>
          </tr>
          <tr>
            <td style="font-size:13px;color:rgba(248,246,240,0.55);font-family:Arial,sans-serif;">Growth</td>
            <td align="right" style="font-size:13px;color:#f8f6f0;font-weight:600;font-family:Arial,sans-serif;">$299.99/mo</td>
          </tr>
        </table>
        <p style="margin:12px 0 0;font-size:12px;color:rgba(248,246,240,0.35);font-family:Arial,sans-serif;">Hire fee only applies if the candidate stays 90 days. Better than public. Locked if you book before ${esc(offerExpiry)}.</p>
      </td></tr>
    </table>

    <p style="margin:0 0 24px;font-size:15px;line-height:1.65;color:rgba(248,246,240,0.75);font-family:Arial,sans-serif;">
      Book your demo before ${esc(offerExpiry)} and this rate is yours. After that, public pricing applies.
    </p>

    <table cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr><td style="background:#c8a96e;border-radius:10px;">
        <a href="${CALENDLY_REENGAGEMENT_URL}" style="display:inline-block;padding:15px 32px;color:#0a0a0a;text-decoration:none;font-family:Arial,sans-serif;font-weight:700;font-size:15px;letter-spacing:0.02em;">Book your demo &rarr;</a>
      </td></tr>
    </table>

    <p style="margin:0;font-size:13px;line-height:1.65;color:rgba(248,246,240,0.45);font-family:Arial,sans-serif;">
      Just reply if you have questions — comes straight to me.<br><br>
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

  const now = new Date();

  // Only fire on or after launch day
  if (now < LAUNCH_DATE) {
    console.log('[eoi-reengagement] Not launch day yet — skipping');
    return res.status(200).json({ ok: true, skipped: 'not_launch_day_yet' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Load EOIs that:
  // - Submitted before EOI window closed (15 July)
  // - Never booked a demo
  // - Not opted out
  // - Haven't already received this email
  const { data: eois, error } = await supabase
    .from('eoi_submissions')
    .select('id, venue_name, contact_name, email, created_at')
    .lt('created_at', EOI_WINDOW_CLOSE.toISOString())
    .is('calendly_booking_at', null)
    .not('email_opt_out', 'is', true)
    .is('reengagement_sent_at', null)
    .order('created_at', { ascending: true });

  if (error) {
    return res.status(500).json({ error: `Supabase query failed: ${error.message}` });
  }

  const nowIso = now.toISOString();
  const offerExpiry = new Date(now.getTime() + OFFER_EXPIRY_HOURS * 3600000)
    .toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', timeZone: 'Australia/Sydney' });

  const results = [];

  for (const eoi of eois || []) {
    const firstName = eoi.contact_name?.split(' ')[0] || eoi.contact_name || 'there';
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'Anders at Trial. <hello@hiretrial.com.au>',
          to: eoi.email,
          reply_to: 'anders@hiretrial.com.au',
          subject: `We just went live — and we've kept a spot for you`,
          html: buildReengagementHtml(firstName, eoi.venue_name, offerExpiry),
          tags: [{ name: 'category', value: 'eoi-reengagement' }],
        }),
      });

      await supabase.from('eoi_submissions')
        .update({ reengagement_sent_at: nowIso })
        .eq('id', eoi.id);

      results.push({ id: eoi.id, venue: eoi.venue_name, sent: true });
      console.log(`[eoi-reengagement] Sent to ${eoi.email}`);
    } catch (e: any) {
      results.push({ id: eoi.id, venue: eoi.venue_name, error: e.message });
    }
  }

  return res.status(200).json({ ok: true, processed: results.length, results });
}
