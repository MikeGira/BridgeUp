'use strict';

const twilio = require('twilio');
const { supabase, TABLES } = require('./supabase');
const { processNeed, detectLanguage } = require('./claude');

let _twilioClient = null;
function getTwilio() {
  if (_twilioClient) return _twilioClient;
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    throw Object.assign(new Error('Twilio credentials not configured. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN in Vercel environment variables.'), { status: 503 });
  }
  _twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID.trim(), process.env.TWILIO_AUTH_TOKEN.trim());
  return _twilioClient;
}

const PHONE_NUMBERS = {
  RW: process.env.TWILIO_RWANDA_NUMBER,
  KE: process.env.TWILIO_KENYA_NUMBER,
  US: process.env.TWILIO_CANADA_NUMBER,
  CA: process.env.TWILIO_CANADA_NUMBER,
  DEFAULT: process.env.TWILIO_PHONE_NUMBER,
};

function pickFromNumber(toPhone) {
  if (toPhone.startsWith('+250') && PHONE_NUMBERS.RW) return PHONE_NUMBERS.RW;
  if (toPhone.startsWith('+254') && PHONE_NUMBERS.KE) return PHONE_NUMBERS.KE;
  if (toPhone.startsWith('+1')   && PHONE_NUMBERS.US) return PHONE_NUMBERS.US;
  return PHONE_NUMBERS.DEFAULT;
}

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

const OTP_EXPIRY_MS    = 5 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 3;

const STEP_GREETINGS = {
  en: 'Welcome to BridgeUp. I can help connect you with food, housing, jobs, medical care, or training. What kind of help do you need?',
  fr: "Bienvenue sur BridgeUp. Je peux vous mettre en contact avec de la nourriture, un logement, des emplois, des soins medicaux ou une formation. De quel type d'aide avez-vous besoin?",
  rw: 'Murakaza neza kuri BridgeUp. Nshobora gufasha guhuza intoraampamyu, aho gutura, akazi, ubuvuzi, cyangwa amahugurwa. Ni ubwoko bwuhe bw ubufasha ukeneye?',
  sw: 'Karibu BridgeUp. Ninaweza kukusaidia kupata chakula, makazi, kazi, huduma ya afya, au mafunzo. Unahitaji msaada wa aina gani?',
  ar: 'مرحبا بك في BridgeUp. يمكنني مساعدتك في الحصول على طعام او مسكن او وظائف او رعاية طبية او تدريب. ما نوع المساعدة التي تحتاجها؟',
  es: 'Bienvenido a BridgeUp. Puedo ayudarte a conectarte con alimentos, vivienda, empleos, atencion medica o capacitacion. Que tipo de ayuda necesitas?',
};

const SMS_STEPS = {
  NEW: 'new', GREETING: 'greeting', LOCATION: 'location', URGENCY: 'urgency',
  CONFIRM: 'confirm', MATCHING: 'matching', MATCHED: 'matched', COMPLETE: 'complete', FAILED: 'failed',
};

async function sendSMS(to, body, from) {
  const fromNumber = from || pickFromNumber(to);
  if (!fromNumber) throw new Error(`[Twilio] No outbound phone number configured for destination ${to}.`);
  const message = await getTwilio().messages.create({ to, from: fromNumber, body });
  console.log(`[Twilio] SMS sent to ***${String(to).slice(-4)} | SID: ${message.sid}`);
  return { sid: message.sid, status: message.status };
}

async function sendOTP(phone) {
  const { randomInt } = require('crypto');
  const code = String(randomInt(100000, 999999));
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MS).toISOString();

  const { error } = await supabase.from(TABLES.OTP_CODES).upsert({
    phone, code, expires_at: expiresAt, attempts: 0, verified: false, created_at: new Date().toISOString(),
  });
  if (error) throw new Error('Failed to store OTP: ' + error.message);

  const country = countryCodeFromPhone(phone);
  const messages = {
    RW: `Kode yanyu ya BridgeUp ni: ${code}. Igihe irinda: iminota 5.`,
    KE: `Nambari yako ya uthibitisho wa BridgeUp ni: ${code}. Inaisha baada ya dakika 5.`,
    DEFAULT: `Your BridgeUp verification code is: ${code}. Expires in 5 minutes. Do not share this code.`,
  };
  await sendSMS(phone, messages[country] || messages.DEFAULT);
  return { success: true, expiresAt };
}

async function verifyOTP(phone, code) {
  const { data, error } = await supabase.from(TABLES.OTP_CODES).select('*').eq('phone', phone).maybeSingle();
  if (error || !data) return { valid: false, reason: 'No verification code found for this number. Please request a new one.' };
  if (data.verified) return { valid: false, reason: 'This code has already been used. Please request a new one.' };
  if (data.attempts >= OTP_MAX_ATTEMPTS) return { valid: false, reason: 'Too many incorrect attempts. Please request a new code.' };

  const expiresAt = typeof data.expires_at === 'string' ? new Date(data.expires_at) : data.expires_at;
  if (new Date() > expiresAt) return { valid: false, reason: 'This code has expired. Please request a new one.' };

  if (data.code !== String(code).trim()) {
    const newAttempts = data.attempts + 1;
    await supabase.from(TABLES.OTP_CODES).update({ attempts: newAttempts }).eq('phone', phone);
    const remaining = OTP_MAX_ATTEMPTS - newAttempts;
    return { valid: false, reason: `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.` };
  }

  await supabase.from(TABLES.OTP_CODES).update({ verified: true }).eq('phone', phone);
  return { valid: true };
}

