// ═══════════════════════════════════════════════════════════════════
// api/stripe-webhook.ts
//
// Vercel API route. Receives Stripe webhook events and logs them to
// the subscription_events table so HQ's Revenue tab can show real MRR
// instead of stub data.
//
// Trial.'s billing model (per Legal Suite v2.4):
//   • Subscription Fees (monthly) = off-session auto-charge via Stripe
//     Subscription. Authorised by clause 6.
//   • Success Fees ($99/retained hire) = Stripe Invoice with payment
//     link, manually paid by venue. NOT off-session. Per clause 7.2.
//
// Events handled (3, minimum viable for tonight):
//   1. checkout.session.completed
//      → Initial setup payment confirmed. Venue goes onboarding → active.
//      → Logs 'subscription_started' to subscription_events.
//
//   2. invoice.paid
//      → Money landed. Distinguishes by invoice.subscription:
//        • set     → 'subscription_renewed' (monthly auto-charge)
//        • null    → 'success_fee_paid'     (one-off Success Fee invoice)
//      → For success fees: stamps outcomes row with stripe_charge_id,
//        stripe_charge_status='paid', charge_amount. Matched on
//        stripe_invoice_id written to outcomes at day-120 charge fire.
//
//   3. invoice.payment_failed
//      → Charge failed. Logs 'payment_failed'. For subscription
//        invoices, flips account.subscription_status to 'past_due'.
//        Suspension/termination policy (7d/30d per clause 6) lives in
//        a separate scheduled job — webhook records, doesn't punish.
//
// Security:
//   • Signature verification via STRIPE_WEBHOOK_SECRET (mandatory).
//   • Raw body required for sig verify — Vercel bodyParser disabled.
//   • Idempotent: upsert on stripe_event_id so Stripe retries don't
//     double-log.
//
// Env vars required (set in Vercel dashboard):
//   STRIPE_SECRET_KEY_LIVE       (existing, live mode)
//   STRIPE_WEBHOOK_SECRET        (NEW — set after creating webhook in Stripe)
//   SUPABASE_URL                 (existing)
//   SUPABASE_SERVICE_ROLE_KEY    (existing)
// ═══════════════════════════════════════════════════════════════════

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

// ─── CRITICAL: Disable Vercel's automatic body parsing ────────────
// Stripe signature verification needs the raw, unmodified body bytes.
// If Vercel parses the JSON for us, the signature won't match.
export const config = {
  api: {
    bodyParser: false,
  },
};

// ─── Config ───────────────────────────────────────────────────────
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY_LIVE;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

const stripe = STRIPE_SECRET_KEY
  ? new Stripe(STRIPE_SECRET_KEY)
  : null;

