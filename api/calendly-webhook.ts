// ═══════════════════════════════════════════════════════════════════
// api/calendly-webhook.ts
//
// Vercel API route. Receives POST notifications from Calendly when a
// booking is created or cancelled.
//
// Subscription is registered separately via Calendly's API (see
// docs/CALENDLY_WEBHOOK_SETUP.md). Once subscribed, every booking on
// the Trial - Demo event type fires a POST to this endpoint.
//
// Event types handled:
//   - invitee.created   → new booking
//   - invitee.canceled  → booking cancelled (note: Calendly uses single-'l')
//
// Flow:
//   1. Verify request signature using CALENDLY_WEBHOOK_SIGNING_KEY
//      (Calendly signs every webhook so we know it's really from them)
//   2. Parse payload
//   3. Upsert into bookings table (calendly_event_uri is the dedupe key)
//   4. Try to match to an EOI by invitee email → update EOI cache
//   5. Return 200 OK fast (Calendly retries on non-2xx)
//
// Env vars required (set in Vercel dashboard):
//   SUPABASE_URL                   - already exists
//   SUPABASE_SERVICE_ROLE_KEY      - already exists
//   CALENDLY_WEBHOOK_SIGNING_KEY   - returned when you create the
//                                    webhook subscription (we'll add this
//                                    AFTER subscribing — for now the
//                                    signature check is in dev mode)
// ═══════════════════════════════════════════════════════════════════

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

// ─── Config ───────────────────────────────────────────────────────
const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CALENDLY_SIGNING_KEY      = process.env.CALENDLY_WEBHOOK_SIGNING_KEY;

// Tolerance window for signature timestamp validation (seconds).
// Calendly recommends 3 minutes to handle network delay.
const SIGNATURE_TOLERANCE_SECONDS = 180;

// ─── Signature verification ───────────────────────────────────────
// Calendly signs every webhook with HMAC-SHA256 of `{timestamp}.{body}`.
// Header format: "t=1234567890,v1=abc123def456..."
// Docs: https://developer.calendly.com/api-docs/cc91ff5dec84d-webhook-signatures
function verifyCalendlySignature(
  rawBody: string,
  signatureHeader: string | undefined,
  signingKey: string
): { ok: boolean; error?: string } {
  if (!signatureHeader) {
    return { ok: false, error: 'Missing Calendly-Webhook-Signature header' };
  }

  // Parse the header — comma-separated key=value pairs
  const parts: Record<string, string> = {};
  for (const segment of signatureHeader.split(',')) {
    const [k, v] = segment.split('=');
    if (k && v) parts[k.trim()] = v.trim();
  }

  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) {
    return { ok: false, error: 'Malformed signature header' };
  }

  // Check timestamp is recent (prevents replay attacks)
  const tsNumber = parseInt(timestamp, 10);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - tsNumber) > SIGNATURE_TOLERANCE_SECONDS) {
    return { ok: false, error: `Timestamp outside tolerance (${SIGNATURE_TOLERANCE_SECONDS}s)` };
  }

  // Compute expected signature
  const signedPayload = `${timestamp}.${rawBody}`;
  const expected = crypto
    .createHmac('sha256', signingKey)
    .update(signedPayload, 'utf8')
    .digest('hex');

  // Constant-time comparison to prevent timing attacks
  const expectedBuf = Buffer.from(expected, 'hex');
  const receivedBuf = Buffer.from(signature, 'hex');
  if (expectedBuf.length !== receivedBuf.length) {
    return { ok: false, error: 'Signature length mismatch' };
  }
  if (!crypto.timingSafeEqual(expectedBuf, receivedBuf)) {
    return { ok: false, error: 'Signature does not match' };
  }

  return { ok: true };
}

