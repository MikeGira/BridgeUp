'use strict';
const supabase = require('./supabase');

async function log({ action, actorId, targetId, meta = {}, tenantId = null }) {
  try {
    await supabase.from('audit_log').insert({
      action, actor_id: actorId || null, target_id: targetId || null,
      tenant_id: tenantId || null, meta,
    });
  } catch (err) {
    console.error('[Audit] write failed:', err.message);
  }
}

module.exports = { log };
