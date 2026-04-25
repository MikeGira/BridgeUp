'use strict';
const { handler }     = require('../_lib/cors');
const { requireAuth } = require('../_lib/auth');
const supabase        = require('../_lib/supabase');

module.exports = handler(async (req, res) => {
  const claims = await requireAuth(req);

  if (req.method === 'GET') {
    let q = supabase.from('matches').select('*, needs(*), helpers(*, users(*))').order('created_at', { ascending: false }).limit(50);
    if (claims.role === 'helper') {
      const { data: helper } = await supabase.from('helpers').select('id').eq('user_id', claims.userId).maybeSingle();
      if (helper) q = q.eq('helper_id', helper.id);
    } else if (!['admin','superadmin','ngo'].includes(claims.role)) {
      q = q.eq('user_id', claims.userId);
    }
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: 'Could not load matches.' });
    return res.json({ matches: data || [] });
  }

  res.status(405).json({ error: 'Method not allowed' });
});
