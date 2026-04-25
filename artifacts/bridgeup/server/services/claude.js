'use strict';

const Anthropic = require('@anthropic-ai/sdk');

// ─── Lazy client — accepts ANTHROPIC_API_KEY or CLAUDE_API_KEY ───────────────
let _client = null;
function getClient() {
  if (_client) return _client;
  const key = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
  if (!key) throw Object.assign(new Error('Set ANTHROPIC_API_KEY in Vercel environment variables.'), { status: 503 });
  _client = new Anthropic({ apiKey: key });
  return _client;
}

const MODEL = 'claude-sonnet-4-6';

// Request timeout — 30 seconds per spec requirement (Twilio voice needs < 10s)
const TIMEOUT_MS = 30_000;

// ─── System prompts ───────────────────────────────────────────────────────────

/**
 * System prompt for TEXT need intake (max 3 follow-up questions).
 * Claude auto-detects language from the user's first message and responds
 * in that same language for the entire conversation.
 */
const TEXT_INTAKE_SYSTEM = `You are BridgeUp's compassionate intake assistant helping people in need find verified help in their community. BridgeUp connects people in crisis with helpers for food, housing, employment, medical care, training, and funding.

LANGUAGE: Detect the user's language from their very first message. Respond ONLY in that same language for the entire conversation. Never switch languages. Fully supported: English, Spanish (all Latin American dialects — Mexican, Colombian, Argentine, Peruvian, Venezuelan, Chilean, and all others), French, Kinyarwanda, Swahili, Arabic, Portuguese, Amharic, Hausa, Yoruba, Igbo, Zulu, Somali, Tigrinya, and 80+ others. For Spanish speakers: always respond in Spanish regardless of which country they are in.

YOUR TASK: Gather the three essential pieces of information needed to match this person with a helper:
1. What type of help they need (food, housing, employment, medical, training, funding, other)
2. Where they are located (city, district, neighborhood — be specific but accepting of informal names)
3. How urgent the situation is (immediate crisis, within days, within weeks)

RULES:
- Ask a maximum of 3 follow-up questions total. After 3 exchanges or once you have all three pieces, confirm back what you understood and end with a clear summary object.
- Ask only ONE question per message. Never ask two questions at once.
- Be warm, non-judgmental, and brief. Users may be in crisis.
- NEVER invent, suggest, or mention specific helpers, organizations, phone numbers, or addresses. You are gathering information only — matching happens separately.
- NEVER ask for personal identity information (name, ID number, income).
- If the situation sounds like an immediate life-threatening emergency, gently direct them to emergency services first.
- When you have all three pieces of information, end your response with a JSON block EXACTLY in this format:
  <INTAKE_COMPLETE>
  {"category":"food|housing|employment|medical|training|funding|other","location":"exact location string","urgency":"immediate|days|weeks","summary":"one sentence plain language summary in the user's language","detectedLanguage":"ISO 639-1 code e.g. en, fr, rw, sw"}
  </INTAKE_COMPLETE>`;

/**
 * System prompt for VOICE need intake (max 5 conversational turns).
 * Simpler language, shorter responses, explicit confirmation of understanding.
 * Per spec: user may be zero-literacy — every response will be read aloud via TTS.
 */
const VOICE_INTAKE_SYSTEM = `You are BridgeUp's voice assistant helping someone who cannot read or write. Everything you say will be spoken aloud to them. They are speaking to you and listening to your response.

LANGUAGE: Detect the language from the very first words the user speaks. Respond ONLY in that same language. Never use a different language. Never switch.

HOW TO SPEAK:
- Use simple, warm, conversational words — like talking to a neighbor, not a form
- Keep each response under 3 sentences maximum
- Ask only ONE question at a time
- Always confirm back what you understood before asking the next question
- Use numbers and simple references, never acronyms or technical terms
- Never say "I understand you need..." — say "OK, so you need..." or the local equivalent

YOUR TASK: Learn three things through friendly conversation (maximum 5 turns):
1. What kind of help they need
2. Where they are
3. How urgent it is

RULES:
- Maximum 5 conversational turns. After turn 5 or once you have all info, summarize and close.
- NEVER invent helpers, organizations, phone numbers, or addresses.
- If life-threatening emergency: one clear sentence directing to emergency services, then continue intake.
- When complete, end with:
  <INTAKE_COMPLETE>
  {"category":"food|housing|employment|medical|training|funding|other","location":"location string","urgency":"immediate|days|weeks","summary":"one sentence summary in user's language","detectedLanguage":"ISO 639-1 code","mode":"voice"}
  </INTAKE_COMPLETE>`;

