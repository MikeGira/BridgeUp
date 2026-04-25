'use strict';
const { handler }     = require('../_lib/cors');
const { requireAuth } = require('../_lib/auth');
const supabase        = require('../_lib/supabase');
const { log }         = require('../_lib/audit');

module.exports = handler(async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const claims = await requireAuth(req);
  if (claims.jti) {
    await supabase.from('revoked_tokens').insert({
      jti: claims.jti, user_id: claims.userId, revoked_at: new Date().toISOString(),
      expires_at: claims.exp ? new Date(claims.exp * 1000).toISOString() : null,
    }).catch(() => {});
  }
  log({ action: 'user_logout', actorId: claims.userId }).catch(() => {});
  res.json({ success: true });
});
