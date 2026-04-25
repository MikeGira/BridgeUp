'use strict';
module.exports = (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(JSON.stringify({
    ok: true, node: process.version, ts: new Date().toISOString(),
    env: {
      hasSupabase:  !!process.env.SUPABASE_URL,
      hasSession:   !!process.env.SESSION_SECRET,
      hasTwilio:    !!process.env.TWILIO_ACCOUNT_SID,
      hasAnthropic: !!(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY),
    },
  }));
};
