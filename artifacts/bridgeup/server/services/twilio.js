'use strict';

const twilio = require('twilio');
const { db, FieldValue, COLLECTIONS } = require('./firebase');
const { processNeed, detectLanguage } = require('./claude');

// ─── Guard: fail fast if credentials are missing ──────────────────────────────
const REQUIRED_VARS = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'];
for (const v of REQUIRED_VARS) {
  if (!process.env[v]) {
    console.error(`[Twilio] FATAL: ${v} environment variable is not set.`);
    process.exit(1);
  }
}

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ─── Phone number pool (one per country as per spec) ──────────────────────────
// Falls back to the generic number if a country-specific one isn't configured.
const PHONE_NUMBERS = {
  RW: process.env.TWILIO_RWANDA_NUMBER,   // +250 Rwanda
  KE: process.env.TWILIO_KENYA_NUMBER,    // +254 Kenya
  US: process.env.TWILIO_CANADA_NUMBER,   // +1  Canada / USA
  CA: process.env.TWILIO_CANADA_NUMBER,
  DEFAULT: process.env.TWILIO_PHONE_NUMBER,
};

/**
 * Picks the best outbound number for a given destination phone number.
 * Matches on E.164 country calling code prefix.
 */
function pickFromNumber(toPhone) {
  if (toPhone.startsWith('+250') && PHONE_NUMBERS.RW) return PHONE_NUMBERS.RW;
  if (toPhone.startsWith('+254') && PHONE_NUMBERS.KE) return PHONE_NUMBERS.KE;
  if (toPhone.startsWith('+1')   && PHONE_NUMBERS.US) return PHONE_NUMBERS.US;
  return PHONE_NUMBERS.DEFAULT;
}

/**
 * Returns the ISO country code from an E.164 phone number.
 * Covers the countries explicitly mentioned in the spec.
 */
function countryCodeFromPhone(phone) {
  if (phone.startsWith('+250')) return 'RW';
  if (phone.startsWith('+254')) return 'KE';
  if (phone.startsWith('+255')) return 'TZ';
  if (phone.startsWith('+256')) return 'UG';
  if (phone.startsWith('+234')) return 'NG';
  if (phone.startsWith('+233')) return 'GH';
  if (phone.startsWith('+221')) return 'SN';
  if (phone.startsWith('+225')) return 'CI';
  if (phone.startsWith('+237')) return 'CM';
  if (phone.startsWith('+212')) return 'MA';
  if (phone.startsWith('+20'))  return 'EG';
  if (phone.startsWith('+1'))   return 'US';
  if (phone.startsWith('+44'))  return 'GB';
  if (phone.startsWith('+33'))  return 'FR';
  return 'US';
}

// ─── OTP configuration ────────────────────────────────────────────────────────
const OTP_EXPIRY_MS = 5 * 60 * 1000;   // 5 minutes
const OTP_LENGTH    = 6;
const OTP_MAX_ATTEMPTS = 3;

// ─── SMS conversation step definitions (7-step flow) ─────────────────────────
// Each step defines the bot's prompt in every supported language.
// Claude handles the actual conversation but these are the structured fallbacks
// when Claude is unavailable or for the initial greeting.
const STEP_GREETINGS = {
  en: 'Welcome to BridgeUp. I can help connect you with food, housing, jobs, medical care, or training. What kind of help do you need?',
  fr: 'Bienvenue sur BridgeUp. Je peux vous mettre en contact avec de la nourriture, un logement, des emplois, des soins médicaux ou une formation. De quel type d\'aide avez-vous besoin?',
  rw: 'Murakaza neza kuri BridgeUp. Nshobora gufasha guhuza n\'intoraampamvu, aho gutura, akazi, ubuvuzi, cyangwa amahugurwa. Ni ubwoko bwuhe bw\'ubufasha ukeneye?',
  sw: 'Karibu BridgeUp. Ninaweza kukusaidia kupata chakula, makazi, kazi, huduma ya afya, au mafunzo. Unahitaji msaada wa aina gani?',
  ar: 'مرحباً بك في BridgeUp. يمكنني مساعدتك في الحصول على طعام أو مسكن أو وظائف أو رعاية طبية أو تدريب. ما نوع المساعدة التي تحتاجها؟',
  es: 'Bienvenido a BridgeUp. Puedo ayudarte a conectarte con alimentos, vivienda, empleos, atención médica o capacitación. ¿Qué tipo de ayuda necesitas?',
};

