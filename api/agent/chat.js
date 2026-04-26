'use strict';
const { handler }      = require('../_lib/cors');
const { optionalAuth } = require('../_lib/auth');
const supabase         = require('../_lib/supabase');
const twilioClient     = require('../_lib/twilio-client');
const Anthropic        = require('@anthropic-ai/sdk');

// ─── Anthropic client ─────────────────────────────────────────────────────────
function getAI() {
  const key = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
  if (!key) throw Object.assign(new Error('AI not configured.'), { status: 503 });
  // timeout: 7000 prevents Vercel's 10s function kill from leaving a silent crash
  return new Anthropic({ apiKey: key, timeout: 7000 });
}

// ─── System prompt ────────────────────────────────────────────────────────────
const SYSTEM = `You are Bridge, BridgeUp's AI agent. BridgeUp connects people in crisis with verified helpers and organizations.

You help people in need by:
1. Listening carefully to understand their situation
2. Searching our database for matched helpers near them
3. Presenting options clearly and waiting for the user to confirm
4. Contacting the chosen helper on their behalf via SMS
5. Confirming the contact was made and outlining next steps
6. Following up until the need is fully met
7. Marking tasks complete with a clear summary

Available help categories: food, housing, employment, medical, training, funding, other.

Rules:
- Always use search_helpers before recommending anyone — never invent helpers
- Only call contact_helper after the user explicitly confirms which helper they want
- Ask for location if not provided (city/neighbourhood is enough)
- Be warm, concise, and empathetic — people may be in crisis
- Detect the user's language and respond in it
- Never ask for passwords, ID numbers, or financial details
- When a task is fully resolved, call complete_task with a clear summary`;

// ─── Tool definitions ─────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'search_helpers',
    description: 'Search the BridgeUp database for active helpers that match the person\'s need category and location. Always call this before recommending anyone.',
    input_schema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['food', 'housing', 'employment', 'medical', 'training', 'funding', 'other'],
          description: 'The type of help needed',
        },
        location: { type: 'string', description: 'City, neighbourhood, or area the person is in' },
        urgency:  { type: 'string', enum: ['immediate', 'days', 'weeks'] },
      },
      required: ['category'],
    },
  },
  {
    name: 'create_need',
    description: 'Register a formal need request in the BridgeUp system so it can be tracked, matched, and reported.',
    input_schema: {
      type: 'object',
      properties: {
        category:    { type: 'string' },
        description: { type: 'string', description: 'A clear summary of what the person needs' },
        location:    { type: 'string' },
        urgency:     { type: 'string', enum: ['immediate', 'days', 'weeks'] },
        language:    { type: 'string', description: 'ISO language code (en, fr, rw, sw, ar, es)' },
      },
      required: ['category', 'description', 'urgency'],
    },
  },
  {
    name: 'contact_helper',
    description: 'Send an SMS to a helper on behalf of the person in need to initiate contact and introduce their situation. Only call this after the user has confirmed which helper they want.',
    input_schema: {
      type: 'object',
      properties: {
        helperId: { type: 'string', description: 'The helper\'s UUID from search_helpers results' },
        needId:   { type: 'string', description: 'The need UUID from create_need (if available)' },
        message:  { type: 'string', description: 'Professional, empathetic SMS message to send the helper on behalf of the person in need. Max 300 chars.' },
      },
      required: ['helperId', 'message'],
    },
  },
  {
    name: 'complete_task',
    description: 'Mark a need as resolved and generate a completion summary. Call this when the person confirms their need has been met.',
    input_schema: {
      type: 'object',
      properties: {
        needId:  { type: 'string' },
        matchId: { type: 'string' },
        summary: { type: 'string', description: 'What was accomplished, who helped, and what was provided. This becomes a permanent record.' },
        outcome: { type: 'string', enum: ['resolved', 'partial', 'referred'], description: 'resolved = fully met, partial = partially met, referred = forwarded to another service' },
      },
      required: ['needId', 'summary', 'outcome'],
    },
  },
];

// ─── Tool implementations ─────────────────────────────────────────────────────

