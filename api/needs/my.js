'use strict';
const { handler }     = require('../_lib/cors');
const { requireAuth } = require('../_lib/auth');
const supabase        = require('../_lib/supabase');

module.exports = handler(async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const claims = await requireAuth(req);
  const { data, error } = await supabase.from('needs').select('*')
    .eq('user_id', claims.userId).order('created_at', { ascending: false }).limit(50);
  if (error) return res.status(500).json({ error: 'Could not load your needs.' });
  res.json({ needs: data || [] });
});
