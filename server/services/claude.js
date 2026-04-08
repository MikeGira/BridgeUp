const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

async function processNeed(userMessage, conversationHistory, userLocation, language) {
  const systemPrompt = `You are BridgeUp's compassionate AI assistant. Your job is to help people in need find real verified helpers near them. 

You ask maximum 3 follow-up questions to understand:
1. What specifically do they need (food, job, housing, medical, training, funding, legal, other)
2. Their exact location (confirm or correct: ${userLocation})
3. How urgent (emergency now, within 24 hours, within a week, flexible)

Rules:
- Respond in the user's language: ${language}
- Never invent fictional helpers or resources
- Be warm, simple, and jargon-free — basic literacy level
- If no match exists, say honestly: "We don't have a verified helper in your area yet. We've recorded your request and will notify you when one is available."
- Keep responses short — 2 to 3 sentences maximum`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    system: systemPrompt,
    messages: conversationHistory
  });

  return response.content[0].text;
}

async function generateReportSummary(reportData, reportType) {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 800,
    messages: [{
      role: 'user',
      content: `You are BridgeUp's data analyst. Write a 3-sentence plain language summary of this ${reportType} data that any non-technical person can understand. Include what is working well, what needs attention, and one recommended action. Data: ${JSON.stringify(reportData)}`
    }]
  });

  return response.content[0].text;
}

async function answerAdminQuestion(question, platformData) {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 600,
    messages: [{
      role: 'user',
      content: `You are BridgeUp's admin AI assistant. Answer this question using the platform data provided. Be specific and data-driven. Question: "${question}". Platform data: ${JSON.stringify(platformData)}`
    }]
  });

  return response.content[0].text;
}

module.exports = { processNeed, generateReportSummary, answerAdminQuestion };