/**
 * System prompt for AI assistants (Admin, Management, Donor roles).
 * Answers natural language questions using live Firestore data passed in context.
 */
function buildAssistantSystemPrompt(role, currentDate) {
  const roleContext = {
    admin: `You are the BridgeUp Admin AI Assistant. You help platform administrators understand their tenant's operations, approve helpers, review flagged accounts, and manage daily platform health. You have access to live platform data provided below.`,
    management: `You are the BridgeUp Management AI Assistant. You help executives and management teams understand strategic KPIs, growth trends, and impact metrics to make informed decisions. You have access to live platform data provided below.`,
    donor: `You are the BridgeUp Donor AI Assistant. You help donors understand how their contributions are being used, the geographic reach of impact, and the outcomes achieved with funding. You have access to live platform data provided below.`,
    superadmin: `You are the BridgeUp Super Admin AI Assistant. You have visibility across all tenants, system health, and global revenue metrics. You have access to live platform data provided below.`,
  };

  return `${roleContext[role] || roleContext.admin}

CURRENT DATE: ${currentDate}

RULES:
- Answer only what the data supports. If the data does not contain the answer, say so clearly.
- NEVER fabricate numbers, names, or outcomes not present in the data.
- Use plain language — write as if explaining to a smart non-technical person.
- Keep answers concise (under 200 words unless a detailed breakdown is requested).
- When referencing numbers, round to the nearest whole number unless precision matters.
- Highlight any concerning trends or anomalies proactively if visible in the data.
- Do not mention the internal data structure or field names — translate them into human language.
- Respond in the same language the user asked the question in.`;
}

