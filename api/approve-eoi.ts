// ═══════════════════════════════════════════════════════════════════
// api/approve-eoi.ts
//
// Vercel API route. Called by TrialHQ when operator clicks
// "Approve & dispatch" in the EOI approval modal.
//
// Body: { eoi_id: string, plan_size: 'solo'|'starter'|'growth'|'enterprise',
//         is_founding_partner: boolean }
//
// Flow:
//   1. Verify caller is_trial_operator (Bearer JWT in Authorization header)
//   2. Fetch the EOI row
//   3. Create paired accounts + venues rows (status='onboarding')
//   4. Generate unique slug + 32-char setup token + inbound forwarding address
//   5. Mark EOI converted with venue_id link
//   6. Send branded Resend welcome email with setup.html?token=... link
//   7. Return { ok, email_sent_to, venue_id, account_id, slug, inbound }
//
// Env vars required (set in Vercel dashboard — same vars eoi-submit.ts uses):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   RESEND_API_KEY
//   PUBLIC_SITE_URL           (optional — defaults to https://hiretrial.com.au)
// ═══════════════════════════════════════════════════════════════════

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

// ─── Config ───────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const PUBLIC_SITE_URL = process.env.PUBLIC_SITE_URL || 'https://hiretrial.com.au';

const FROM_EMAIL = 'Trial. <hello@hiretrial.com.au>';
const REPLY_TO_EMAIL = 'hello@hiretrial.com.au';

const VALID_PLANS = ['solo', 'starter', 'growth', 'enterprise'] as const;
type PlanSize = typeof VALID_PLANS[number];

// Default declared_venue_count per plan — venue can update later in dashboard.
const DEFAULT_VENUE_COUNT: Record<PlanSize, number> = {
  solo: 1,
  starter: 2,
  growth: 4,
  enterprise: 6,
};

const PLAN_LABELS: Record<PlanSize, string> = {
  solo: 'Solo',
  starter: 'Starter',
  growth: 'Growth',
  enterprise: 'Enterprise',
};

// Pricing — matches PRICING const in hq.html modal (single source of truth lives there).
const PRICING: Record<'founding' | 'standard', Record<PlanSize, { monthly: number | null; perHire: number | null }>> = {
  founding: {
    solo: { monthly: 99.99, perHire: 99 },
    starter: { monthly: 199.00, perHire: 89 },
    growth: { monthly: 349.00, perHire: 79 },
    enterprise: { monthly: null, perHire: null },
  },
  standard: {
    solo: { monthly: 129.99, perHire: 79 },
    starter: { monthly: 249.00, perHire: 99 },
    growth: { monthly: 499.00, perHire: 135 },
    enterprise: { monthly: null, perHire: null },
  },
};

// ─── HTML escape helper ───────────────────────────────────────────
function esc(s: string | null | undefined): string {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Setup token generation (32-char hex) ─────────────────────────
function generateToken(): string {
  const arr = new Uint8Array(16);
  // @ts-ignore — crypto is available in Vercel's Node runtime (Node 18+)
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ─── Slug generation: lowercase + hyphenated, no special chars ────
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-')
    .substring(0, 48);
}

// ─── Generate a slug that doesn't collide with existing venues ────
// Note: admin typed as `any` to avoid TS choking on the inferred
// SupabaseClient generic when passed across module boundaries.
async function generateUniqueSlug(
  admin: any,
  name: string
): Promise<string> {
  const base = slugify(name) || 'venue';
  let candidate = base;
  let suffix = 2;
  for (let i = 0; i < 50; i++) {
    const { data, error } = await admin
      .from('venues')
      .select('id')
      .eq('slug', candidate)
      .maybeSingle();
    if (error) throw new Error(`Slug check failed: ${error.message}`);
    if (!data) return candidate;
    candidate = `${base}-${suffix++}`;
  }
  throw new Error('Could not generate unique slug after 50 attempts');
}

// ─── Format AUD price for email copy ─────────────────────────────
function fmtAud(n: number | null): string {
  if (n === null) return 'Custom';
  return `$${n.toLocaleString('en-AU', { minimumFractionDigits: n % 1 === 0 ? 0 : 2 })}`;
}

// ─── Verify caller is is_trial_operator ───────────────────────────
type OperatorAuthResult =
  | { ok: true; userId: string; error?: undefined }
  | { ok: false; userId?: undefined; error: string };

async function verifyOperator(
  authHeader: string | undefined
): Promise<OperatorAuthResult> {
  if (!authHeader) return { ok: false, error: 'Missing Authorization header' };
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return { ok: false, error: 'Empty bearer token' };

  // Validate the JWT and get the user
  const userClient = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);
  const { data: { user }, error: uErr } = await userClient.auth.getUser(token);
  if (uErr || !user) return { ok: false, error: 'Invalid token' };

  // Service-role lookup of is_trial_operator flag
  const admin = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);
  const { data: row, error: rErr } = await admin
    .from('users')
    .select('id, is_trial_operator')
    .eq('id', user.id)
    .maybeSingle();
  if (rErr || !row) return { ok: false, error: 'User row not found' };
  if (!row.is_trial_operator) return { ok: false, error: 'Not authorised — operator only' };

  return { ok: true, userId: user.id };
}