async function toolSearchHelpers({ category, location, urgency }) {
  // Join helpers with users to get display name
  let q = supabase
    .from('helpers')
    .select('id, organization, help_types, location_address, location_lat, location_lng, service_radius_km, is_online, rating, total_resolved, user:user_id(display_name)')
    .eq('status', 'approved')
    .contains('help_types', [category])
    .order('rating', { ascending: false })
    .limit(5);

  const { data: helpers, error } = await q;
  if (error) return { helpers: [], total: 0, message: 'Could not search helpers right now.' };

  // Fallback: all approved helpers if category matches none
  if (!helpers?.length) {
    const { data: fallback } = await supabase
      .from('helpers')
      .select('id, organization, help_types, location_address, location_lat, location_lng, service_radius_km, is_online, rating, total_resolved, user:user_id(display_name)')
      .eq('status', 'approved')
      .limit(5);
    return { helpers: fallback || [], total: fallback?.length || 0, note: 'No exact category match — showing nearby helpers' };
  }

  return { helpers, total: helpers.length };
}

async function toolCreateNeed({ category, description, location, urgency, language }, userId) {
  const { data: need, error } = await supabase
    .from('needs')
    .insert({
      user_id:   userId || null,
      category,
      description: description.slice(0, 2000),
      location:  location?.slice(0, 255) || null,
      urgency:   urgency || 'days',
      status:    'pending_match',
      channel:   'ai_agent',
      language:  language || 'en',
    })
    .select('id')
    .single();

  if (error) return { error: 'Could not register need: ' + error.message };
  return { needId: need.id };
}

async function toolContactHelper({ helperId, needId, message }) {
  // Get helper's phone via their user record
  const { data: helper, error } = await supabase
    .from('helpers')
    .select('id, organization, user:user_id(phone, display_name)')
    .eq('id', helperId)
    .single();

  if (error || !helper) return { error: 'Helper not found.' };

  const phone       = helper.user?.phone;
  const helperName  = helper.organization || helper.user?.display_name || 'Helper';

  if (!phone) return { error: `${helperName} has no phone number on file.` };

  // Send SMS
  try {
    const from = process.env.TWILIO_PHONE_NUMBER;
    if (!from) throw new Error('TWILIO_PHONE_NUMBER not set');
    const sms = `[BridgeUp AI]\n${message.slice(0, 300)}\n\nReply or visit bridgeup.app to respond.`;
    await twilioClient.messages.create({ to: phone, from, body: sms });
  } catch (smsErr) {
    return { error: `SMS failed: ${smsErr.message}` };
  }

  // Create a match record
  let matchId = null;
  if (needId) {
    const { data: match } = await supabase
      .from('matches')
      .insert({
        need_id:   needId,
        helper_id: helperId,
        status:    'pending',
        score:     80,
        notes:     'Initiated by Bridge AI agent',
      })
      .select('id')
      .single();
    if (match) matchId = match.id;
  }

  return { success: true, helperName, matchId };
}

async function toolCompleteTask({ needId, matchId, summary, outcome }) {
  const finalStatus = outcome === 'resolved' ? 'resolved' : outcome === 'referred' ? 'closed' : 'in_progress';

  await supabase.from('needs').update({
    status:     finalStatus,
    updated_at: new Date().toISOString(),
  }).eq('id', needId).catch(() => {});

  if (matchId) {
    await supabase.from('matches').update({
      status:      outcome === 'resolved' ? 'resolved' : 'in_progress',
      notes:       summary.slice(0, 1000),
      resolved_at: outcome === 'resolved' ? new Date().toISOString() : null,
    }).eq('id', matchId).catch(() => {});
  }

  return { success: true, summary, completedAt: new Date().toISOString(), outcome };
}

