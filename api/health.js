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

  // ?ai=1 runs a live Anthropic connectivity test (takes ~2s)
  if (req.query?.ai === '1') {
    const key = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
    if (!key) {
      return res.json({
        ...base,
        ai_test: { status: 'no_key', error: 'ANTHROPIC_API_KEY not set. Add it in Vercel env vars and redeploy.' },
      });
    }

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: key });
    const MODELS = ['claude-3-5-haiku-20241022', 'claude-haiku-4-5-20251001'];

    for (const model of MODELS) {
      try {
        const r = await client.messages.create({
          model, max_tokens: 20,
          messages: [{ role: 'user', content: 'Reply with only the word "ready".' }],
        });
        return res.json({
          ...base,
          ai_test: { status: 'ok', model, reply: r.content[0]?.text?.trim() },
        });
      } catch (err) {
        if (err.status === 404 || err.status === 400) continue;
        return res.json({
          ...base,
          ai_test: { status: 'error', model, error: `HTTP ${err.status}: ${err.message}` },
        });
      }
    }

    return res.json({
      ...base,
      ai_test: { status: 'error', error: 'No accessible model found. Check API key permissions.' },
    });
  }

  res.json(base);
});
