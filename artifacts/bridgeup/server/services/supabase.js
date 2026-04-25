'use strict';

const { createClient } = require('@supabase/supabase-js');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('[Supabase] FATAL: SUPABASE_URL and SUPABASE_SERVICE_KEY must be set.');
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

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