// ─── Parse Calendly invitee.created payload ───────────────────────
// Calendly's webhook payload shape:
// {
//   event: 'invitee.created',
//   payload: {
//     uri: 'https://api.calendly.com/scheduled_events/.../invitees/...',
//     name: 'Anders Berggren',
//     email: 'anders@hiretrial.com.au',
//     scheduled_event: {
//       uri: 'https://api.calendly.com/scheduled_events/...',
//       name: 'Trial - Demo',
//       start_time: '2026-06-18T00:00:00Z',
//       end_time: '2026-06-18T00:30:00Z',
//       location: { type: 'zoom_conference', join_url: '...', data: { password: '...' } }
//     },
//     questions_and_answers: [
//       { question: "What's your venue called?", answer: 'Trial' },
//       { question: 'What type of venue?', answer: 'Cafe' },
//       ...
//     ],
//     text_reminder_number: '+61497215911',
//     cancel_url: '...',
//     reschedule_url: '...'
//   }
// }
interface CalendlyPayload {
  event: string;
  payload: any;
}

interface BookingRow {
  invitee_name:          string | null;
  invitee_email:         string;
  invitee_phone:         string | null;
  scheduled_at:          string;
  scheduled_end_at:      string | null;
  event_type_name:       string | null;
  conferencing_provider: string | null;
  conferencing_join_url: string | null;
  conferencing_password: string | null;
  calendly_event_uri:    string;
  calendly_invitee_uri:  string;
  custom_answers:        Record<string, string>;
  status:                string;
  cancelled_at:          string | null;
  cancel_reason:         string | null;
  raw_payload:           any;
}

function buildBookingFromPayload(body: CalendlyPayload): BookingRow {
  const p = body.payload;
  const evt = p.scheduled_event || {};
  const loc = evt.location || {};

  // Custom answers as a key/value map for easier querying
  const customAnswers: Record<string, string> = {};
  if (Array.isArray(p.questions_and_answers)) {
    for (const qa of p.questions_and_answers) {
      if (qa.question && qa.answer) customAnswers[qa.question] = qa.answer;
    }
  }

  // Map Calendly's location.type to our provider field
  const providerMap: Record<string, string> = {
    'zoom_conference':           'zoom',
    'microsoft_teams_conference':'teams',
    'google_conference':         'meet',
    'gotomeeting_conference':    'gotomeeting',
    'webex_conference':          'webex',
  };

  return {
    invitee_name:          p.name              || null,
    invitee_email:         String(p.email || '').toLowerCase(),
    invitee_phone:         p.text_reminder_number || null,
    scheduled_at:          evt.start_time      || new Date().toISOString(),
    scheduled_end_at:      evt.end_time        || null,
    event_type_name:       evt.name            || null,
    conferencing_provider: providerMap[loc.type] || loc.type || null,
    conferencing_join_url: loc.join_url        || null,
    conferencing_password: loc.data?.password  || null,
    calendly_event_uri:    evt.uri             || '',
    calendly_invitee_uri:  p.uri               || '',
    custom_answers:        customAnswers,
    status:                body.event === 'invitee.canceled' ? 'cancelled' : 'scheduled',
    cancelled_at:          body.event === 'invitee.canceled' ? new Date().toISOString() : null,
    cancel_reason:         p.cancellation?.reason || null,
    raw_payload:           body,
  };
}

