// lib/welcome-email.js
//
// Branded welcome email sent immediately after Stripe payment confirms.
// Called from post-payment.js after account flips to active.
//
// Usage:
//   import { sendVenueWelcomeEmail } from '../lib/welcome-email.js';
//   await sendVenueWelcomeEmail({ venueName, contactName, inboundAddress, planLabel, dashboardUrl });

const PLAN_DETAILS = {
  solo: {
    label: 'Solo',
    price: '$89.99/mo + GST',
    hire_fee: '$99 per retained hire',
    venues: '1 venue',
  },
  starter: {
    label: 'Starter',
    price: '$99.99/mo + GST',
    hire_fee: '$89 per retained hire',
    venues: '2–5 venues',
  },
  growth: {
    label: 'Growth',
    price: '$109.99/mo + GST',
    hire_fee: '$79 per retained hire',
    venues: '6–20 venues',
  },
};

export async function sendVenueWelcomeEmail({
  to,
  venueName,
  contactName,
  inboundAddress,
  planKey,
  dashboardUrl = 'https://dashboard.hiretrial.com.au',
  resendApiKey = process.env.RESEND_API_KEY,
}) {
  const plan = PLAN_DETAILS[planKey?.toLowerCase()] || PLAN_DETAILS.solo;
  const displayName = contactName || venueName || 'there';
  const html = buildWelcomeEmail({ venueName, displayName, inboundAddress, plan, dashboardUrl });

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Anders at Trial. <hello@hiretrial.com.au>',
      to,
      reply_to: 'hello@hiretrial.com.au',
      subject: `You're live on Trial. — everything you need to know`,
      html,
      tags: [{ name: 'category', value: 'venue-welcome' }],
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Welcome email send failed: ${resp.status} ${err}`);
  }

  return await resp.json();
}

function buildWelcomeEmail({ venueName, displayName, inboundAddress, plan, dashboardUrl }) {
  return `<!DOCTYPE html>
<html lang="en-AU">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Welcome to Trial.</title>
</head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">

<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:40px 20px;">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;">

  <!-- Logo -->
  <tr><td style="padding-bottom:32px;">
    <span style="font-family:Georgia,serif;font-size:24px;font-weight:800;color:#f8f6f0;letter-spacing:-0.4px;">Trial<span style="color:#c8a96e;">.</span></span>
  </td></tr>

  <!-- Hero card -->
  <tr><td style="background:linear-gradient(160deg,#1f1a12 0%,#16120c 100%);border:1px solid rgba(200,169,110,0.35);border-radius:16px;padding:44px 40px 36px;box-shadow:0 0 48px rgba(200,169,110,0.08);margin-bottom:24px;">
    <p style="margin:0 0 8px;font-size:11px;letter-spacing:0.26em;text-transform:uppercase;color:#c8a96e;font-weight:600;font-family:Arial,sans-serif;">Founding Partner</p>
    <h1 style="margin:0 0 20px;font-family:Georgia,serif;font-size:32px;font-weight:800;color:#f8f6f0;line-height:1.15;letter-spacing:-0.6px;">You're live, ${displayName}.</h1>
    <p style="margin:0 0 28px;font-size:16px;line-height:1.65;color:rgba(248,246,240,0.75);">
      <strong style="color:#f8f6f0;">${venueName}</strong> is now active on Trial. Every application that lands in your Trial. inbox will automatically trigger a candidate assessment — no manual steps, no chasing.
    </p>

    <!-- Plan block -->
    <table width="100%" cellpadding="0" cellspacing="0" style="background:rgba(200,169,110,0.08);border:1px solid rgba(200,169,110,0.2);border-radius:12px;margin-bottom:32px;">
      <tr><td style="padding:22px 26px;">
        <p style="margin:0 0 14px;font-size:10px;letter-spacing:0.22em;text-transform:uppercase;color:rgba(248,246,240,0.45);font-family:Arial,sans-serif;">Your plan</p>
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="font-family:Georgia,serif;font-size:22px;font-weight:700;color:#c8a96e;">${plan.label}</td>
            <td align="right" style="font-size:14px;color:rgba(248,246,240,0.6);font-family:Arial,sans-serif;">${plan.venues}</td>
          </tr>
        </table>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;border-top:1px solid rgba(200,169,110,0.15);padding-top:16px;">
          <tr>
            <td style="font-size:13px;color:rgba(248,246,240,0.55);font-family:Arial,sans-serif;padding-bottom:8px;">Monthly subscription</td>
            <td align="right" style="font-size:13px;color:#f8f6f0;font-weight:500;font-family:Arial,sans-serif;padding-bottom:8px;">${plan.price}</td>
          </tr>
          <tr>
            <td style="font-size:13px;color:rgba(248,246,240,0.55);font-family:Arial,sans-serif;">Retained hire fee</td>
            <td align="right" style="font-size:13px;color:#f8f6f0;font-weight:500;font-family:Arial,sans-serif;">${plan.hire_fee}</td>
          </tr>
        </table>
        <p style="margin:14px 0 0;font-size:12px;color:rgba(248,246,240,0.4);font-family:Arial,sans-serif;line-height:1.5;">The hire fee only applies if a candidate you found through Trial. stays in the role for 90 days. You'll confirm this in your dashboard — nothing is charged automatically.</p>
      </td></tr>
    </table>

    <!-- CTA -->
    <table cellpadding="0" cellspacing="0" style="margin-bottom:8px;">
      <tr><td style="background:#c8a96e;border-radius:10px;">
        <a href="${dashboardUrl}" style="display:inline-block;padding:15px 32px;color:#0a0a0a;text-decoration:none;font-family:Arial,sans-serif;font-weight:700;font-size:15px;letter-spacing:0.02em;">Go to your dashboard &rarr;</a>
      </td></tr>
    </table>
  </td></tr>

  <tr><td style="height:24px;"></td></tr>

  <!-- Step 1: The big thing they need to do -->
  <tr><td style="background:#111;border:1px solid rgba(255,255,255,0.07);border-radius:14px;padding:32px 36px;">
    <p style="margin:0 0 8px;font-size:10px;letter-spacing:0.24em;text-transform:uppercase;color:#c8a96e;font-weight:600;font-family:Arial,sans-serif;">One thing to do now</p>
    <h2 style="margin:0 0 14px;font-family:Georgia,serif;font-size:22px;font-weight:700;color:#f8f6f0;">Update your job listings.</h2>
    <p style="margin:0 0 16px;font-size:14px;line-height:1.65;color:rgba(248,246,240,0.7);font-family:Arial,sans-serif;">
      Your Trial. inbox is ready. Any application sent to this address will automatically trigger a candidate assessment. Update the contact email on your SEEK, Indeed, or direct listings to:
    </p>
    <div style="background:rgba(200,169,110,0.1);border:1px solid rgba(200,169,110,0.25);border-radius:8px;padding:14px 18px;margin-bottom:16px;">
      <p style="margin:0;font-family:'Courier New',monospace;font-size:15px;color:#c8a96e;font-weight:600;letter-spacing:0.02em;">${inboundAddress}</p>
    </div>
    <p style="margin:0;font-size:13px;line-height:1.6;color:rgba(248,246,240,0.45);font-family:Arial,sans-serif;">
      That's it. Once your listings point here, Trial. runs automatically. You don't need to do anything else to trigger assessments.
    </p>
  </td></tr>

  <tr><td style="height:24px;"></td></tr>

  <!-- How it works -->
  <tr><td style="background:#111;border:1px solid rgba(255,255,255,0.07);border-radius:14px;padding:32px 36px;">
    <p style="margin:0 0 8px;font-size:10px;letter-spacing:0.24em;text-transform:uppercase;color:#c8a96e;font-weight:600;font-family:Arial,sans-serif;">How it works</p>
    <h2 style="margin:0 0 24px;font-family:Georgia,serif;font-size:22px;font-weight:700;color:#f8f6f0;">Four steps. Zero manual work.</h2>

    ${['A candidate applies to your listing and their application lands in your Trial. inbox.',
       'Trial. automatically sends the candidate a branded 10-question scenario assessment for the role they applied for.',
       'Our AI scores their responses against a role-specific rubric and generates a summary of their strengths and any concerns.',
       'You see the scored result in your dashboard — ready to interview, trial, or pass.',
    ].map((step, i) => `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:${i < 3 ? '18px' : '0'};">
      <tr>
        <td width="36" valign="top" style="padding-top:2px;">
          <div style="width:26px;height:26px;background:rgba(200,169,110,0.15);border:1px solid rgba(200,169,110,0.3);border-radius:50%;text-align:center;line-height:26px;font-size:12px;font-weight:700;color:#c8a96e;font-family:Arial,sans-serif;">${i + 1}</div>
        </td>
        <td style="font-size:14px;line-height:1.6;color:rgba(248,246,240,0.7);font-family:Arial,sans-serif;padding-left:12px;">${step}</td>
      </tr>
    </table>`).join('')}
  </td></tr>

  <tr><td style="height:24px;"></td></tr>

  <!-- FAQs -->
  <tr><td style="background:#111;border:1px solid rgba(255,255,255,0.07);border-radius:14px;padding:32px 36px;">
    <p style="margin:0 0 8px;font-size:10px;letter-spacing:0.24em;text-transform:uppercase;color:#c8a96e;font-weight:600;font-family:Arial,sans-serif;">FAQ</p>
    <h2 style="margin:0 0 28px;font-family:Georgia,serif;font-size:22px;font-weight:700;color:#f8f6f0;">Everything you need to know.</h2>

    ${[
      {
        q: 'What happens when a candidate applies?',
        a: 'Their application lands in your Trial. inbox. Trial. automatically parses their name and role, creates an assessment, and sends them a branded invite email — all within seconds. You receive a copy of the original application in your dashboard.',
      },
      {
        q: 'How long does the assessment take?',
        a: 'About 10–12 minutes. Ten scenario-based questions, text responses only. No video, no personality test, no weird stuff. Candidates can complete it on any device.',
      },
      {
        q: 'What if a candidate doesn\'t complete it?',
        a: 'They get a reminder email. If they still don\'t complete it, their application sits in your dashboard as incomplete. You can choose to follow up directly or move on — your call.',
      },
      {
        q: 'Can I see the questions candidates are asked?',
        a: 'Yes. You can view the full question and answer breakdown for every candidate in your dashboard. Click any candidate to see each question, their response, and the AI\'s per-question notes.',
      },
      {
        q: 'What does the score mean?',
        a: 'Scores run from 0–100. We also assign a tier — A (strong), B (worth interviewing), C (borderline), D (pass). The score reflects the quality of their thinking, not their writing. A short, sharp answer can outscore a long, vague one.',
      },
      {
        q: 'What if I disagree with a score?',
        a: 'Use your own judgement. The score is one input — not a directive. You know your venue. If someone scores a C but their CV is brilliant and they\'ve got great experience, interview them anyway. The AI assists your decision, it doesn\'t make it.',
      },
      {
        q: 'When do I get charged the hire fee?',
        a: 'At day 90. If a candidate you found through Trial. is still in the role 90 days after you hired them, you\'ll get a prompt in your dashboard to confirm. Once confirmed, an invoice is issued. If they left before day 90, no hire fee applies.',
      },
      {
        q: 'How do I update my SEEK listing?',
        a: `Log into SEEK, open your active listing, and update the application email to ${inboundAddress}. Do the same for any Indeed or direct listings. That\'s all — applications will start flowing through automatically.`,
      },
      {
        q: 'Can I pause or cancel?',
        a: 'You can cancel any time through your dashboard. Cancellation takes effect at the end of your current billing cycle. As a Founding Partner your pricing is locked — if you ever reactivate, standard pricing will apply.',
      },
      {
        q: 'What roles does Trial. support?',
        a: 'Currently all front-of-house roles: Bartender, Bar Back, Bar Manager, Barista, Café All-Rounder, Kitchen Hand, Café Manager, Duty Manager, Expediter, Waiter/Waitress, Host, Restaurant Manager, and Supervisor. Back-of-house support is coming later this year.',
      },
    ].map(({ q, a }) => `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:22px;padding-bottom:22px;border-bottom:1px solid rgba(255,255,255,0.06);">
      <tr><td>
        <p style="margin:0 0 6px;font-size:14px;font-weight:600;color:#f8f6f0;font-family:Arial,sans-serif;">${q}</p>
        <p style="margin:0;font-size:13.5px;line-height:1.65;color:rgba(248,246,240,0.65);font-family:Arial,sans-serif;">${a}</p>
      </td></tr>
    </table>`).join('')}

    <p style="margin:0;font-size:13px;color:rgba(248,246,240,0.4);font-family:Arial,sans-serif;">
      Got a question that's not here? Email <a href="mailto:hello@hiretrial.com.au" style="color:#c8a96e;text-decoration:none;">hello@hiretrial.com.au</a> — we'll get back to you same day.
    </p>
  </td></tr>

  <tr><td style="height:24px;"></td></tr>

  <!-- Positioning reminder -->
  <tr><td style="background:linear-gradient(135deg,rgba(200,169,110,0.1),rgba(200,169,110,0.05));border:1px solid rgba(200,169,110,0.2);border-radius:14px;padding:28px 36px;">
    <p style="margin:0 0 10px;font-size:15px;line-height:1.65;color:rgba(248,246,240,0.8);font-family:Arial,sans-serif;font-style:italic;">
      "We're not replacing your judgement. We're protecting it."
    </p>
    <p style="margin:0;font-size:13px;color:rgba(248,246,240,0.4);font-family:Arial,sans-serif;">
      Every hire fee only fires if the candidate stays 90 days. If it doesn't work out, you pay nothing extra. That's the deal.
    </p>
  </td></tr>

  <tr><td style="height:24px;"></td></tr>

  <!-- Final CTA -->
  <tr><td align="center" style="padding:8px 0 32px;">
    <table cellpadding="0" cellspacing="0">
      <tr><td style="background:#c8a96e;border-radius:10px;">
        <a href="${dashboardUrl}" style="display:inline-block;padding:16px 40px;color:#0a0a0a;text-decoration:none;font-family:Arial,sans-serif;font-weight:700;font-size:15px;letter-spacing:0.02em;">Open your dashboard &rarr;</a>
      </td></tr>
    </table>
  </td></tr>

  <!-- Footer -->
  <tr><td style="padding-top:8px;text-align:center;border-top:1px solid rgba(255,255,255,0.06);">
    <p style="margin:0 0 6px;font-size:12px;color:rgba(248,246,240,0.3);font-family:Arial,sans-serif;line-height:1.8;">
      Trial. &middot; ABN 71 441 417 792 &middot; <a href="mailto:hello@hiretrial.com.au" style="color:rgba(248,246,240,0.3);text-decoration:none;">hello@hiretrial.com.au</a>
    </p>
    <p style="margin:0;font-size:11px;color:rgba(248,246,240,0.2);font-family:Arial,sans-serif;">
      This is a transactional notification for your Trial. account.
    </p>
  </td></tr>

</table>
</td></tr>
</table>

</body>
</html>`;
}
