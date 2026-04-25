'use strict';
const { handler } = require('./_lib/cors');
const supabase    = require('./_lib/supabase');

module.exports = handler(async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const start = Date.now();
  const { error } = await supabase.from('tenants').select('id').limit(1);
  res.json({
    status:   error ? 'degraded' : 'ok',
    service:  'BridgeUp API',
    version:  '2.0.0',
    ts:       new Date().toISOString(),
    database: error ? 'error: ' + error.message : `ok (${Date.now() - start}ms)`,
    node:     process.version,
  });
});
