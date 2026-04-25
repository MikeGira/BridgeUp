'use strict';
const { handler } = require('./_lib/cors');

module.exports = handler(async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  res.json({
    status:  'ok',
    service: 'BridgeUp API',
    version: '2.0.0',
    ts:      new Date().toISOString(),
    node:    process.version,
    env: {
      hasSupabase:  !!process.env.SUPABASE_URL,
      hasSession:   !!process.env.SESSION_SECRET,
      hasTwilio:    !!process.env.TWILIO_ACCOUNT_SID,
      hasAnthropic: !!(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY),
    },
  });
});