const SMS_CONVERSATION_STEPS = {
  NEW:       'new',
  GREETING:  'greeting',    // Step 1: Sent welcome, awaiting need type
  LOCATION:  'location',    // Step 2: Have need type, asking location
  URGENCY:   'urgency',     // Step 3: Have location, asking urgency
  CONFIRM:   'confirm',     // Step 4: Confirming all details
  MATCHING:  'matching',    // Step 5: Running matching engine
  MATCHED:   'matched',     // Step 6: Sent helper details
  COMPLETE:  'complete',    // Step 7: Conversation closed
  FAILED:    'failed',
};

// ─── PUBLIC FUNCTION 1: sendSMS ───────────────────────────────────────────────
/**
 * Sends an outbound SMS message via Twilio.
 *
 * @param {string} to      E.164 formatted destination number (e.g. '+250788123456')
 * @param {string} body    Message text (max 1600 chars; will be split by Twilio if longer)
 * @param {string} [from]  Override the from number (optional — auto-selected by default)
 * @returns {Promise<{ sid: string, status: string }>}
 */
async function sendSMS(to, body, from) {
  const fromNumber = from || pickFromNumber(to);

  if (!fromNumber) {
    throw new Error(
      `[Twilio] No outbound phone number configured for destination ${to}. ` +
      'Set TWILIO_PHONE_NUMBER in Replit Secrets.'
    );
  }

  const message = await twilioClient.messages.create({ to, from: fromNumber, body });

  console.log(`[Twilio] SMS sent to ${to} | SID: ${message.sid} | Status: ${message.status}`);
  return { sid: message.sid, status: message.status };
}

// ─── PUBLIC FUNCTION 2: sendOTP ───────────────────────────────────────────────
/**
 * Generates a 6-digit OTP, stores it in Firestore with a 5-minute TTL,
 * and sends it via SMS to the given phone number.
 *
 * @param {string} phone   E.164 phone number
 * @returns {Promise<{ success: boolean, expiresAt: Date }>}
 */
async function sendOTP(phone) {
  // Generate cryptographically random 6-digit code
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MS);

  // Upsert OTP record — one record per phone, overwriting any previous code
  await db.collection('otp_codes').doc(phone).set({
    code,
    phone,
    expiresAt,
    attempts: 0,
    verified: false,
    createdAt: FieldValue.serverTimestamp(),
  });

  // Detect country to send appropriate language message
  const country = countryCodeFromPhone(phone);
  const messages = {
    RW: `Kode yanyu ya BridgeUp ni: ${code}. Igihe irinda: iminota 5.`,
    KE: `Nambari yako ya uthibitisho wa BridgeUp ni: ${code}. Inaisha baada ya dakika 5.`,
    DEFAULT: `Your BridgeUp verification code is: ${code}. Expires in 5 minutes. Do not share this code.`,
  };
  const smsBody = messages[country] || messages.DEFAULT;

  await sendSMS(phone, smsBody);

  return { success: true, expiresAt };
}

// ─── PUBLIC FUNCTION 3: verifyOTP ─────────────────────────────────────────────
/**
 * Verifies an OTP code submitted by the user against the stored Firestore record.
 *
 * @param {string} phone  E.164 phone number
 * @param {string} code   The code the user submitted
 * @returns {Promise<{ valid: boolean, reason?: string }>}
 */
async function verifyOTP(phone, code) {
  const ref  = db.collection('otp_codes').doc(phone);
  const snap = await ref.get();

  if (!snap.exists) {
    return { valid: false, reason: 'No verification code found for this number. Please request a new one.' };
  }

  const data = snap.data();

  if (data.verified) {
    return { valid: false, reason: 'This code has already been used. Please request a new one.' };
  }

  if (data.attempts >= OTP_MAX_ATTEMPTS) {
    return { valid: false, reason: 'Too many incorrect attempts. Please request a new code.' };
  }

  if (new Date() > data.expiresAt.toDate()) {
    return { valid: false, reason: 'This code has expired. Please request a new one.' };
  }

  if (data.code !== String(code).trim()) {
    // Increment failed attempts
    await ref.update({ attempts: FieldValue.increment(1) });
    const remaining = OTP_MAX_ATTEMPTS - (data.attempts + 1);
    return { valid: false, reason: `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.` };
  }

  // Mark as verified and clean up
  await ref.update({ verified: true, verifiedAt: FieldValue.serverTimestamp() });

  return { valid: true };
}

// ─── INTERNAL: load or create SMS conversation state from Firestore ───────────
async function getConversationState(phone) {
  const ref  = db.collection(COLLECTIONS.SMS_QUEUE).doc(phone);
  const snap = await ref.get();

  if (!snap.exists) {
    return { ref, state: null };
  }

  return { ref, state: snap.data() };
}

// ─── INTERNAL: save conversation state ────────────────────────────────────────
async function saveConversationState(ref, updates) {
  await ref.set(
    { ...updates, updatedAt: FieldValue.serverTimestamp() },
    { merge: true }
  );
}

