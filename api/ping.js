'use strict';

// Minimal diagnostic endpoint — no Express, no dependencies.
// If this works but /api/health fails, the crash is in the Express app.
module.exports = (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(JSON.stringify({
    ok: true,
    node: process.version,
    env: {
      hasSupabase:  !!process.env.SUPABASE_URL,
      hasSession:   !!process.env.SESSION_SECRET,
      hasTwilio:    !!process.env.TWILIO_ACCOUNT_SID,
      hasAnthropic: !!(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY),
    },
  }));
};