// ═══════════════════════════════════════════════════════════════════
// Branded welcome email — matches hiretrial.com.au customer-facing brand
// (gold #c8a96e on near-black #0a0a0a, Cormorant Garamond + Inter Tight)
// ═══════════════════════════════════════════════════════════════════
async function sendWelcomeEmail(opts: {
  to: string;
  contactName: string;
  venueName: string;
  planSize: PlanSize;
  isFounding: boolean;
  setupUrl: string;
}): Promise<{ ok: boolean; error?: string }> {
  if (!RESEND_API_KEY) {
    return { ok: false, error: 'RESEND_API_KEY missing' };
  }

  const { to, contactName, venueName, planSize, isFounding, setupUrl } = opts;
  const phase = isFounding ? 'founding' : 'standard';
  const price = PRICING[phase][planSize];
  const planLabel = PLAN_LABELS[planSize];
  const firstName = contactName.trim().split(/\s+/)[0] || 'there';

  const subject = `${venueName} is approved for Trial. — set up takes ~3 minutes`;

  // Pricing line (skip if enterprise/null)
  const priceLine =
    price.monthly !== null && price.perHire !== null
      ? `${fmtAud(price.monthly)} + GST per month · ${fmtAud(price.perHire)} + GST per retained hire`
      : "Custom pricing — we'll be in touch separately to walk through enterprise terms";

  // Plain-text fallback
  const textBody = [
    `${firstName}, ${venueName} is approved for Trial.`,
    ``,
    `You're on the ${planLabel} plan${isFounding ? ' as a Founding Partner' : ''}.`,
    `${priceLine}`,
    isFounding ? `\nFounding Partner pricing is locked for life — regardless of future rate changes.\n` : '',
    `Setup takes about 3 minutes — confirm your details, choose how candidates reach you, and we'll spin up your dashboard.`,
    ``,
    `Complete setup:`,
    `${setupUrl}`,
    ``,
    `Got questions? Reply to this email — it goes straight to me.`,
    ``,
    `— Anders, founder`,
    `Trial. · ABN 71 441 417 792 · Sydney`,
    `hiretrial.com.au`,
  ].join('\n');

  // ═══ Branded HTML — matches hiretrial.com.au styling ═══
  const htmlBody = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:'Inter Tight',system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#f8f6f0;-webkit-font-smoothing:antialiased;">

<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:#0a0a0a;opacity:0;">
  ${esc(venueName)} is approved for Trial. Setup takes about 3 minutes.
</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0a0a0a;padding:40px 16px;">
  <tr>
    <td align="center">

      <table role="presentation" width="720" cellpadding="0" cellspacing="0" border="0" style="max-width:720px;background:#131313;border:1px solid rgba(248,246,240,0.08);border-radius:4px;">

        <tr>
          <td style="padding:40px 40px 24px 40px;border-bottom:1px solid rgba(248,246,240,0.08);">
            <span style="font-family:'Cormorant Garamond',Georgia,'Times New Roman',serif;font-weight:600;font-size:26px;letter-spacing:-0.02em;color:#f8f6f0;">Trial</span><span style="font-family:'Cormorant Garamond',Georgia,'Times New Roman',serif;font-weight:600;font-size:30px;color:#c8a96e;">.</span>
          </td>
        </tr>

        <tr>
          <td style="padding:36px 40px 8px 40px;">
            <div style="font-size:11px;letter-spacing:0.22em;text-transform:uppercase;color:#c8a96e;font-weight:500;">
              Approved &middot; Ready to set up
            </div>
          </td>
        </tr>
        <tr>
          <td style="padding:0 40px 32px 40px;">
            <h1 style="margin:0;font-family:'Cormorant Garamond',Georgia,'Times New Roman',serif;font-weight:500;font-size:42px;line-height:1.15;letter-spacing:-0.01em;color:#f8f6f0;">
              ${esc(firstName)}, ${esc(venueName)} is in.
            </h1>
            <div style="margin-top:16px;font-size:17px;line-height:1.6;color:rgba(248,246,240,0.78);">
              Thanks for your interest in Trial. We've reviewed your venue and you're approved on the <strong style="color:#f8f6f0;">${esc(planLabel)}</strong> plan${isFounding ? ' as a <strong style="color:#c8a96e;">Founding Partner</strong>' : ''}.
            </div>
          </td>
        </tr>

        <tr>
          <td style="padding:0 40px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:rgba(200,169,110,0.06);border:1px solid rgba(200,169,110,0.18);border-radius:4px;">
              <tr>
                <td style="padding:22px 24px;">
                  <div style="font-size:10px;letter-spacing:0.22em;text-transform:uppercase;color:rgba(248,246,240,0.48);font-weight:500;margin-bottom:8px;">
                    Your plan
                  </div>
                  <div style="font-family:'Cormorant Garamond',Georgia,'Times New Roman',serif;font-weight:500;font-size:22px;color:#f8f6f0;margin-bottom:10px;letter-spacing:-0.01em;">
                    ${esc(planLabel)}${isFounding ? ' &middot; <span style="color:#c8a96e;">Founding Partner</span>' : ''}
                  </div>
                  <div style="font-size:13.5px;line-height:1.55;color:rgba(248,246,240,0.62);">
                    ${esc(priceLine)}
                  </div>
                  ${isFounding ? `<div style="margin-top:14px;padding-top:14px;border-top:1px solid rgba(200,169,110,0.18);font-size:12.5px;line-height:1.55;color:#c8a96e;font-style:italic;font-family:'Cormorant Garamond',Georgia,'Times New Roman',serif;">Locked for life &mdash; regardless of future rate changes.</div>` : ''}
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <tr>
          <td style="padding:32px 40px 0 40px;">
            <div style="font-size:11px;letter-spacing:0.22em;text-transform:uppercase;color:#c8a96e;font-weight:500;margin-bottom:14px;">
              Next: 3-minute setup
            </div>
            <div style="font-size:16px;line-height:1.65;color:rgba(248,246,240,0.78);">
              You'll confirm a few details, choose how candidates reach you, and we'll spin up your venue's dashboard and your private forwarding inbox.
            </div>
          </td>
        </tr>

        <tr>
          <td style="padding:32px 40px 0 40px;" align="left">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="background:#c8a96e;border-radius:2px;">
                  <a href="${esc(setupUrl)}"
                     style="display:inline-block;padding:14px 28px;font-family:'Inter Tight',system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;font-weight:500;letter-spacing:0.08em;text-transform:uppercase;color:#0a0a0a;text-decoration:none;">
                    Complete setup &rarr;
                  </a>
                </td>
              </tr>
            </table>
            <div style="margin-top:14px;font-size:12px;color:rgba(248,246,240,0.48);letter-spacing:0.02em;">
              Or paste this into your browser:
            </div>
            <div style="margin-top:6px;font-family:'SF Mono',Monaco,Consolas,monospace;font-size:11.5px;color:#c8a96e;word-break:break-all;">
              ${esc(setupUrl)}
            </div>
          </td>
        </tr>

        <tr>
          <td style="padding:36px 40px 0 40px;">
            <div style="font-size:14px;line-height:1.65;color:rgba(248,246,240,0.72);">
              Got questions? Hit reply &mdash; this goes straight to me.
            </div>
            <div style="margin-top:6px;font-size:13px;color:rgba(248,246,240,0.48);font-style:italic;font-family:'Cormorant Garamond',Georgia,'Times New Roman',serif;">
              &mdash; Anders, founder
            </div>
          </td>
        </tr>

        <tr>
          <td style="padding:48px 40px 40px 40px;border-top:1px solid rgba(248,246,240,0.08);margin-top:40px;">
            <div style="font-family:'Cormorant Garamond',Georgia,'Times New Roman',serif;font-weight:600;font-size:18px;color:#f8f6f0;">Trial<span style="color:#c8a96e;font-size:20px;">.</span></div>
            <div style="margin-top:8px;font-size:11px;letter-spacing:0.08em;color:rgba(248,246,240,0.28);">
              Hospitality hiring, built by operators.
            </div>
            <div style="margin-top:18px;font-size:11px;letter-spacing:0.06em;color:rgba(248,246,240,0.28);">
              ABN 71 441 417 792 &middot; Sydney, Australia &middot; <a href="https://hiretrial.com.au" style="color:#c8a96e;text-decoration:none;">hiretrial.com.au</a>
            </div>
          </td>
        </tr>

      </table>

    </td>
  </tr>
</table>

</body>
</html>`;

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [to],
        reply_to: REPLY_TO_EMAIL,
        subject,
        text: textBody,
        html: htmlBody,
        tags: [
          { name: 'category', value: 'approve-eoi-welcome' },
          { name: 'plan', value: planSize },
          { name: 'phase', value: phase },
        ],
      }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      return { ok: false, error: `Resend ${resp.status}: ${body.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: `Resend fetch failed: ${e?.message || 'unknown'}` };
  }
}