// ─── PUBLIC FUNCTION 4: processSMSConversation ───────────────────────────────
/**
 * Handles a single inbound SMS from a feature phone, advancing the 7-step
 * conversation state machine. State is persisted in Firestore so conversations
 * survive server restarts and work across multiple messages.
 *
 * Step 1 — NEW/GREETING  : Detect language, send welcome, ask need type
 * Step 2 — LOCATION      : Have need type, ask for location
 * Step 3 — URGENCY       : Have location, ask urgency level
 * Step 4 — CONFIRM       : Summarise and confirm details with user
 * Step 5 — MATCHING      : Trigger matching engine (async), inform user
 * Step 6 — MATCHED       : Return helper contact details via SMS
 * Step 7 — COMPLETE      : Close conversation, offer to start again
 *
 * @param {string} fromPhone   E.164 number of the sender
 * @param {string} messageBody Raw SMS body text
 * @returns {Promise<{ reply: string, step: string }>}
 */
async function processSMSConversation(fromPhone, messageBody) {
  const { ref, state } = await getConversationState(fromPhone);
  const body = messageBody.trim();
  const country = countryCodeFromPhone(fromPhone);

  // ── STEP 1: New conversation or user typed RESTART/START/HELLO ─────────────
  const isReset = /^(start|restart|help|hello|hi|salut|bonjour|habari|muraho|مرحبا)$/i.test(body);

  if (!state || state.step === SMS_CONVERSATION_STEPS.COMPLETE || isReset) {
    // Detect language from their first message (async — fall back to country default)
    let detectedLang = 'en';
    try {
      const langResult = await detectLanguage(body);
      detectedLang = langResult.iso || 'en';
    } catch {
      // Fallback map
      const countryLang = { RW: 'rw', KE: 'sw', TZ: 'sw', SN: 'fr', CI: 'fr', MA: 'ar', EG: 'ar' };
      detectedLang = countryLang[country] || 'en';
    }

    const greeting = STEP_GREETINGS[detectedLang] || STEP_GREETINGS.en;

    await saveConversationState(ref, {
      phone: fromPhone,
      country,
      language: detectedLang,
      step: SMS_CONVERSATION_STEPS.GREETING,
      conversationHistory: [
        { role: 'user', content: body },
        { role: 'assistant', content: greeting },
      ],
      intakeData: null,
      createdAt: FieldValue.serverTimestamp(),
    });

    return { reply: greeting, step: SMS_CONVERSATION_STEPS.GREETING };
  }

  // ── STEPS 2–4: Active intake conversation — hand off to Claude ────────────
  if ([
    SMS_CONVERSATION_STEPS.GREETING,
    SMS_CONVERSATION_STEPS.LOCATION,
    SMS_CONVERSATION_STEPS.URGENCY,
    SMS_CONVERSATION_STEPS.CONFIRM,
  ].includes(state.step)) {
    const history = [
      ...(state.conversationHistory || []),
      { role: 'user', content: body },
    ];

    let claudeResult;
    try {
      claudeResult = await processNeed(history, 'text');
    } catch (err) {
      console.error('[Twilio SMS] Claude error:', err.message);
      const fallback = {
        en: 'Sorry, I had trouble understanding that. Could you try again?',
        rw: 'Mbabarira, nanze gusobanukirwa ubwo. Ongera ugerageze?',
        sw: 'Samahani, sikuelewa vizuri. Jaribu tena?',
        fr: 'Désolé, je n\'ai pas compris. Pouvez-vous réessayer?',
      };
      return {
        reply: fallback[state.language] || fallback.en,
        step: state.step,
      };
    }

    const updatedHistory = [...history, { role: 'assistant', content: claudeResult.reply }];

    // Determine next step label for reporting
    const stepProgression = {
      [SMS_CONVERSATION_STEPS.GREETING]: SMS_CONVERSATION_STEPS.LOCATION,
      [SMS_CONVERSATION_STEPS.LOCATION]: SMS_CONVERSATION_STEPS.URGENCY,
      [SMS_CONVERSATION_STEPS.URGENCY]:  SMS_CONVERSATION_STEPS.CONFIRM,
      [SMS_CONVERSATION_STEPS.CONFIRM]:  SMS_CONVERSATION_STEPS.MATCHING,
    };

    const nextStep = claudeResult.isComplete
      ? SMS_CONVERSATION_STEPS.MATCHING
      : stepProgression[state.step] || state.step;

    await saveConversationState(ref, {
      step: nextStep,
      conversationHistory: updatedHistory,
      ...(claudeResult.intakeData && { intakeData: claudeResult.intakeData }),
    });

    // ── STEP 5: Intake complete — trigger matching ─────────────────────────
    if (claudeResult.isComplete) {
      // Fire-and-forget matching — result sent in follow-up SMS by matching route
      setImmediate(() => triggerSMSMatching(fromPhone, claudeResult.intakeData, state.language));

      const processingMessages = {
        en: `Got it! I'm searching for verified helpers near you now. I'll send you their contact details by SMS within a few minutes.`,
        rw: `Nababariye! Ndashaka abantu bafashwe hafi yanyu ubu. Nzaboherereza amakuru yabo kuri SMS mu minota mike.`,
        sw: `Nimeelewa! Ninatafuta wasaidizi waliothibitishwa karibu nawe sasa. Nitatuma maelezo yao kwako kwa SMS ndani ya dakika chache.`,
        fr: `Compris! Je recherche des aidants vérifiés près de chez vous maintenant. Je vous enverrai leurs coordonnées par SMS dans quelques minutes.`,
        ar: `فهمت! أبحث الآن عن مساعدين معتمدين بالقرب منك. سأرسل لك تفاصيل الاتصال بهم عبر الرسائل القصيرة في غضون دقائق.`,
      };

      const processingMsg = processingMessages[state.language] || processingMessages.en;
      return { reply: processingMsg, step: SMS_CONVERSATION_STEPS.MATCHING };
    }

    return { reply: claudeResult.reply, step: nextStep };
  }

  // ── STEP 6–7: Already matched or complete — offer restart ──────────────────
  if ([SMS_CONVERSATION_STEPS.MATCHING, SMS_CONVERSATION_STEPS.MATCHED, SMS_CONVERSATION_STEPS.COMPLETE].includes(state.step)) {
    const restartMessages = {
      en: `Your request is already being processed. Text START to begin a new request.`,
      rw: `Ubusabe bwawe burakora. Andika START gutangira ubusabe bushya.`,
      sw: `Ombi lako linashughulikiwa. Andika START kuanza ombi jipya.`,
      fr: `Votre demande est déjà en cours de traitement. Écrivez START pour une nouvelle demande.`,
    };
    return {
      reply: restartMessages[state.language] || restartMessages.en,
      step: state.step,
    };
  }

  // Fallback — unknown state
  return { reply: STEP_GREETINGS.en, step: SMS_CONVERSATION_STEPS.GREETING };
}