// ─── Helper: extract INTAKE_COMPLETE block from Claude response ───────────────
function extractIntakeResult(content) {
  const match = content.match(/<INTAKE_COMPLETE>\s*([\s\S]*?)\s*<\/INTAKE_COMPLETE>/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

// ─── Helper: strip INTAKE_COMPLETE block from spoken/displayed text ───────────
function stripIntakeBlock(content) {
  return content.replace(/<INTAKE_COMPLETE>[\s\S]*?<\/INTAKE_COMPLETE>/g, '').trim();
}

// ─── Core Claude call with timeout ───────────────────────────────────────────
async function callClaude({ system, messages, maxTokens = 512 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await getClient().messages.create(
      {
        model: MODEL,
        max_tokens: maxTokens,
        system,
        messages,
      },
      { signal: controller.signal }
    );
    return response.content[0]?.text ?? '';
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Claude response timed out after 30 seconds.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ─── PUBLIC FUNCTION 1: processNeed ──────────────────────────────────────────
/**
 * Drives the AI-powered need intake conversation — both text and voice modes.
 *
 * @param {Object[]} conversationHistory
 *   Array of { role: 'user'|'assistant', content: string } messages.
 *   Pass the full history so Claude maintains context across turns.
 *
 * @param {'text'|'voice'} mode
 *   'text' — up to 3 follow-up questions, standard response length
 *   'voice' — up to 5 turns, ≤3 sentences per response (for TTS playback)
 *
 * @returns {Promise<{
 *   reply: string,           — Claude's response (stripped of internal markers)
 *   isComplete: boolean,     — true when intake is finished
 *   intakeData: Object|null  — parsed intake result when isComplete is true
 * }>}
 */
async function processNeed(conversationHistory, mode = 'text') {
  if (!Array.isArray(conversationHistory) || conversationHistory.length === 0) {
    throw new Error('conversationHistory must be a non-empty array.');
  }

  const system = mode === 'voice' ? VOICE_INTAKE_SYSTEM : TEXT_INTAKE_SYSTEM;
  // Voice responses must be short enough for Twilio TTS — 150 tokens ≈ 3 sentences
  const maxTokens = mode === 'voice' ? 150 : 512;

  const rawReply = await callClaude({
    system,
    messages: conversationHistory,
    maxTokens,
  });

  const intakeData = extractIntakeResult(rawReply);
  const reply = stripIntakeBlock(rawReply);

  return {
    reply,
    isComplete: intakeData !== null,
    intakeData,
  };
}

// ─── PUBLIC FUNCTION 2: generateReportSummary ─────────────────────────────────
/**
 * Generates a plain-language narrative summary for any of the 7 report types.
 * Called from the reports route after aggregating live Firestore data.
 *
 * @param {string} reportType
 *   One of: 'needs_impact' | 'helper_performance' | 'geographic_coverage' |
 *           'donor_ngo_impact' | 'financial_grant' | 'compliance' | 'sms_feature_phone'
 *
 * @param {Object} reportData
 *   The aggregated report data object from Firestore. Claude uses this as context.
 *   Must be serialisable to JSON.
 *
 * @param {Object} [options]
 * @param {string} [options.language='en']   ISO 639-1 code for output language
 * @param {string} [options.dateRange]       Human-readable date range string
 * @param {string} [options.tenantName]      Organisation name for personalisation
 *
 * @returns {Promise<string>} Plain-language narrative summary (200–400 words)
 */
async function generateReportSummary(reportType, reportData, options = {}) {
  const { language = 'en', dateRange = 'the selected period', tenantName = 'your organisation' } = options;

  const reportLabels = {
    needs_impact:        'Needs & Impact Report',
    helper_performance:  'Helper Performance Report',
    geographic_coverage: 'Geographic Coverage Report',
    donor_ngo_impact:    'Donor & NGO Impact Report',
    financial_grant:     'Financial & Grant Readiness Report',
    compliance:          'Compliance & Data Governance Report',
    sms_feature_phone:   'SMS & Feature Phone Report',
  };

  const reportLabel = reportLabels[reportType] || 'Platform Report';

  const system = `You are BridgeUp's report analyst. You write clear, plain-language narrative summaries of platform performance data for ${tenantName}. Your audience is decision-makers who are not data scientists — they need insight, not raw numbers.

LANGUAGE: Write the summary in the language with ISO code "${language}". Fully supported output languages include English, Spanish (all regional variants — use neutral Latin American Spanish for 'es'), French, Kinyarwanda, Swahili, Arabic, Portuguese, and all other languages Claude supports. Never default to English if a different language is specified.

RULES:
- Write 3–5 short paragraphs (200–400 words total)
- Lead with the most important finding — what stands out most?
- Use plain language — avoid jargon, acronyms, or technical database terms
- Round numbers for readability (e.g. "about 1,200" not "1,247.3")
- Highlight both successes and areas needing attention
- End with 2–3 concrete, actionable recommendations based on the data
- NEVER fabricate numbers or trends not present in the data provided
- If data is sparse, acknowledge it honestly`;

  const userMessage = `Please write a plain-language narrative summary for the ${reportLabel} covering ${dateRange}.

Here is the live data from the platform:
${JSON.stringify(reportData, null, 2)}`;

  const summary = await callClaude({
    system,
    messages: [{ role: 'user', content: userMessage }],
    maxTokens: 1024,
  });

  return summary;
}

// ─── PUBLIC FUNCTION 3: answerAdminQuestion ───────────────────────────────────
/**
 * Powers the AI Assistant available to Admin, Management, Donor, and Super Admin roles.
 * Accepts a natural language question and live Firestore data snapshot, returns an answer.
 *
 * @param {string} question
 *   The user's natural language question, e.g. "How many helpers are pending approval?"
 *
 * @param {Object} firestoreData
 *   A curated snapshot of relevant Firestore data. The calling route should
 *   fetch only the collections relevant to the question (don't pass everything).
 *   Example: { pendingHelpers: [...], recentNeeds: [...], weeklyStats: {...} }
 *
 * @param {'admin'|'management'|'donor'|'superadmin'} role
 *   The role of the user asking the question — controls what context/tone Claude uses.
 *
 * @param {Object} [options]
 * @param {string} [options.language='en']  ISO 639-1 code — Claude responds in this language
 * @param {Object[]} [options.history=[]]   Prior messages in this session for multi-turn support
 *
 * @returns {Promise<string>} Claude's plain-language answer
 */
async function answerAdminQuestion(question, firestoreData, role = 'admin', options = {}) {
  const { language = 'en', history = [] } = options;

  if (!question || typeof question !== 'string') {
    throw new Error('question must be a non-empty string.');
  }

  const currentDate = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  const system = buildAssistantSystemPrompt(role, currentDate);

  // Build messages: prior history + the data context + the user question
  const dataContext = `Here is the current live platform data relevant to your question:\n${JSON.stringify(firestoreData, null, 2)}`;

  const messages = [
    // Inject data as the first user turn so Claude treats it as ground truth
    { role: 'user', content: dataContext },
    { role: 'assistant', content: `I have reviewed the current platform data. I am ready to answer your questions. Please ask me anything about your platform.` },
    // Any prior conversation turns in this session
    ...history,
    // The actual question
    { role: 'user', content: `${question}\n\n(Please respond in the language with ISO code: ${language})` },
  ];

  const answer = await callClaude({
    system,
    messages,
    maxTokens: 768,
  });

  return answer;
}

// ─── PUBLIC FUNCTION 4: detectLanguage ───────────────────────────────────────
/**
 * Detects the language of a given text string.
 * Used by SMS and voice routes to route responses correctly.
 *
 * @param {string} text - The text whose language should be detected
 * @returns {Promise<{ language: string, confidence: 'high'|'medium'|'low', iso: string }>}
 */
async function detectLanguage(text) {
  const response = await callClaude({
    system: 'You are a language detection tool. Respond ONLY with a JSON object, nothing else.',
    messages: [
      {
        role: 'user',
        content: `Detect the language of this text. Return ONLY valid JSON in this exact format:
{"language":"full language name in English","iso":"ISO 639-1 two-letter code","confidence":"high|medium|low"}

Text to detect:
${text}`,
      },
    ],
    maxTokens: 64,
  });

  try {
    return JSON.parse(response);
  } catch {
    return { language: 'English', iso: 'en', confidence: 'low' };
  }
}

// ─── PUBLIC FUNCTION 5: generateTwilioResponse ───────────────────────────────
/**
 * Generates a voice IVR response for Twilio — optimised for Twilio's TTS engine.
 * Responses must be short (Twilio has a <10 second processing budget per spec).
 *
 * @param {string} transcription   — What Twilio heard the caller say
 * @param {Object[]} callHistory   — Prior turns in this call { role, content }
 * @param {string} callerCountry   — ISO country code from Twilio (e.g. 'RW', 'KE', 'US')
 * @returns {Promise<{ twimlText: string, isComplete: boolean, intakeData: Object|null }>}
 */
async function generateTwilioResponse(transcription, callHistory, callerCountry) {
  // Country-to-language defaults (overridden by Claude's auto-detection)
  const countryLanguage = {
    // Africa — East
    RW: 'Kinyarwanda', KE: 'Swahili',  TZ: 'Swahili',
    UG: 'English',     NG: 'English',  GH: 'English',
    // Africa — West / Central / North
    SN: 'French',      CI: 'French',   CM: 'French',
    MA: 'Arabic',      EG: 'Arabic',
    // North America / Europe
    CA: 'English',     US: 'English',  GB: 'English',
    FR: 'French',
    // Spanish-speaking Latin America (all 19 countries)
    MX: 'Spanish',     ES: 'Spanish',  CO: 'Spanish',
    AR: 'Spanish',     PE: 'Spanish',  VE: 'Spanish',
    CL: 'Spanish',     EC: 'Spanish',  GT: 'Spanish',
    CU: 'Spanish',     BO: 'Spanish',  DO: 'Spanish',
    HN: 'Spanish',     PY: 'Spanish',  SV: 'Spanish',
    NI: 'Spanish',     CR: 'Spanish',  PA: 'Spanish',
    UY: 'Spanish',
    // Equatorial Guinea — Spanish official language in Africa
    GQ: 'Spanish',
  };

  const expectedLanguage = countryLanguage[callerCountry] || 'English';

  const twilioSystem = `${VOICE_INTAKE_SYSTEM}

TWILIO VOICE CONSTRAINT: You are speaking through a phone call. The caller is on a feature phone with no internet. Keep your response to 1–2 sentences MAXIMUM. Short sentences. Simple words. Speak naturally, as you would on a phone call.

The caller appears to be calling from a ${expectedLanguage}-speaking country. Confirm the language from what they actually say and use that language.`;

  const messages = [
    ...callHistory,
    { role: 'user', content: transcription },
  ];

  const rawReply = await callClaude({
    system: twilioSystem,
    messages,
    maxTokens: 100, // Very short — Twilio needs fast response
  });

  const intakeData = extractIntakeResult(rawReply);
  const twimlText = stripIntakeBlock(rawReply);

  return {
    twimlText,
    isComplete: intakeData !== null,
    intakeData,
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
  processNeed,
  generateReportSummary,
  answerAdminQuestion,
  detectLanguage,
  generateTwilioResponse,
  MODEL,
};