// ═══════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════════
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS — TrialHQ calls this from hq.hiretrial.com.au
  res.setHeader('Access-Control-Allow-Origin', 'https://hq.hiretrial.com.au');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  // Env sanity
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[approve-eoi] Missing SUPABASE env vars');
    return res.status(500).json({ ok: false, error: 'Server misconfiguration' });
  }

  // ── 1. Auth ────────────────────────────────────────────────────────
  const authResult = await verifyOperator(req.headers.authorization);
  if (authResult.ok === false) {
    const errMsg = authResult.error;
    console.warn('[approve-eoi] Auth failed:', errMsg);
    return res.status(401).json({ ok: false, error: errMsg });
  }

  // ── 2. Parse + validate body ──────────────────────────────────────
  const body = req.body || {};
  const { eoi_id, plan_size, is_founding_partner } = body;

  if (!eoi_id || typeof eoi_id !== 'string') {
    return res.status(400).json({ ok: false, error: 'eoi_id required' });
  }
  if (!plan_size || !VALID_PLANS.includes(plan_size)) {
    return res.status(400).json({ ok: false, error: 'plan_size must be solo|starter|growth|enterprise' });
  }
  if (typeof is_founding_partner !== 'boolean') {
    return res.status(400).json({ ok: false, error: 'is_founding_partner must be boolean' });
  }

  // ── 3. Service-role client (bypasses RLS for backend ops) ─────────
  const admin: any = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // ── 4. Fetch the EOI ──────────────────────────────────────────────
  const { data: eoi, error: eoiErr } = await admin
    .from('eoi_submissions')
    .select('*')
    .eq('id', eoi_id)
    .maybeSingle();

  if (eoiErr) {
    console.error('[approve-eoi] EOI lookup failed:', eoiErr);
    return res.status(500).json({ ok: false, error: `EOI lookup failed: ${eoiErr.message}` });
  }
  if (!eoi) return res.status(404).json({ ok: false, error: 'EOI not found' });
  if (eoi.status === 'converted') {
    return res.status(409).json({ ok: false, error: `EOI already converted (venue_id: ${eoi.venue_id})` });
  }
  if (eoi.status === 'declined') {
    return res.status(409).json({ ok: false, error: 'Cannot approve a declined EOI' });
  }

  // ── 5. Generate unique slug + setup token ────────────────────────
  let slug: string;
  try {
    slug = await generateUniqueSlug(admin, eoi.venue_name);
  } catch (e: any) {
    console.error('[approve-eoi] Slug gen failed:', e?.message);
    return res.status(500).json({ ok: false, error: `Slug gen failed: ${e?.message}` });
  }

  const setupToken = generateToken();
  const inboundAddress = `${slug}@inbound.hiretrial.com.au`;

  // ── 6. Create account row first (venues has account_id FK) ───────
  const { data: account, error: accErr } = await admin
    .from('accounts')
    .insert({
      business_name: eoi.venue_name,
      billing_email: eoi.email,
      billing_contact_name: eoi.contact_name,
      phone: eoi.phone,
      subscription_phase: is_founding_partner ? 'founding' : 'standard',
      subscription_tier: plan_size,
      subscription_cycle: 'monthly', // annual unlocks at 6mo
      declared_venue_count: DEFAULT_VENUE_COUNT[plan_size as PlanSize] || 1,
      subscription_status: 'pending_payment',
    })
    .select('id')
    .single();

  if (accErr || !account) {
    console.error('[approve-eoi] Account insert failed:', accErr);
    return res.status(500).json({ ok: false, error: `Account insert failed: ${accErr?.message || 'unknown'}` });
  }

  // ── 7. Create venue row ──────────────────────────────────────────
  const { data: venue, error: vErr } = await admin
    .from('venues')
    .insert({
      account_id: account.id,
      name: eoi.venue_name,
      slug: slug,
      inbound_address: inboundAddress,
      status: 'onboarding',
      plan_size: plan_size,
      is_founding_partner: is_founding_partner,
      founding_locked_at: is_founding_partner ? new Date().toISOString() : null,
      contact_email: eoi.email,
      contact_phone: eoi.phone,
      manager_email: eoi.email,
      manager_name: eoi.contact_name,
      setup_token: setupToken,
      setup_dispatched_at: new Date().toISOString(),
    })
    .select('id, slug, inbound_address')
    .single();

  if (vErr || !venue) {
    // Roll back the account we just created so we don't leave orphans
    await admin.from('accounts').delete().eq('id', account.id);
    console.error('[approve-eoi] Venue insert failed, rolled back account:', vErr);
    return res.status(500).json({ ok: false, error: `Venue insert failed: ${vErr?.message || 'unknown'}` });
  }

  // ── 8. Update EOI → converted ────────────────────────────────────
  const { error: updErr } = await admin
    .from('eoi_submissions')
    .update({
      status: 'converted',
      venue_id: venue.id,
      converted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', eoi_id);

  if (updErr) {
    // Don't roll back — venue exists, just log for manual reconciliation
    console.error(`[approve-eoi] EOI update failed but venue created (venue_id: ${venue.id}): ${updErr.message}`);
  }

  // ── 9. Send branded welcome email ────────────────────────────────
  const setupUrl = `${PUBLIC_SITE_URL}/setup.html?token=${setupToken}`;
  const emailResult = await sendWelcomeEmail({
    to: eoi.email,
    contactName: eoi.contact_name,
    venueName: eoi.venue_name,
    planSize: plan_size as PlanSize,
    isFounding: is_founding_partner,
    setupUrl,
  });

  if (!emailResult.ok) {
    // Email failed but rows exist — return success with warning
    console.warn(`[approve-eoi] Email failed for venue ${venue.id}: ${emailResult.error}`);
    return res.status(200).json({
      ok: true,
      email_sent_to: null,
      venue_id: venue.id,
      account_id: account.id,
      slug: venue.slug,
      inbound: venue.inbound_address,
      warning: `Email failed: ${emailResult.error}. Venue created — resend manually from TrialHQ.`,
    });
  }

  console.log(`[approve-eoi] ✅ ${eoi.venue_name} → venue ${venue.id} · email sent to ${eoi.email}`);

  return res.status(200).json({
    ok: true,
    email_sent_to: eoi.email,
    venue_id: venue.id,
    account_id: account.id,
    slug: venue.slug,
    inbound: venue.inbound_address,
  });
}
