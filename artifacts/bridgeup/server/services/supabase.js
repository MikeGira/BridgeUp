'use strict';

const { createClient } = require('@supabase/supabase-js');

let _supabase = null;

function getSupabase() {
  if (_supabase) return _supabase;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    throw Object.assign(new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY environment variables are not set. Add them in your Vercel project settings.'), { status: 503 });
  }
  _supabase = createClient(process.env.SUPABASE_URL.trim(), process.env.SUPABASE_SERVICE_KEY.trim(), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return _supabase;
}

// Proxy that lazily initialises the client on first use
const supabase = new Proxy({}, {
  get(_target, prop) {
    return getSupabase()[prop];
  },
});

const TABLES = {
  USERS:             'users',
  NEEDS:             'needs',
  HELPERS:           'helpers',
  MATCHES:           'matches',
  REVIEWS:           'reviews',
  PAYMENTS:          'payments',
  TENANTS:           'tenants',
  AUDIT_LOG:         'audit_log',
  NOTIFICATIONS:     'notifications',
  OTP_CODES:         'otp_codes',
  OTP_RATE_LIMIT:    'otp_rate_limit',
  REVOKED_TOKENS:    'revoked_tokens',
  SMS_CONVERSATIONS: 'sms_conversations',
  REPORTS:           'reports',
};

async function writeAuditLog({ action, actorId, targetId, meta = {}, tenantId = null }) {
  try {
    const { error } = await supabase.from(TABLES.AUDIT_LOG).insert({
      action,
      actor_id:  actorId  || null,
      target_id: targetId || null,
      tenant_id: tenantId || null,
      meta,
    });
    if (error) console.error('[Supabase] Audit log error:', error.message);
  } catch (err) {
    console.error('[Supabase] Audit log write failed:', err.message);
  }
}

module.exports = { supabase, TABLES, writeAuditLog };
