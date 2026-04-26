'use strict';
// Diagnostic endpoint — visit /api/agent/test to check AI connectivity
// Safe to expose: returns only boolean/status info, no secrets
const { handler } = require('../_lib/cors');

module.exports = handler(async (req, res) => {
  const key = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;

  const result = {
    timestamp:    new Date().toISOString(),
    key_present:  !!key,
    key_prefix:   key ? key.slice(0, 7) + '…' : null,
    model_tested: null,
    ai_status:    'untested',
    ai_reply:     null,
    error:        null,
  };

  if (!key) {
    result.ai_status = 'no_key';
    result.error = 'ANTHROPIC_API_KEY (or CLAUDE_API_KEY) is not set. Add it in Vercel → Settings → Environment Variables, then redeploy.';
    return res.status(503).json(result);
  }

  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: key });

  const MODELS = ['claude-3-5-haiku-20241022', 'claude-haiku-4-5-20251001'];
  for (const model of MODELS) {
    try {
      const response = await client.messages.create({
        model,
        max_tokens: 20,
        messages: [{ role: 'user', content: 'Reply with only the word "ready".' }],
      });
      result.model_tested = model;
      result.ai_status    = 'ok';
      result.ai_reply     = response.content[0]?.text?.trim();
      return res.json(result);
    } catch (err) {
      if (err.status === 404 || err.status === 400) continue; // try next model
      result.model_tested = model;
      result.ai_status    = 'error';
      result.error        = `HTTP ${err.status}: ${err.message}`;
      return res.status(502).json(result);
    }
  }

  result.ai_status = 'error';
  result.error     = 'No models accessible. Check your API key permissions.';
  return res.status(502).json(result);
});
