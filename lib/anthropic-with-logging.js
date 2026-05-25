// ═══════════════════════════════════════════════════════════════════
// lib/anthropic-with-logging.js
// ═══════════════════════════════════════════════════════════════════
// Thin wrapper around the Anthropic SDK that logs every call into
// the api_call_log table. Used everywhere Haiku (or Sonnet, etc) is
// called from this codebase.
//
// Usage (drop-in replacement for direct SDK use):
//
//   import { callHaiku } from '../lib/anthropic-with-logging.js';
//
//   const { content, raw } = await callHaiku({
//     messages: [{ role: 'user', content: 'Hi' }],
//     max_tokens: 1024,
//     system: 'You are helpful',
//     endpoint: 'inbound-email/extract-name',   // ← required, for filtering
//     context: { eoi_id: '...', candidate_id: '...' }  // ← optional, for debugging
//   });
//
// On success: returns { content: string, raw: SDK response }, logs success row.
// On error: re-throws the original error, logs error row first (never swallows).
// ═══════════════════════════════════════════════════════════════════

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Haiku 4.5 pricing per Anthropic public pricing
// Input:  $1.00 / 1M tokens  = $0.000001 / token
// Output: $5.00 / 1M tokens  = $0.000005 / token
// If you switch models, update this table.
const HAIKU_INPUT_USD_PER_TOKEN  = 0.000001;
const HAIKU_OUTPUT_USD_PER_TOKEN = 0.000005;
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

// Classify error into a short type code for the health endpoint
function classifyError(err) {
  const code = err?.status || err?.statusCode || err?.response?.status;
  if (code === 429) return 'rate_limit';
  if (code === 401 || code === 403) return 'auth';
  if (code >= 500 && code < 600) return 'server_error';
  if (err?.code === 'ETIMEDOUT' || err?.code === 'ECONNABORTED' || /timeout/i.test(err?.message || '')) return 'timeout';
  if (err?.code === 'ENOTFOUND' || err?.code === 'ECONNREFUSED') return 'network';
  return 'unknown';
}

// Fire-and-forget log writer. If logging itself fails, we never block the caller —
// the actual Haiku call must always be the source of truth.
async function writeLog(row) {
  try {
    const { error } = await supabaseAdmin.from('api_call_log').insert(row);
    if (error) console.error('[api_call_log] write failed:', error.message);
  } catch (e) {
    console.error('[api_call_log] write threw:', e?.message || e);
  }
}

/**
 * Call Claude Haiku with automatic logging.
 *
 * @param {Object} opts
 * @param {Array}  opts.messages   - messages array
 * @param {number} opts.max_tokens - max output tokens
 * @param {string} opts.system     - optional system prompt
 * @param {string} opts.model      - optional, defaults to Haiku 4.5
 * @param {string} opts.endpoint   - REQUIRED short identifier for this call site (e.g. 'inbound-email/extract-name')
 * @param {Object} opts.context    - optional jsonb stored on the log row for debugging
 * @returns {Promise<{ content: string, raw: object }>}
 */
export async function callHaiku(opts) {
  const {
    messages,
    max_tokens = 1024,
    system,
    model = DEFAULT_MODEL,
    endpoint,
    context = null
  } = opts || {};

  if (!endpoint) {
    throw new Error('callHaiku: endpoint is required (use e.g. "inbound-email/extract-name")');
  }
  if (!messages || !Array.isArray(messages)) {
    throw new Error('callHaiku: messages array is required');
  }

  const t0 = Date.now();

  try {
    const apiArgs = { model, max_tokens, messages };
    if (system) apiArgs.system = system;

    const response = await anthropic.messages.create(apiArgs);
    const latency_ms = Date.now() - t0;

    // Extract text content from the first text block
    const textBlock = (response.content || []).find(b => b.type === 'text');
    const content = textBlock?.text || '';

    const input_tokens  = response.usage?.input_tokens  ?? null;
    const output_tokens = response.usage?.output_tokens ?? null;
    const cost_usd = (input_tokens || 0) * HAIKU_INPUT_USD_PER_TOKEN
                   + (output_tokens || 0) * HAIKU_OUTPUT_USD_PER_TOKEN;

    // Log success — don't await, let it run in background
    writeLog({
      service:       'haiku',
      endpoint,
      status:        'success',
      status_code:   200,
      latency_ms,
      input_tokens,
      output_tokens,
      cost_usd,
      context
    });

    return { content, raw: response };

  } catch (err) {
    const latency_ms = Date.now() - t0;
    const error_type = classifyError(err);
    const status_code = err?.status || err?.statusCode || err?.response?.status || null;

    // Log error synchronously-but-non-blocking
    writeLog({
      service:       'haiku',
      endpoint,
      status:        'error',
      status_code,
      error_type,
      error_message: (err?.message || String(err)).slice(0, 2000),
      latency_ms,
      context
    });

    // Re-throw so the caller's existing error handling fires
    throw err;
  }
}

// Re-export the raw Anthropic client too, in case some call site needs
// streaming or other features the wrapper doesn't cover. Use sparingly —
// raw client calls will NOT show in the health monitor.
export { anthropic };
