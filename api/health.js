'use strict';
const { handler } = require('./_lib/cors');

module.exports = handler(async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const base = {
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
  };

  // ?ai=1 runs a live Anthropic connectivity test using native fetch — no SDK dependency
  if (req.query?.ai === '1') {
    const key = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
    if (!key) {
      return res.json({
        ...base,
        ai_test: { status: 'no_key', error: 'ANTHROPIC_API_KEY not set. Add it in Vercel env vars and redeploy.' },
      });
    }

    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);

      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key':         key,
          'anthropic-version': '2023-06-01',
          'content-type':      'application/json',
        },
        body: JSON.stringify({
          model:     'claude-sonnet-4-6',
          max_tokens: 20,
          messages:  [{ role: 'user', content: 'Reply with only the word "ready".' }],
        }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);

      if (r.ok) {
        const data = await r.json();
        return res.json({
          ...base,
          ai_test: { status: 'ok', model: 'claude-sonnet-4-6', reply: data.content?.[0]?.text?.trim() },
        });
      }

      const errText = await r.text();
      return res.json({
        ...base,
        ai_test: { status: 'error', httpStatus: r.status, error: errText.slice(0, 300) },
      });
    } catch (err) {
      return res.json({
        ...base,
        ai_test: {
          status: 'error',
          error:  err.name === 'AbortError' ? 'timeout after 8s' : err.message,
        },
      });
    }
  }

  res.json(base);
});
