'use strict';
const { handler }     = require('../_lib/cors');
const { requireAuth } = require('../_lib/auth');
const supabase        = require('../_lib/supabase');

module.exports = handler(async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const claims = await requireAuth(req);
  if (!['admin','superadmin','ngo'].includes(claims.role)) return res.status(403).json({ error: 'Admin access required.' });

  const today = new Date(); today.setHours(0,0,0,0);

  const [needsTotal, needsToday, needsResolved, activeHelpers, pendingApprovals] = await Promise.all([
    supabase.from('needs').select('id', { count: 'exact', head: true }),
    supabase.from('needs').select('id', { count: 'exact', head: true }).gte('created_at', today.toISOString()),
    supabase.from('needs').select('id', { count: 'exact', head: true }).eq('status', 'resolved'),
    supabase.from('helpers').select('id', { count: 'exact', head: true }).eq('status', 'approved'),
    supabase.from('helpers').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
  ]);

  const total = needsTotal.count || 0;
  const resolved = needsResolved.count || 0;

  res.json({
    needsTotal:       total,
    needsToday:       needsToday.count || 0,
    needsResolved:    resolved,
    resolutionRate:   total > 0 ? Math.round((resolved / total) * 100) : 0,
    activeHelpers:    activeHelpers.count || 0,
    pendingApprovals: pendingApprovals.count || 0,
    flaggedAccounts:  0,
    topHelpers:       [],
  });
});
