// ═══════════════════════════════════════════════════════════════════
// api/health/haiku.js
// ═══════════════════════════════════════════════════════════════════
// Public health endpoint. Returns aggregate Haiku status only — no
// PII, no full error messages, no call context. Safe to expose
// unauthenticated since it only leaks "is the service up/down" info.
//
// Cached for 10s to absorb polling load (TrialHQ polls every 30s,
// multiple tabs could compound).
//
// Response shape:
// {
//   service: 'haiku',
//   status: 'up' | 'down' | 'unknown',
//   last_call_at: ISO timestamp | null,
//   last_success_at: ISO timestamp | null,
//   downtime_seconds: int | null,        // null when up; seconds since first error in current streak when down
//   last_error_type: 'rate_limit' | 'auth' | ... | null,
//   last_error_at: ISO timestamp | null,
//   today: {
//     calls: int,
//     errors: int,
//     cost_usd: number,
//     avg_latency_ms: number | null
//   },
//   last_7d: {
//     calls: int,
//     errors: int,
//     cost_usd: number
//   },
//   computed_at: ISO timestamp
// }
// ═══════════════════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const SERVICE = 'haiku';

export default async function handler(req, res) {
  // CORS — TrialHQ is served from dashboard.hiretrial.com.au, this
  // endpoint lives on hiretrial.com.au. Cross-origin GET needs explicit headers.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'public, max-age=10');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

  try {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000).toISOString();

    // ── Last 50 rows for this service, used for current-state determination ──
    const { data: recent, error: recentErr } = await supabase
      .from('api_call_log')
      .select('id, status, status_code, error_type, called_at')
      .eq('service', SERVICE)
      .order('called_at', { ascending: false })
      .limit(50);

    if (recentErr) {
      console.error('[health/haiku] recent query failed:', recentErr);
      return res.status(500).json({ error: 'db_query_failed' });
    }

    // ── Today's aggregates ──
    const { data: todayRows, error: todayErr } = await supabase
      .from('api_call_log')
      .select('status, latency_ms, cost_usd')
      .eq('service', SERVICE)
      .gte('called_at', todayStart);

    if (todayErr) {
      console.error('[health/haiku] today query failed:', todayErr);
      return res.status(500).json({ error: 'db_query_failed' });
    }

    // ── Last 7 days aggregates ──
    const { data: weekRows, error: weekErr } = await supabase
      .from('api_call_log')
      .select('status, cost_usd')
      .eq('service', SERVICE)
      .gte('called_at', sevenDaysAgo);

    if (weekErr) {
      console.error('[health/haiku] week query failed:', weekErr);
      return res.status(500).json({ error: 'db_query_failed' });
    }

    // ── Determine current status ──
    // 'unknown' = no calls at all yet (fresh install or wrapper not wired)
    // 'up'      = most recent call succeeded
    // 'down'    = most recent call errored AND no success since
    let status = 'unknown';
    let last_call_at = null;
    let last_success_at = null;
    let last_error_type = null;
    let last_error_at = null;
    let downtime_seconds = null;

    if (recent && recent.length > 0) {
      last_call_at = recent[0].called_at;

      const lastSuccess = recent.find(r => r.status === 'success');
      const lastError = recent.find(r => r.status === 'error');
      last_success_at = lastSuccess?.called_at || null;
      last_error_at = lastError?.called_at || null;
      last_error_type = lastError?.error_type || null;

      if (recent[0].status === 'success') {
        status = 'up';
      } else {
        // Most recent is an error — walk the streak to find the FIRST
        // error in the current down-streak (so downtime starts there,
        // not from "now").
        status = 'down';
        let firstErrorInStreak = recent[0];
        for (const row of recent) {
          if (row.status === 'success') break;
          firstErrorInStreak = row;
        }
        downtime_seconds = Math.floor(
          (Date.now() - new Date(firstErrorInStreak.called_at).getTime()) / 1000
        );
      }
    }

    // ── Today aggregates ──
    const todayCalls = todayRows?.length || 0;
    const todayErrors = (todayRows || []).filter(r => r.status === 'error').length;
    const todayCost = (todayRows || []).reduce((s, r) => s + Number(r.cost_usd || 0), 0);
    const latencies = (todayRows || [])
      .map(r => r.latency_ms)
      .filter(n => Number.isFinite(n) && n > 0);
    const avgLatency = latencies.length > 0
      ? Math.round(latencies.reduce((s, n) => s + n, 0) / latencies.length)
      : null;

    // ── 7-day aggregates ──
    const weekCalls = weekRows?.length || 0;
    const weekErrors = (weekRows || []).filter(r => r.status === 'error').length;
    const weekCost = (weekRows || []).reduce((s, r) => s + Number(r.cost_usd || 0), 0);

    return res.status(200).json({
      service: SERVICE,
      status,
      last_call_at,
      last_success_at,
      last_error_type,
      last_error_at,
      downtime_seconds,
      today: {
        calls: todayCalls,
        errors: todayErrors,
        cost_usd: Number(todayCost.toFixed(4)),
        avg_latency_ms: avgLatency
      },
      last_7d: {
        calls: weekCalls,
        errors: weekErrors,
        cost_usd: Number(weekCost.toFixed(4))
      },
      computed_at: now.toISOString()
    });

  } catch (err) {
    console.error('[health/haiku] unexpected:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
}
