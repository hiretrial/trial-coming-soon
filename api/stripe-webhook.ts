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

const stripe = STRIPE_SECRET_KEY
  ? new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' })
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
  admin: ReturnType<typeof createClient>,
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

// ─── Helper: find venue + account from a Stripe customer ID ───────
// Subscription/checkout events reference stripe_customer_id. We map
// that back to our internal account_id and venue_id for logging.
async function resolveCustomer(
  admin: ReturnType<typeof createClient>,
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
        await logEvent(admin, {
          stripe_event_id: event.id,
          event_type: 'subscription_started',
          venue_id,
          account_id,
          amount_cents: session.amount_total ?? null,
          currency: session.currency ?? null,
          stripe_invoice_id: asString(session.invoice),
          stripe_payment_intent_id: asString(session.payment_intent),
          metadata: event,
        });

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

        await logEvent(admin, {
          stripe_event_id: event.id,
          event_type: eventType,
          venue_id,
          account_id,
          amount_cents: invoice.amount_paid ?? null,
          currency: invoice.currency ?? null,
          stripe_invoice_id: invoice.id || null,
          stripe_payment_intent_id: asString(invoice.payment_intent),
          metadata: event,
        });

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

        await logEvent(admin, {
          stripe_event_id: event.id,
          event_type: 'payment_failed',
          venue_id,
          account_id,
          amount_cents: invoice.amount_due ?? null,
          currency: invoice.currency ?? null,
          stripe_invoice_id: invoice.id || null,
          stripe_payment_intent_id: asString(invoice.payment_intent),
          metadata: event,
        });

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