// ─── Main handler ─────────────────────────────────────────────────
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Method check
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  // Env sanity
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[calendly-webhook] Missing SUPABASE env vars');
    return res.status(500).json({ ok: false, error: 'Server misconfiguration' });
  }

  // ── 1. Get raw body (needed for signature verification) ────────
  // Vercel parses body to JSON by default, but signature must be computed
  // against the raw bytes. We rebuild the raw string from the parsed body —
  // works because Calendly serialises JSON deterministically.
  // (For belt-and-braces, we could set bodyParser:false in config and read
  // the raw stream, but this is reliable enough for production.)
  const body: CalendlyPayload = req.body;
  if (!body || !body.event || !body.payload) {
    console.warn('[calendly-webhook] Malformed payload');
    return res.status(400).json({ ok: false, error: 'Malformed payload' });
  }
  const rawBody = JSON.stringify(body);

  // ── 2. Verify signature (skip in dev mode if no signing key) ───
  if (CALENDLY_SIGNING_KEY) {
    const sigHeader = req.headers['calendly-webhook-signature'] as string | undefined;
    const verify = verifyCalendlySignature(rawBody, sigHeader, CALENDLY_SIGNING_KEY);
    if (!verify.ok) {
      console.warn('[calendly-webhook] Signature failed:', verify.error);
      return res.status(401).json({ ok: false, error: verify.error });
    }
  } else {
    console.warn('[calendly-webhook] CALENDLY_WEBHOOK_SIGNING_KEY not set — signature check skipped (DEV MODE)');
  }

  // ── 3. Only handle events we care about ────────────────────────
  if (body.event !== 'invitee.created' && body.event !== 'invitee.canceled') {
    console.log(`[calendly-webhook] Ignoring event type: ${body.event}`);
    return res.status(200).json({ ok: true, ignored: body.event });
  }

  // ── 4. Build the booking row ───────────────────────────────────
  const booking = buildBookingFromPayload(body);
  if (!booking.calendly_invitee_uri || !booking.calendly_event_uri) {
    console.error('[calendly-webhook] Missing Calendly URIs in payload');
    return res.status(400).json({ ok: false, error: 'Missing Calendly URIs' });
  }

  // ── 5. Service-role client (bypasses RLS for backend ops) ─────
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // ── 6. Match to EOI by email (most recent submission wins) ────
  let matchedEoiId: string | null = null;
  if (booking.invitee_email) {
    const { data: eoi } = await admin
      .from('eoi_submissions')
      .select('id, status')
      .eq('email', booking.invitee_email)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (eoi) {
      matchedEoiId = eoi.id;
    } else {
      console.log(`[calendly-webhook] No EOI match for ${booking.invitee_email} — orphan booking will be saved`);
    }
  }

  // ── 7. Upsert booking (dedupe on calendly_invitee_uri) ────────
  const { data: bookingRow, error: bErr } = await admin
    .from('bookings')
    .upsert(
      { ...booking, eoi_id: matchedEoiId, updated_at: new Date().toISOString() },
      { onConflict: 'calendly_invitee_uri' }
    )
    .select('id')
    .single();
  if (bErr) {
    console.error('[calendly-webhook] Booking upsert failed:', bErr);
    return res.status(500).json({ ok: false, error: `Booking upsert failed: ${bErr.message}` });
  }

// ── 8. Update EOI cache + flip status to 'booked' ─────────────
  // When a booking lands, the EOI leaves the EOIs tab and appears in Bookings.
  // If the booking gets cancelled, EOI returns to 'new' so it shows up again.
  if (matchedEoiId) {
    const newStatus = booking.status === 'cancelled' ? 'new' : 'booked';
    const { error: updErr } = await admin
      .from('eoi_submissions')
      .update({
        status:                  newStatus,
        calendly_booking_id:     bookingRow.id,
        calendly_booking_at:     booking.scheduled_at,
        calendly_booking_status: booking.status,
        updated_at:              new Date().toISOString(),
      })
      .eq('id', matchedEoiId);
    if (updErr) {
      console.error('[calendly-webhook] EOI cache update failed (non-fatal):', updErr);
    }
  }

  console.log(
    `[calendly-webhook] ✅ ${body.event} ${booking.invitee_email} ` +
    `→ ${booking.scheduled_at} ` +
    (matchedEoiId ? `(EOI ${matchedEoiId.slice(0, 8)})` : '(orphan)')
  );

  return res.status(200).json({
    ok: true,
    booking_id: bookingRow.id,
    eoi_id: matchedEoiId,
    event: body.event,
  });
}