// ─── Main handler ─────────────────────────────────────────────────────────────
module.exports = handler(async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const claims = await optionalAuth(req).catch(() => null);
  const userId = claims?.userId || null;

  const { sessionId, message } = req.body || {};
  if (!sessionId || !message)
    return res.status(400).json({ error: 'sessionId and message are required.' });
  if (typeof message !== 'string' || message.length > 2000)
    return res.status(400).json({ error: 'Message too long.' });

  // Load conversation history
  const { data: session } = await supabase
    .from('sms_conversations')
    .select('*')
    .eq('phone', 'agent_' + sessionId)
    .maybeSingle();

  const history = session?.conversation_history || [];
  const messages = [...history, { role: 'user', content: message.trim() }];

  let ai;
  try {
    ai = getAI();
  } catch {
    return res.status(503).json({ error: 'AI service not configured. Set ANTHROPIC_API_KEY in Vercel and redeploy.' });
  }

  let finalReply  = null;
  let actionType  = null;
  let actionData  = null;

  // Use confirmed-working 3.5 Haiku first; try 4.5 if available
  const MODELS = ['claude-3-5-haiku-20241022', 'claude-haiku-4-5-20251001'];

  async function callAI(msgs) {
    for (const model of MODELS) {
      try {
        const r = await ai.messages.create({
          model, max_tokens: 512, system: SYSTEM, tools: TOOLS,
          messages: msgs.slice(-14),
        });
        return r;
      } catch (err) {
        // model not found or not accessible → try next
        if (err.status === 404 || err.status === 400) continue;
        throw err; // other errors (auth, rate-limit) propagate
      }
    }
    throw new Error('No available AI model.');
  }

  // Vercel Hobby caps functions at 10s; allow max 2 rounds with a 7s wall-clock guard
  const agentStart = Date.now();
  for (let round = 0; round < 2; round++) {
    if (Date.now() - agentStart > 7000) {
      finalReply = "I'm still processing your request. Please send your message again.";
      break;
    }
    let response;
    try {
      response = await callAI(messages);
    } catch (aiErr) {
      console.error('[agent] AI call failed:', aiErr.status, aiErr.message);
      finalReply = aiErr.status === 429
        ? "I'm getting a lot of requests right now — please try again in a moment."
        : "I couldn't connect to the AI service. Please use the form instead.";
      break;
    }

    if (response.stop_reason === 'end_turn') {
      finalReply = response.content.find(b => b.type === 'text')?.text || '';
      break;
    }

    if (response.stop_reason === 'tool_use') {
      const toolUses   = response.content.filter(b => b.type === 'tool_use');
      const toolResults = [];

      for (const tu of toolUses) {
        let result;
        try {
          if      (tu.name === 'search_helpers') result = await toolSearchHelpers(tu.input);
          else if (tu.name === 'create_need')    result = await toolCreateNeed(tu.input, userId);
          else if (tu.name === 'contact_helper') result = await toolContactHelper(tu.input);
          else if (tu.name === 'complete_task')  result = await toolCompleteTask(tu.input);
          else result = { error: 'Unknown tool: ' + tu.name };
        } catch (err) {
          result = { error: err.message };
        }

        // Track the most important frontend action
        if (tu.name === 'search_helpers' && result.helpers?.length > 0 && !actionType) {
          actionType = 'helpers_found';
          actionData = result.helpers;
        } else if (tu.name === 'create_need' && result.needId) {
          actionType = 'need_created';
          actionData = { needId: result.needId };
        } else if (tu.name === 'contact_helper' && result.success) {
          actionType = 'helper_contacted';
          actionData = { matchId: result.matchId, helperName: result.helperName };
        } else if (tu.name === 'complete_task' && result.success) {
          actionType = 'task_complete';
          actionData = { summary: result.summary, completedAt: result.completedAt, outcome: result.outcome };
        }

        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) });
      }

      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user',      content: toolResults });
    }
  }

  if (!finalReply) {
    finalReply = 'I\'m working on your request. Could you give me a little more detail so I can find the best help?';
  }

  // Persist conversation
  const updatedHistory = [...messages, { role: 'assistant', content: finalReply }];
  await supabase.from('sms_conversations').upsert({
    phone:                'agent_' + sessionId,
    step:                 actionType === 'task_complete' ? 'complete' : 'active',
    conversation_history: updatedHistory.slice(-20),
    updated_at:           new Date().toISOString(),
  }).catch(() => {});

  res.json({ reply: finalReply, action: actionType, data: actionData });
});
