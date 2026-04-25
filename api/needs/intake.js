'use strict';
const { handler }  = require('../_lib/cors');
const supabase     = require('../_lib/supabase');
const Anthropic    = require('@anthropic-ai/sdk');

function getClient() {
  const key = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
  if (!key) throw Object.assign(new Error('AI not configured.'), { status: 503 });
  return new Anthropic({ apiKey: key });
}

const SYSTEM = `You are BridgeUp's compassionate intake assistant. Help people in crisis describe their needs.
Detect their language from the first message and always respond in that language.
Ask MAX 3 short, focused questions to gather: (1) what kind of help, (2) location, (3) urgency.
When you have enough, respond with the JSON block below (in your language reply, not separate):
<INTAKE_COMPLETE>{"category":"food|housing|employment|medical|training|funding|other","description":"brief summary","location":"city or area","urgency":"immediate|days|weeks","language":"en|fr|rw|sw|ar"}</INTAKE_COMPLETE>
Never ask for personal identification. Be warm, brief, and clear.`;

module.exports = handler(async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { sessionId, message } = req.body || {};
  if (!sessionId || !message) return res.status(400).json({ error: 'sessionId and message required.' });
  if (typeof message !== 'string' || message.length > 1000) return res.status(400).json({ error: 'Message too long.' });

  // Load or init session history
  const { data: session } = await supabase.from('sms_conversations').select('*').eq('phone', 'intake_' + sessionId).maybeSingle();
  const history = session?.conversation_history || [];
  const turn = history.filter(m => m.role === 'user').length + 1;

  const messages = [...history, { role: 'user', content: message.trim() }];

  let reply, isComplete = false, needId = null;

  try {
    const ai = getClient();
    const response = await ai.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system: SYSTEM,
      messages: messages.slice(-10),
    });
    reply = response.content[0].text;
  } catch (err) {
    console.error('[intake] AI error:', err.status || err.message, err.error || '');
    const is503 = err.status === 503 || (err.message || '').includes('not configured');
    reply = is503
      ? 'AI assistant is not available right now. Please use the form to post your need.'
      : 'I had a moment of confusion. Could you try again in a few words?';
  }

  // Check for completion signal
  const match = reply.match(/<INTAKE_COMPLETE>([\s\S]*?)<\/INTAKE_COMPLETE>/);
  if (match || turn >= 3) {
    isComplete = true;
    try {
      const data = match ? JSON.parse(match[1]) : { category: 'other', description: message, urgency: 'days', language: 'en' };
      const { data: need } = await supabase.from('needs').insert({
        category: data.category || 'other',
        description: (data.description || message).slice(0, 2000),
        location: data.location?.slice(0, 255) || null,
        urgency: data.urgency || 'days',
        status: 'pending_match', channel: 'web', language: data.language || 'en',
      }).select('id').single();
      if (need) needId = need.id;
      reply = reply.replace(/<INTAKE_COMPLETE>[\s\S]*?<\/INTAKE_COMPLETE>/g, '').trim();
    } catch { /* use AI reply as-is */ }
  }

  // Save session
  const updatedHistory = [...messages, { role: 'assistant', content: reply }];
  await supabase.from('sms_conversations').upsert({
    phone: 'intake_' + sessionId, step: isComplete ? 'complete' : 'active',
    conversation_history: updatedHistory.slice(-20), updated_at: new Date().toISOString(),
  }).catch(() => {});

  res.json({ reply, isComplete, needId, turn });
});
