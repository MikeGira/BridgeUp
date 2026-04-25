'use strict';
const { handler }      = require('../_lib/cors');
const { requireAuth }  = require('../_lib/auth');
const supabase         = require('../_lib/supabase');

module.exports = handler(async (req, res) => {
  const claims = await requireAuth(req);

  if (req.method === 'GET') {
    const { data, error } = await supabase.from('users').select('*').eq('phone', claims.phone).maybeSingle();
    if (error || !data) return res.status(404).json({ error: 'User not found. Please sign in again.' });
    return res.json({ user: { id: data.id, phone: data.phone, role: data.role, tenantId: data.tenant_id,
      country: data.country, language: data.language, displayName: data.display_name, avatarUrl: data.avatar_url,
      bio: data.bio, verified: data.verified, active: data.active, memberSince: data.created_at, lastLoginAt: data.last_login_at } });
  }

  if (req.method === 'PATCH') {
    const allowed = ['display_name', 'language', 'bio', 'avatar_url'];
    const updates = {};
    for (const k of allowed) { if (req.body?.[k] !== undefined) updates[k] = req.body[k]; }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields to update.' });
    const { data, error } = await supabase.from('users').update(updates).eq('id', claims.userId).select().single();
    if (error) return res.status(500).json({ error: 'Could not update profile.' });
    return res.json({ success: true, user: data });
  }

  res.status(405).json({ error: 'Method not allowed' });
});