// ─── INTERNAL: fire-and-forget SMS matching trigger ───────────────────────────
// Called after intake is complete. The matching route handles the actual
// Firestore query and sends the follow-up SMS with helper details.
async function triggerSMSMatching(phone, intakeData, language) {
  try {
    // Write a matching request to Firestore — the matching route watches this collection
    await db.collection(COLLECTIONS.NEEDS).add({
      phone,
      ...intakeData,
      channel: 'sms',
      language,
      status: 'pending_match',
      createdAt: FieldValue.serverTimestamp(),
    });
    console.log(`[Twilio SMS] Matching triggered for ${phone} | Category: ${intakeData.category}`);
  } catch (err) {
    console.error(`[Twilio SMS] Failed to trigger matching for ${phone}:`, err.message);
  }
}

// ─── PUBLIC FUNCTION 5: sendVoiceCall (placeholder) ──────────────────────────
/**
 * Placeholder for outbound voice call notifications.
 * Future use: proactive call to helper when a new match arrives,
 * or call to person in need when their status changes.
 *
 * @param {string} to         E.164 destination number
 * @param {string} twimlUrl   URL of TwiML document to execute on the call
 * @returns {Promise<{ sid: string, status: string }>}
 */
async function sendVoiceCall(to, twimlUrl) {
  const fromNumber = pickFromNumber(to);

  if (!fromNumber) {
    throw new Error(`[Twilio] No voice number configured for destination ${to}.`);
  }

  // TODO: Implement outbound voice call notifications
  // This will be used for:
  //   - Notifying a helper of a new match (calls their number, plays TwiML)
  //   - Proactive status update calls to persons in need
  //   - Scheduled reminder calls for follow-up and review requests
  console.log(`[Twilio] sendVoiceCall placeholder: would call ${to} with TwiML from ${twimlUrl}`);

  // Uncomment when outbound voice is ready:
  // const call = await twilioClient.calls.create({ to, from: fromNumber, url: twimlUrl });
  // return { sid: call.sid, status: call.status };

  return { sid: 'placeholder', status: 'queued' };
}

// ─── EXPORT ───────────────────────────────────────────────────────────────────
module.exports = {
  sendSMS,
  sendOTP,
  verifyOTP,
  processSMSConversation,
  sendVoiceCall,
  pickFromNumber,
  countryCodeFromPhone,
  SMS_CONVERSATION_STEPS,
};