// ─── Helper: read raw body as Buffer (needed for sig verify) ──────
async function readRawBody(req: VercelRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ─── Helper: idempotent log into subscription_events ──────────────
// Upsert keyed by stripe_event_id so Stripe retrying the same event
// (which it does aggressively) doesn't create duplicate rows.
//
// Schema mapping (matches your actual subscription_events table):
//   event_type              → 'subscription_started' | 'subscription_renewed'
//                             | 'success_fee_paid' | 'payment_failed'
//   stripe_event_id         → event.id (unique key for idempotency)
//   stripe_invoice_id       → invoice.id (for invoice events)
//   stripe_payment_intent_id→ invoice.payment_intent (for renewals/fails)
//   amount_cents            → amount paid or due, in cents
//   currency                → 'aud'
//   venue_id, account_id    → resolved from stripe_customer_id
//   metadata                → full Stripe event blob for forensics
async function logEvent(
  admin: any,
  payload: {
    stripe_event_id: string;
    event_type: string;
    venue_id: string | null;
    account_id: string | null;
    amount_cents: number | null;
    currency: string | null;
    stripe_invoice_id: string | null;
    stripe_payment_intent_id: string | null;
    metadata: Stripe.Event;
  }
): Promise<{ ok: boolean; error?: string }> {
  const { error } = await admin
    .from('subscription_events')
    .upsert(
      {
        stripe_event_id: payload.stripe_event_id,
        event_type: payload.event_type,
        venue_id: payload.venue_id,
        account_id: payload.account_id,
        amount_cents: payload.amount_cents,
        currency: payload.currency,
        stripe_invoice_id: payload.stripe_invoice_id,
        stripe_payment_intent_id: payload.stripe_payment_intent_id,
        metadata: payload.metadata as any,
        created_at: new Date().toISOString(),
      },
      { onConflict: 'stripe_event_id' }
    );
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

// ─── Helper: logEvent + surface failures ──────────────────────────
// logEvent never throws (Supabase returns errors, doesn't throw), so a
// failed insert would otherwise pass silently and the handler would
// still 200 — leaving subscription_events empty with no trail. This
// wrapper console.errors the failure with full context so a silent
// insert rejection (RLS change, schema drift) is visible in Vercel logs.
async function logEventChecked(
  admin: any,
  payload: Parameters<typeof logEvent>[1],
  ctx: { eventId: string; eventType: string }
): Promise<void> {
  const result = await logEvent(admin, payload);
  if (!result.ok) {
    console.error(
      `[stripe-webhook] logEvent FAILED for ${ctx.eventType} (${ctx.eventId}) ` +
      `→ event_type='${payload.event_type}': ${result.error}`
    );
  }
}

// ─── Helper: find venue + account from a Stripe customer ID ───────
// Subscription/checkout events reference stripe_customer_id. We map
// that back to our internal account_id and venue_id for logging.
async function resolveCustomer(
  admin: any,
  stripeCustomerId: string | null
): Promise<{ account_id: string | null; venue_id: string | null }> {
  if (!stripeCustomerId) return { account_id: null, venue_id: null };

  const { data: account } = await admin
    .from('accounts')
    .select('id')
    .eq('stripe_customer_id', stripeCustomerId)
    .maybeSingle();

  if (!account) return { account_id: null, venue_id: null };

  // Grab the first venue for this account. Solo plan = 1 venue;
  // Starter/Growth can have multiple — first one is fine for the
  // event log, real attribution lives in account_id.
  const { data: venue } = await admin
    .from('venues')
    .select('id')
    .eq('account_id', account.id)
    .limit(1)
    .maybeSingle();

  return {
    account_id: account.id,
    venue_id: venue?.id || null,
  };
}

// ─── Helper: extract a string ID from a Stripe expandable field ───
function asString(v: string | { id: string } | null | undefined): string | null {
  if (!v) return null;
  if (typeof v === 'string') return v;
  return v.id || null;
}

// ═══════════════════════════════════════════════════════════════════
// HANDLER
// ═══════════════════════════════════════════════════════════════════
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Only POST. Stripe always uses POST.
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  // Env sanity
  if (!stripe || !STRIPE_WEBHOOK_SECRET || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[stripe-webhook] Missing env vars');
    return res.status(500).json({ ok: false, error: 'Server misconfiguration' });
  }

  // ── 1. Read raw body + verify signature ────────────────────────
  let rawBody: Buffer;
  try {
    rawBody = await readRawBody(req);
  } catch (e: any) {
    console.error('[stripe-webhook] Failed to read body:', e?.message);
    return res.status(400).json({ ok: false, error: 'Failed to read request body' });
  }

  const sig = req.headers['stripe-signature'];
  if (!sig || typeof sig !== 'string') {
    console.warn('[stripe-webhook] Missing stripe-signature header');
    return res.status(400).json({ ok: false, error: 'Missing signature' });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET);
  } catch (e: any) {
    console.warn('[stripe-webhook] Signature verification failed:', e?.message);
    return res.status(400).json({ ok: false, error: `Signature verification failed: ${e?.message}` });
  }

  // ── 2. Service-role client ─────────────────────────────────────
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  console.log(`[stripe-webhook] Received ${event.type} · event_id ${event.id}`);

  // ── 3. Route by event type ─────────────────────────────────────
  try {
    switch (event.type) {

      // ═══ checkout.session.completed ═══════════════════════════
      // Fires when a venue completes the initial Stripe Checkout (the
      // setup payment from post-EOI-approval). This is the moment the
      // subscription is created and the venue can be moved to active.
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const customerId = asString(session.customer);
        const subscriptionId = asString(session.subscription);

        const { account_id, venue_id } = await resolveCustomer(admin, customerId);

        // Log regardless of whether we matched a venue — worst case
        // it's an orphan we reconcile manually from the dashboard.
        await logEventChecked(admin, {
          stripe_event_id: event.id,
          event_type: 'subscription_started',
          venue_id,
          account_id,
          amount_cents: session.amount_total ?? null,
          currency: session.currency ?? null,
          stripe_invoice_id: asString(session.invoice),
          stripe_payment_intent_id: asString(session.payment_intent),
          metadata: event,
        }, { eventId: event.id, eventType: event.type });

        // Promote venue to active. Idempotent: only flips if currently
        // 'onboarding', so re-running this event won't unset later
        // status changes (e.g. paused, cancelled).
        if (venue_id) {
          await admin
            .from('venues')
            .update({
              status: 'active',
              activated_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq('id', venue_id)
            .eq('status', 'onboarding');
        }

        // Save the subscription_id on the account so future invoice
        // events can be tied back without an extra Stripe API call.
        if (account_id && subscriptionId) {
          await admin
            .from('accounts')
            .update({
              stripe_subscription_id: subscriptionId,
              subscription_status: 'active',
              subscription_started_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq('id', account_id);
        }

        // Send the post-payment welcome email. Idempotent + failure-isolated:
        // never throws, won't double-send on a Stripe retry, and a failure
        // here does not affect the 200 ACK below.
        await sendWelcomeEmail(admin, venue_id, { eventId: event.id });

        break;
      }

      // ═══ invoice.paid ════════════════════════════════════════
      // Fires for BOTH:
      //   (a) Monthly subscription renewals — invoice.subscription set
      //   (b) One-off Success Fee invoices — invoice.subscription null
      // We distinguish and log differently. Outcomes table update for
      // success-fee path is deferred until day-120 invoice flow is
      // built (no stripe_invoice_id column on outcomes yet — see
      // tonight's check).
      case 'invoice.paid': {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = asString(invoice.customer);
        const { account_id, venue_id } = await resolveCustomer(admin, customerId);
        const isSubscriptionInvoice = !!invoice.subscription;

        const eventType = isSubscriptionInvoice
          ? 'subscription_renewed'
          : 'success_fee_paid';

        await logEventChecked(admin, {
          stripe_event_id: event.id,
          event_type: eventType,
          venue_id,
          account_id,
          amount_cents: invoice.amount_paid ?? null,
          currency: invoice.currency ?? null,
          stripe_invoice_id: invoice.id || null,
          stripe_payment_intent_id: asString(invoice.payment_intent),
          metadata: event,
        }, { eventId: event.id, eventType: event.type });

        // For subscription renewals, ensure account stays in 'active'
        // state (clears any prior 'past_due' if dunning recovered).
        if (isSubscriptionInvoice && account_id) {
          await admin
            .from('accounts')
            .update({
              subscription_status: 'active',
              updated_at: new Date().toISOString(),
            })
            .eq('id', account_id)
            .in('subscription_status', ['past_due', 'active']); // safe set
        }

        // For success fee invoices (per-hire $99 charge), stamp the
        // matching outcome row as paid. We match on stripe_invoice_id
        // which is written to outcomes when the day-120 charge fires.
        // If no match is found we log it — reconcile manually from
        // the Stripe dashboard.
        if (!isSubscriptionInvoice) {
          const invoiceId = invoice.id || null;
          if (invoiceId) {
            const { data: outcome, error: oErr } = await admin
              .from('outcomes')
              .select('id')
              .eq('stripe_invoice_id', invoiceId)
              .maybeSingle();

            if (oErr) {
              console.error(`[stripe-webhook] outcomes lookup failed for invoice ${invoiceId}: ${oErr.message}`);
            } else if (outcome) {
              const { error: updateErr } = await admin
                .from('outcomes')
                .update({
                  stripe_charge_id: asString(invoice.payment_intent),
                  stripe_charge_status: 'paid',
                  charge_amount: Math.round((invoice.amount_paid ?? 9900) / 100),
                  updated_at: new Date().toISOString(),
                })
                .eq('id', outcome.id);

              if (updateErr) {
                console.error(`[stripe-webhook] outcomes update failed for invoice ${invoiceId}: ${updateErr.message}`);
              } else {
                console.log(`[stripe-webhook] outcome ${outcome.id} marked paid · invoice ${invoiceId}`);
              }
            } else {
              // No matching outcome — log for manual reconciliation
              console.warn(`[stripe-webhook] success_fee_paid: no outcome found for stripe_invoice_id ${invoiceId} · venue_id ${venue_id}`);
            }
          }
        }

        break;
      }

      // ═══ invoice.payment_failed ══════════════════════════════
      // Charge didn't go through. Could be a subscription renewal OR
      // a Success Fee invoice. Either way: log it.
      // For subscription invoices, flip account → 'past_due'.
      // Suspension at 7d / termination at 30d per clause 6 is a
      // separate scheduled job — webhook records, doesn't punish.
      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = asString(invoice.customer);
        const { account_id, venue_id } = await resolveCustomer(admin, customerId);

        await logEventChecked(admin, {
          stripe_event_id: event.id,
          event_type: 'payment_failed',
          venue_id,
          account_id,
          amount_cents: invoice.amount_due ?? null,
          currency: invoice.currency ?? null,
          stripe_invoice_id: invoice.id || null,
          stripe_payment_intent_id: asString(invoice.payment_intent),
          metadata: event,
        }, { eventId: event.id, eventType: event.type });

        // Only subscription-invoice failures put the account in
        // arrears. A failed one-off Success Fee invoice doesn't
        // taint the whole subscription.
        if (account_id && invoice.subscription) {
          await admin
            .from('accounts')
            .update({
              subscription_status: 'past_due',
              updated_at: new Date().toISOString(),
            })
            .eq('id', account_id);
        }

        break;
      }

      // ═══ Other events ═══════════════════════════════════════
      // Not subscribed to anything else yet. If Stripe sends an
      // unexpected event we 200 OK so it dequeues, but log it for
      // forensic visibility.
      default: {
        console.log(`[stripe-webhook] Unhandled event type: ${event.type}`);
        break;
      }
    }
  } catch (e: any) {
    // Don't 500 to Stripe — they'll retry aggressively and double-log.
    // Log the error and 200 OK so the event dequeues. We reconcile
    // from the Stripe dashboard if needed.
    console.error(
      `[stripe-webhook] Handler error for ${event.type} (${event.id}):`,
      e?.message,
      e?.stack
    );
    return res
      .status(200)
      .json({ ok: false, error: e?.message || 'Handler error', noted: true });
  }

  // ── 4. ACK ────────────────────────────────────────────────────
  return res.status(200).json({ ok: true, received: event.type, event_id: event.id });
}


// ═══════════════════════════════════════════════════════════════════
// WELCOME EMAIL (post-payment)
//
// Fires on checkout.session.completed — the moment payment confirms and
// the venue goes live. Distinct from the approve-eoi email (which is the
// pre-payment "you're approved, here's your setup link"). This one says
// "you're live, here's your one setup step + how it all works".
//
// Sent via the same Resend pattern as approve-eoi.ts (raw fetch, same
// from/reply-to). Idempotent: guarded on venues.welcome_email_sent_at so
// a Stripe retry of the same event can't double-send. Failure-isolated:
// a Resend or fetch error is logged and swallowed so the payment webhook
// still 200s — worst case the venue just doesn't get the welcome (logged
// for manual resend from TrialHQ), exactly like approve-eoi's fallback.
//
// Requires migration:
//   alter table venues add column if not exists welcome_email_sent_at timestamptz;
// ═══════════════════════════════════════════════════════════════════

const WELCOME_FROM_EMAIL = 'Trial. <hello@hiretrial.com.au>';
const WELCOME_REPLY_TO_EMAIL = 'hello@hiretrial.com.au';
const DASHBOARD_URL = 'https://dashboard.hiretrial.com.au';

// Plan label, mirroring approve-eoi.ts so the two emails agree.
const WELCOME_PLAN_LABELS: Record<string, string> = {
  solo: 'Solo',
  starter: 'Starter',
  growth: 'Growth',
  enterprise: 'Enterprise',
};

function welcomePlanLabel(phase: string | null, tier: string | null): string {
  const tierLabel = WELCOME_PLAN_LABELS[(tier || '').toLowerCase()] || (tier || 'Solo');
  const isFounding = (phase || 'founding') === 'founding';
  return isFounding ? `Founding Partner \u00b7 ${tierLabel}` : tierLabel;
}

const WELCOME_HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Welcome to Trial.</title></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#f8f6f0;-webkit-font-smoothing:antialiased;">
<!--
  ════════════════════════════════════════════════════════════════
  Trial. — Welcome email (fires on checkout.session.completed)
  Merge fields (set when dispatching via Resend):
    {{venue_name}}       e.g. "Hotel Sweeneys"
    {{contact_name}}     e.g. "Sarah"  (first name)
    {{inbound_address}}  e.g. "sweeneys@inbound.hiretrial.com.au"
    {{dashboard_url}}    e.g. "https://hq... or the venue dashboard URL"
    {{plan_label}}       e.g. "Founding Partner · Solo"
  ════════════════════════════════════════════════════════════════
-->
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#0a0a0a;padding:40px 20px;">
  <tr><td align="center">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" style="max-width:600px;">

      <!-- Wordmark -->
      <tr><td align="center" style="padding-bottom:36px;">
        <div style="font-family:Georgia,'Times New Roman',serif;font-weight:700;font-size:34px;letter-spacing:-0.5px;color:#f8f6f0;line-height:1;">
          Trial<span style="color:#c8a96e;font-size:40px;">.</span>
        </div>
      </td></tr>

      <!-- Hero -->
      <tr><td style="padding:0 8px 30px 8px;">
        <div style="font-size:11px;letter-spacing:0.24em;text-transform:uppercase;color:#c8a96e;font-weight:600;margin-bottom:14px;">
          You're live · {{plan_label}}
        </div>
        <h1 style="font-family:Georgia,'Times New Roman',serif;font-weight:700;font-size:32px;line-height:1.18;letter-spacing:-0.4px;color:#f8f6f0;margin:0 0 16px 0;">
          Welcome to Trial., {{contact_name}}.
        </h1>
        <p style="font-size:15.5px;line-height:1.65;color:rgba(248,246,240,0.78);margin:0;">
          {{venue_name}} is set up and ready. Your pricing is locked for the life of your subscription — that doesn't change as we grow. There's <strong style="color:#f8f6f0;font-weight:600;">one thing</strong> to do to start screening candidates, and it takes about two minutes. Everything after that is automatic.
        </p>
      </td></tr>

      <!-- THE ONE ACTION -->
      <tr><td style="padding:0 8px 14px 8px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:linear-gradient(135deg,rgba(200,169,110,0.10),rgba(200,169,110,0.04));border:1px solid rgba(200,169,110,0.32);border-radius:10px;">
          <tr><td style="padding:24px 24px 22px 24px;">
            <div style="font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:#c8a96e;font-weight:600;margin-bottom:10px;">The one setup step</div>
            <div style="font-family:Georgia,'Times New Roman',serif;font-weight:600;font-size:19px;color:#f8f6f0;line-height:1.3;margin-bottom:12px;">
              Point your job ads at your Trial. address
            </div>
            <p style="font-size:14.5px;line-height:1.6;color:rgba(248,246,240,0.74);margin:0 0 16px 0;">
              On Seek, Indeed, LinkedIn, or wherever you advertise, change the email that receives applications to your unique Trial. forwarding address below. From then on, every application lands with us first — we screen it, score it, and send the candidate straight into your dashboard. You don't change how you advertise or where you post.
            </p>
            <p style="font-size:13.5px;line-height:1.6;color:rgba(248,246,240,0.62);margin:0 0 16px 0;">
              And you still get every application in your own inbox — we forward the original on to you, untouched, exactly as you'd normally receive it. Nothing is intercepted or hidden. Trial. just adds the screened, scored version alongside it.
            </p>
            <div style="background:#0a0a0a;border:1px solid rgba(248,246,240,0.12);border-radius:8px;padding:14px 16px;text-align:center;">
              <div style="font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:rgba(248,246,240,0.42);font-weight:600;margin-bottom:6px;">Your forwarding address</div>
              <div style="font-family:'SF Mono',Monaco,Consolas,monospace;font-size:15px;color:#c8a96e;font-weight:500;word-break:break-all;">{{inbound_address}}</div>
            </div>
          </td></tr>
        </table>
      </td></tr>

      <!-- Dashboard button -->
      <tr><td align="center" style="padding:18px 8px 36px 8px;">
        <a href="{{dashboard_url}}" style="display:inline-block;padding:15px 38px;background:#c8a96e;color:#0a0a0a;font-family:Georgia,'Times New Roman',serif;font-size:16px;font-weight:600;letter-spacing:0.02em;text-decoration:none;border-radius:8px;">
          Open your dashboard
        </a>
        <div style="font-size:12px;color:rgba(248,246,240,0.42);margin-top:12px;">Bookmark it — it's where your scored candidates appear.</div>
      </td></tr>

      <!-- What happens next -->
      <tr><td style="padding:0 8px 10px 8px;border-top:1px solid rgba(248,246,240,0.08);padding-top:30px;">
        <div style="font-size:10px;letter-spacing:0.22em;text-transform:uppercase;color:#c8a96e;font-weight:600;margin-bottom:16px;">What happens next</div>
      </td></tr>
      <tr><td style="padding:0 8px 30px 8px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
          <tr><td style="padding:0 0 16px 0;vertical-align:top;width:34px;">
            <div style="width:26px;height:26px;border-radius:50%;background:rgba(200,169,110,0.12);color:#c8a96e;font-family:Georgia,serif;font-weight:700;font-size:13px;text-align:center;line-height:26px;">1</div>
          </td><td style="padding:0 0 16px 8px;">
            <div style="font-size:14.5px;color:#f8f6f0;font-weight:500;margin-bottom:2px;">An application arrives</div>
            <div style="font-size:13.5px;color:rgba(248,246,240,0.6);line-height:1.55;">A candidate applies through your job ad. It hits your Trial. address automatically — no action from you.</div>
          </td></tr>
          <tr><td style="padding:0 0 16px 0;vertical-align:top;width:34px;">
            <div style="width:26px;height:26px;border-radius:50%;background:rgba(200,169,110,0.12);color:#c8a96e;font-family:Georgia,serif;font-weight:700;font-size:13px;text-align:center;line-height:26px;">2</div>
          </td><td style="padding:0 0 16px 8px;">
            <div style="font-size:14.5px;color:#f8f6f0;font-weight:500;margin-bottom:2px;">We screen and score</div>
            <div style="font-size:13.5px;color:rgba(248,246,240,0.6);line-height:1.55;">The candidate completes a short, role-specific scenario assessment. Our AI scores it and writes a plain-English summary.</div>
          </td></tr>
          <tr><td style="padding:0 0 16px 0;vertical-align:top;width:34px;">
            <div style="width:26px;height:26px;border-radius:50%;background:rgba(200,169,110,0.12);color:#c8a96e;font-family:Georgia,serif;font-weight:700;font-size:13px;text-align:center;line-height:26px;">3</div>
          </td><td style="padding:0 0 16px 8px;">
            <div style="font-size:14.5px;color:#f8f6f0;font-weight:500;margin-bottom:2px;">You see ranked candidates — and their actual answers</div>
            <div style="font-size:13.5px;color:rgba(248,246,240,0.6);line-height:1.55;">Scored and ranked in your dashboard, with a plain-English summary. Open any candidate and you'll see every question they were asked and exactly how they answered it — not just a number. You decide who to interview and trial; Trial. never makes the call for you.</div>
          </td></tr>
          <tr><td style="padding:0 0 0 0;vertical-align:top;width:34px;">
            <div style="width:26px;height:26px;border-radius:50%;background:rgba(200,169,110,0.12);color:#c8a96e;font-family:Georgia,serif;font-weight:700;font-size:13px;text-align:center;line-height:26px;">4</div>
          </td><td style="padding:0 0 0 8px;">
            <div style="font-size:14.5px;color:#f8f6f0;font-weight:500;margin-bottom:2px;">You only pay when one sticks</div>
            <div style="font-size:13.5px;color:rgba(248,246,240,0.6);line-height:1.55;">Your monthly fee covers the platform. The per-hire fee only applies when a candidate you hired through Trial. stays 90 days. No retention, no fee.</div>
          </td></tr>
        </table>
      </td></tr>

      <!-- FAQs -->
      <tr><td style="padding:0 8px 10px 8px;border-top:1px solid rgba(248,246,240,0.08);padding-top:30px;">
        <div style="font-size:10px;letter-spacing:0.22em;text-transform:uppercase;color:#c8a96e;font-weight:600;margin-bottom:16px;">Quick answers</div>
      </td></tr>
      <tr><td style="padding:0 8px 30px 8px;">

        <div style="margin-bottom:18px;">
          <div style="font-size:14.5px;color:#f8f6f0;font-weight:600;margin-bottom:4px;">Do I have to change how I post jobs?</div>
          <div style="font-size:13.5px;color:rgba(248,246,240,0.65);line-height:1.55;">No. Post on the same platforms exactly as you do now. The only change is the address that receives applications — point it at your Trial. address above.</div>
        </div>

        <div style="margin-bottom:18px;">
          <div style="font-size:14.5px;color:#f8f6f0;font-weight:600;margin-bottom:4px;">Do I still get the application in my own inbox?</div>
          <div style="font-size:13.5px;color:rgba(248,246,240,0.65);line-height:1.55;">Yes — every time. We receive the application, pull what we need to send the assessment, then forward the original on to you, untouched, exactly as you'd normally get it. Nothing is intercepted or held back. You keep your usual inbox; Trial. just adds the screened candidate on top.</div>
        </div>

        <div style="margin-bottom:18px;">
          <div style="font-size:14.5px;color:#f8f6f0;font-weight:600;margin-bottom:4px;">Does the candidate know they're being assessed?</div>
          <div style="font-size:13.5px;color:rgba(248,246,240,0.65);line-height:1.55;">Yes. They're invited to complete a short scenario assessment and consent before starting. It's a fair, transparent step — not a hidden test.</div>
        </div>

        <div style="margin-bottom:18px;">
          <div style="font-size:14.5px;color:#f8f6f0;font-weight:600;margin-bottom:4px;">Do I see their actual answers, or just a score?</div>
          <div style="font-size:13.5px;color:rgba(248,246,240,0.65);line-height:1.55;">You see everything. Open any candidate and you'll find every question they were asked and their full written answer to each — alongside the score and summary. We even flag any answer that looks copy-pasted, so you can read with full context. The score helps you sort; the answers help you decide.</div>
        </div>

        <div style="margin-bottom:18px;">
          <div style="font-size:14.5px;color:#f8f6f0;font-weight:600;margin-bottom:4px;">What roles does Trial. cover?</div>
          <div style="font-size:13.5px;color:rgba(248,246,240,0.65);line-height:1.55;">Front-of-house roles — bartenders, baristas, floor staff, hosts, duty and venue managers, and more. Kitchen and back-of-house are coming in a later release.</div>
        </div>

        <div style="margin-bottom:18px;">
          <div style="font-size:14.5px;color:#f8f6f0;font-weight:600;margin-bottom:4px;">When exactly am I charged the per-hire fee?</div>
          <div style="font-size:13.5px;color:rgba(248,246,240,0.65);line-height:1.55;">Only when a candidate you hired through Trial. completes 90 days with you. We check in at the 90-day mark and confirm before anything is invoiced. If they don't stay, there's no fee.</div>
        </div>

        <div style="margin-bottom:0;">
          <div style="font-size:14.5px;color:#f8f6f0;font-weight:600;margin-bottom:4px;">Is the AI score the final decision?</div>
          <div style="font-size:13.5px;color:rgba(248,246,240,0.65);line-height:1.55;">Never. Scores and summaries are there to save you time reading CVs — the hiring decision is always yours. Trial. is built to protect your judgement, not replace it.</div>
        </div>

      </td></tr>

      <!-- Tips to get the most out of it -->
      <tr><td style="padding:0 8px 30px 8px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:rgba(255,255,255,0.03);border-left:2px solid #c8a96e;border-radius:6px;">
          <tr><td style="padding:18px 20px;">
            <div style="font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#c8a96e;font-weight:600;margin-bottom:10px;">Get the most out of it</div>
            <p style="font-size:13.5px;color:rgba(248,246,240,0.72);line-height:1.6;margin:0 0 10px 0;">
              <strong style="color:#f8f6f0;">Read their answers, not just the score.</strong> The number sorts your list — but opening a candidate to read how they actually answered (and the summary) is where the real signal is. Pasted answers are flagged so you know what you're reading.
            </p>
            <p style="font-size:13.5px;color:rgba(248,246,240,0.72);line-height:1.6;margin:0 0 10px 0;">
              <strong style="color:#f8f6f0;">Still trial them.</strong> Trial. gets the right people in front of you faster — a real trial shift is still the best final check.
            </p>
            <p style="font-size:13.5px;color:rgba(248,246,240,0.72);line-height:1.6;margin:0;">
              <strong style="color:#f8f6f0;">Reply to this email with anything.</strong> Genuinely — it comes straight to me.
            </p>
          </td></tr>
        </table>
      </td></tr>

      <!-- Personal sign-off -->
      <tr><td style="padding:0 8px 36px 8px;border-top:1px solid rgba(248,246,240,0.08);padding-top:28px;">
        <p style="font-size:14.5px;color:rgba(248,246,240,0.78);line-height:1.65;margin:0 0 14px 0;">
          You're one of the first venues on Trial., and that means a lot. If something's confusing or you want a hand setting up your job-ad forwarding, just reply — I answer every founding partner personally.
        </p>
        <div style="font-family:Georgia,'Times New Roman',serif;font-size:16px;color:#f8f6f0;font-weight:600;">Anders</div>
        <div style="font-size:12.5px;color:rgba(248,246,240,0.5);margin-top:2px;">Founder, Trial.</div>
      </td></tr>

      <!-- Footer -->
      <tr><td align="center" style="padding-top:24px;border-top:1px solid rgba(248,246,240,0.06);">
        <p style="font-size:11px;line-height:1.6;color:rgba(248,246,240,0.32);margin:0 0 6px 0;letter-spacing:0.02em;">
          Trial. is a hospitality hiring platform — <a href="https://hiretrial.com.au" style="color:rgba(248,246,240,0.42);text-decoration:none;">hiretrial.com.au</a>
        </p>
        <p style="font-size:11px;line-height:1.6;color:rgba(248,246,240,0.28);margin:0;">
          Operated by Anders Berggren · ABN 71 441 417 792 · Newcastle NSW<br>
          Questions: <a href="mailto:hello@hiretrial.com.au" style="color:rgba(248,246,240,0.38);text-decoration:none;">hello@hiretrial.com.au</a>
        </p>
        <p style="font-size:11px;line-height:1.6;color:rgba(248,246,240,0.18);margin:8px 0 0 0;">
          You received this because you signed up for Trial. &middot;
          <a href="{{unsubscribe_url}}" style="color:rgba(248,246,240,0.28);text-decoration:underline;">Unsubscribe</a>
        </p>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>
`;

const WELCOME_TEXT_TEMPLATE = `Welcome to Trial., {{contact_name}}.

You're live — {{plan_label}}. {{venue_name}} is set up and ready, and your
pricing is locked for the life of your subscription.

There's ONE thing to do to start screening candidates. It takes about two
minutes. Everything after that is automatic.

─────────────────────────────────────────────
THE ONE SETUP STEP — point your job ads at your Trial. address

On Seek, Indeed, LinkedIn, or wherever you advertise, change the email that
receives applications to your unique Trial. forwarding address:

    {{inbound_address}}

From then on, every application lands with us first — we screen it, score it,
and send the candidate straight into your dashboard. You don't change how or
where you post.

And you still get every application in your own inbox — we forward the original
on to you, untouched, exactly as you'd normally receive it. Nothing is
intercepted or hidden. Trial. just adds the screened version alongside it.

Open your dashboard: {{dashboard_url}}
(Bookmark it — it's where your scored candidates appear.)
─────────────────────────────────────────────

WHAT HAPPENS NEXT

1. An application arrives — it hits your Trial. address automatically.
2. We screen and score — the candidate completes a short, role-specific
   scenario assessment; our AI scores it and writes a plain-English summary.
3. You see ranked candidates AND their actual answers — scored and ranked in
   your dashboard with a plain-English summary. Open any candidate to see every
   question they were asked and exactly how they answered. You decide who to
   interview and trial. Trial. never makes the call for you.
4. You only pay when one sticks — your monthly fee covers the platform; the
   per-hire fee only applies when a candidate you hired stays 90 days.

QUICK ANSWERS

Do I have to change how I post jobs?
No. Same platforms, same process. Only the application-receiving address changes.

Do I still get the application in my own inbox?
Yes — every time. We receive it, pull what we need to send the assessment, then
forward the original on to you, untouched, exactly as you'd normally get it.
Nothing is intercepted. Trial. just adds the screened candidate on top.

Does the candidate know they're being assessed?
Yes — they're invited and consent before starting. Transparent, not hidden.

Do I see their actual answers, or just a score?
You see everything — every question and their full written answer to each,
alongside the score and summary. Pasted answers are flagged. The score sorts;
the answers decide.

What roles does Trial. cover?
Front-of-house — bartenders, baristas, floor staff, hosts, duty and venue
managers, and more. Back-of-house comes in a later release.

When am I charged the per-hire fee?
Only when a candidate you hired through Trial. completes 90 days. We confirm
with you first. No retention, no fee.

Is the AI score the final decision?
Never. It saves you time reading CVs — the hiring decision is always yours.

GET THE MOST OUT OF IT
- Read their answers, not just the score — open a candidate to see how they
  actually answered. Pasted answers are flagged.
- Still run a trial shift — it's the best final check.
- Reply to this email with anything. It comes straight to me.

You're one of the first venues on Trial., and that means a lot. If anything's
confusing or you want a hand setting up your job-ad forwarding, just reply — I
answer every founding partner personally.

Anders
Founder, Trial.

—
Trial. is a hospitality hiring platform — hiretrial.com.au
Operated by Anders Berggren · ABN 71 441 417 792 · Newcastle NSW
Questions: hello@hiretrial.com.au

You received this because you signed up for Trial.
To unsubscribe: {{unsubscribe_url}}
`;

function fillWelcomeTemplate(
  tpl: string,
  fields: { venue_name: string; contact_name: string; inbound_address: string; dashboard_url: string; plan_label: string; unsubscribe_url: string }
): string {
  return tpl
    .split('{{venue_name}}').join(fields.venue_name)
    .split('{{contact_name}}').join(fields.contact_name)
    .split('{{inbound_address}}').join(fields.inbound_address)
    .split('{{dashboard_url}}').join(fields.dashboard_url)
    .split('{{plan_label}}').join(fields.plan_label)
    .split('{{unsubscribe_url}}').join(fields.unsubscribe_url);
}

// Send the post-payment welcome email. Never throws.
async function sendWelcomeEmail(
  admin: any,
  venueId: string | null,
  ctx: { eventId: string }
): Promise<void> {
  if (!venueId) return;
  if (!RESEND_API_KEY) {
    console.error(`[stripe-webhook] welcome email skipped (${ctx.eventId}): RESEND_API_KEY missing`);
    return;
  }

  try {
    // Fetch the venue row. We need name, contact, forwarding address, plan.
    const { data: venue, error: vErr } = await admin
      .from('venues')
      .select('id, name, manager_name, contact_email, inbound_address, subscription_phase, subscription_tier, welcome_email_sent_at, unsubscribe_token')
      .eq('id', venueId)
      .maybeSingle();

    if (vErr || !venue) {
      console.error(`[stripe-webhook] welcome email skipped (${ctx.eventId}): venue ${venueId} not found${vErr ? ' — ' + vErr.message : ''}`);
      return;
    }

    // Idempotency guard — already sent, don't send again on a Stripe retry.
    if (venue.welcome_email_sent_at) {
      return;
    }

    // Recipient: the venue's contact email.
    const to = venue.contact_email;
    if (!to) {
      console.error(`[stripe-webhook] welcome email skipped (${ctx.eventId}): venue ${venueId} has no contact_email`);
      return;
    }

    // First name only for the greeting, from manager_name.
    const contactName = (venue.manager_name || '').trim().split(/\s+/)[0] || 'there';
    const planLabel = welcomePlanLabel(venue.subscription_phase, venue.subscription_tier);

    const fields = {
      venue_name: venue.name || 'your venue',
      contact_name: contactName,
      inbound_address: venue.inbound_address || '',
      dashboard_url: DASHBOARD_URL,
      plan_label: planLabel,
      unsubscribe_url: `https://hiretrial.com.au/api/unsubscribe?token=${venue.unsubscribe_token || ''}&type=venue`,
    };

    const htmlBody = fillWelcomeTemplate(WELCOME_HTML_TEMPLATE, fields);
    const textBody = fillWelcomeTemplate(WELCOME_TEXT_TEMPLATE, fields);
    const subject = `You're live on Trial., ${fields.venue_name}`;

    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: WELCOME_FROM_EMAIL,
        to: [to],
        reply_to: WELCOME_REPLY_TO_EMAIL,
        subject,
        text: textBody,
        html: htmlBody,
        tags: [
          { name: 'category', value: 'post-payment-welcome' },
        ],
      }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      console.error(`[stripe-webhook] welcome email Resend ${resp.status} (${ctx.eventId}): ${body.slice(0, 200)}`);
      return; // don't stamp sent — leaves it eligible for manual resend
    }

    // Stamp sent so retries don't double-send.
    const { error: stampErr } = await admin
      .from('venues')
      .update({ welcome_email_sent_at: new Date().toISOString() })
      .eq('id', venueId);
    if (stampErr) {
      console.error(`[stripe-webhook] welcome email sent but stamp failed (${ctx.eventId}): ${stampErr.message}`);
    }
  } catch (e: any) {
    // Never let an email problem break the payment webhook.
    console.error(`[stripe-webhook] welcome email threw (${ctx.eventId}): ${e?.message || 'unknown'}`);
  }
}