async function processSMSConversation(fromPhone, messageBody) {
  const body = messageBody.trim();
  const country = countryCodeFromPhone(fromPhone);

  const { data: state } = await supabase.from(TABLES.SMS_CONVERSATIONS).select('*').eq('phone', fromPhone).maybeSingle();
  const isReset = /^(start|restart|help|hello|hi|salut|bonjour|habari|muraho)$/i.test(body);

  if (!state || state.step === SMS_STEPS.COMPLETE || isReset) {
    let detectedLang = 'en';
    try {
      const langResult = await detectLanguage(body);
      detectedLang = langResult.iso || 'en';
    } catch {
      const countryLang = { RW: 'rw', KE: 'sw', TZ: 'sw', SN: 'fr', CI: 'fr', MA: 'ar', EG: 'ar' };
      detectedLang = countryLang[country] || 'en';
    }
    const greeting = STEP_GREETINGS[detectedLang] || STEP_GREETINGS.en;
    await supabase.from(TABLES.SMS_CONVERSATIONS).upsert({
      phone: fromPhone, country, language: detectedLang, step: SMS_STEPS.GREETING,
      conversation_history: [{ role: 'user', content: body }, { role: 'assistant', content: greeting }],
      intake_data: null, updated_at: new Date().toISOString(),
    });
    return { reply: greeting, step: SMS_STEPS.GREETING };
  }

  if ([SMS_STEPS.GREETING, SMS_STEPS.LOCATION, SMS_STEPS.URGENCY, SMS_STEPS.CONFIRM].includes(state.step)) {
    const history = [...(state.conversation_history || []), { role: 'user', content: body }];
    let claudeResult;
    try {
      claudeResult = await processNeed(history, 'text');
    } catch (err) {
      console.error('[Twilio SMS] Claude error:', err.message);
      const fallback = { en: 'Sorry, I had trouble understanding that. Could you try again?', rw: 'Mbabarira, nanze gusobanukirwa ubwo. Ongera ugerageze?', sw: 'Samahani, sikuelewa vizuri. Jaribu tena?', fr: "Desole, je n'ai pas compris. Pouvez-vous reessayer?" };
      return { reply: fallback[state.language] || fallback.en, step: state.step };
    }

    const updatedHistory = [...history, { role: 'assistant', content: claudeResult.reply }];
    const stepProgression = { [SMS_STEPS.GREETING]: SMS_STEPS.LOCATION, [SMS_STEPS.LOCATION]: SMS_STEPS.URGENCY, [SMS_STEPS.URGENCY]: SMS_STEPS.CONFIRM, [SMS_STEPS.CONFIRM]: SMS_STEPS.MATCHING };
    const nextStep = claudeResult.isComplete ? SMS_STEPS.MATCHING : (stepProgression[state.step] || state.step);

    await supabase.from(TABLES.SMS_CONVERSATIONS).update({
      step: nextStep, conversation_history: updatedHistory,
      ...(claudeResult.intakeData && { intake_data: claudeResult.intakeData }),
      updated_at: new Date().toISOString(),
    }).eq('phone', fromPhone);

    if (claudeResult.isComplete) {
      setImmediate(() => triggerSMSMatching(fromPhone, claudeResult.intakeData, state.language));
      const processingMsgs = { en: "Got it! I'm searching for verified helpers near you now. I'll send their contact details by SMS within a few minutes.", rw: "Nababariye! Ndashaka abantu bafashwe hafi yanyu. Nzaboherereza amakuru yabo kuri SMS mu minota mike.", sw: "Nimeelewa! Ninatafuta wasaidizi waliothibitishwa karibu nawe. Nitatuma maelezo kwako kwa SMS ndani ya dakika chache.", fr: "Compris! Je recherche des aidants verifies pres de chez vous. Je vous enverrai leurs coordonnees par SMS dans quelques minutes." };
      return { reply: processingMsgs[state.language] || processingMsgs.en, step: SMS_STEPS.MATCHING };
    }
    return { reply: claudeResult.reply, step: nextStep };
  }

  if ([SMS_STEPS.MATCHING, SMS_STEPS.MATCHED, SMS_STEPS.COMPLETE].includes(state.step)) {
    const restartMsgs = { en: 'Your request is already being processed. Text START to begin a new request.', rw: 'Ubusabe bwawe burakora. Andika START gutangira ubusabe bushya.', sw: 'Ombi lako linashughulikiwa. Andika START kuanza ombi jipya.', fr: 'Votre demande est deja en cours. Ecrivez START pour une nouvelle demande.' };
    return { reply: restartMsgs[state.language] || restartMsgs.en, step: state.step };
  }

  return { reply: STEP_GREETINGS.en, step: SMS_STEPS.GREETING };
}

async function triggerSMSMatching(phone, intakeData, language) {
  try {
    await supabase.from(TABLES.NEEDS).insert({
      phone, ...intakeData, channel: 'sms', language, status: 'pending_match',
    });
    console.log(`[Twilio SMS] Matching triggered for ***${String(phone).slice(-4)}`);
  } catch (err) {
    console.error(`[Twilio SMS] Failed to trigger matching for ***${String(phone).slice(-4)}:`, err.message);
  }
}

async function sendVoiceCall(to, twimlUrl) {
  const fromNumber = pickFromNumber(to);
  if (!fromNumber) throw new Error(`[Twilio] No voice number configured for destination ${to}.`);
  console.log(`[Twilio] sendVoiceCall placeholder: would call ${to} with TwiML from ${twimlUrl}`);
  return { sid: 'placeholder', status: 'queued' };
}

module.exports = { sendSMS, sendOTP, verifyOTP, processSMSConversation, sendVoiceCall, pickFromNumber, countryCodeFromPhone, SMS_CONVERSATION_STEPS: SMS_STEPS };
