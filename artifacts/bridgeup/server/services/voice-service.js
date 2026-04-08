'use strict';

const twilio = require('twilio');
const { db, FieldValue, COLLECTIONS } = require('./firebase');
const { generateTwilioResponse } = require('./claude');

// ─── Language + TTS configuration per country ─────────────────────────────────
// Each entry defines:
//   language     : ISO 639-1 code — used for Claude language targeting
//   name         : Human-readable name for logging
//   greeting     : Verbatim opening line per spec
//   gathering    : Short "please speak now" prompt played before each Gather
//   noInput      : Played when caller is silent for too long
//   goodbye      : Played when conversation ends
//   smsFollowUp  : Sent as SMS after call if helper found
//   sayLanguage  : Twilio <Say> language attribute (IETF BCP-47)
//   sayVoice     : Twilio voice — Polly voices where supported; alice fallback
//   gatherLang   : Twilio <Gather> speech recognition language code
//
// Note on Kinyarwanda + Swahili: Twilio/Amazon Polly do not have native
// Kinyarwanda TTS voices. We use "alice" with the closest available language
// tag so the greeting text is spoken (imperfectly but intelligibly).
// Swahili has limited Polly support — sw-TZ is used for recognition; TTS
// falls back to alice. This is the best available without a custom TTS service.

const COUNTRY_CONFIG = {
  // ── Rwanda ──────────────────────────────────────────────────────────────────
  RW: {
    language:    'rw',
    name:        'Kinyarwanda',
    greeting:    'Murakaza neza kuri BridgeUp. Vuga ikibazo cyawe.',
    gathering:   'Ndumva.',
    noInput:     'Ntibyumvikana. Vuga nanone.',
    goodbye:     'Murakoze. Turabagezaho amakuru yawe vuba.',
    smsFollowUp: 'BridgeUp: Amakuru y\'umusazizi tuzaboherereza kuri SMS.',
    sayLanguage: 'rw-RW',
    sayVoice:    'alice',           // No Polly Kinyarwanda voice exists
    gatherLang:  'rw-RW',
  },

  // ── Kenya ───────────────────────────────────────────────────────────────────
  KE: {
    language:    'sw',
    name:        'Swahili',
    greeting:    'Karibu BridgeUp. Sema unahitaji nini.',
    gathering:   'Sikiliza.',
    noInput:     'Sikusikia. Tafadhali sema tena.',
    goodbye:     'Asante. Tutakutumia habari za msaidizi hivi karibuni.',
    smsFollowUp: 'BridgeUp: Tutakutumia maelezo ya msaidizi kwa SMS.',
    sayLanguage: 'sw-TZ',
    sayVoice:    'alice',           // Polly Swahili is limited; alice used
    gatherLang:  'sw-TZ',
  },

  // ── Tanzania ─────────────────────────────────────────────────────────────────
  TZ: {
    language:    'sw',
    name:        'Swahili',
    greeting:    'Karibu BridgeUp. Sema unahitaji nini.',
    gathering:   'Sikiliza.',
    noInput:     'Sikukusikia. Tafadhali sema tena.',
    goodbye:     'Asante. Tutakutumia maelezo ya msaidizi hivi karibuni.',
    smsFollowUp: 'BridgeUp: Tutakutumia maelezo ya msaidizi kwa SMS.',
    sayLanguage: 'sw-TZ',
    sayVoice:    'alice',
    gatherLang:  'sw-TZ',
  },

  // ── Uganda ───────────────────────────────────────────────────────────────────
  UG: {
    language:    'en',
    name:        'English',
    greeting:    'Welcome to BridgeUp Uganda. Tell me what you need.',
    gathering:   'Go ahead.',
    noInput:     'I didn\'t hear you. Please speak now.',
    goodbye:     'Thank you. We will send you helper details by SMS shortly.',
    smsFollowUp: 'BridgeUp: We will send you helper contact details by SMS.',
    sayLanguage: 'en-GB',
    sayVoice:    'Polly.Amy',
    gatherLang:  'en-GB',
  },

  // ── Nigeria ──────────────────────────────────────────────────────────────────
  NG: {
    language:    'en',
    name:        'English',
    greeting:    'Welcome to BridgeUp. Tell me what you need.',
    gathering:   'Go ahead.',
    noInput:     'I didn\'t hear you. Please speak now.',
    goodbye:     'Thank you. We will send you helper details by SMS shortly.',
    smsFollowUp: 'BridgeUp: We will send you helper contact details by SMS.',
    sayLanguage: 'en-GB',
    sayVoice:    'Polly.Amy',
    gatherLang:  'en-GB',
  },

  // ── Ghana ────────────────────────────────────────────────────────────────────
  GH: {
    language:    'en',
    name:        'English',
    greeting:    'Welcome to BridgeUp. Tell me what you need.',
    gathering:   'Go ahead.',
    noInput:     'I didn\'t hear you. Please speak now.',
    goodbye:     'Thank you. We will send you helper details by SMS shortly.',
    smsFollowUp: 'BridgeUp: We will send you helper contact details by SMS.',
    sayLanguage: 'en-GB',
    sayVoice:    'Polly.Amy',
    gatherLang:  'en-GB',
  },

  // ── Senegal / Côte d'Ivoire / Cameroon ──────────────────────────────────────
  SN: {
    language:    'fr',
    name:        'Français',
    greeting:    'Bienvenue sur BridgeUp. Dites-moi ce dont vous avez besoin.',
    gathering:   'Je vous écoute.',
    noInput:     'Je n\'ai pas entendu. Parlez maintenant, s\'il vous plaît.',
    goodbye:     'Merci. Nous vous enverrons les coordonnées d\'un aidant par SMS.',
    smsFollowUp: 'BridgeUp: Nous vous enverrons les coordonnées par SMS.',
    sayLanguage: 'fr-FR',
    sayVoice:    'Polly.Lea',
    gatherLang:  'fr-FR',
  },
  CI: {
    language: 'fr', name: 'Français',
    greeting: 'Bienvenue sur BridgeUp. Dites-moi ce dont vous avez besoin.',
    gathering: 'Je vous écoute.', noInput: 'Parlez maintenant, s\'il vous plaît.',
    goodbye: 'Merci. Nous vous enverrons les coordonnées par SMS.',
    smsFollowUp: 'BridgeUp: Nous vous enverrons les coordonnées par SMS.',
    sayLanguage: 'fr-FR', sayVoice: 'Polly.Lea', gatherLang: 'fr-FR',
  },
  CM: {
    language: 'fr', name: 'Français',
    greeting: 'Bienvenue sur BridgeUp. Dites-moi ce dont vous avez besoin.',
    gathering: 'Je vous écoute.', noInput: 'Parlez maintenant, s\'il vous plaît.',
    goodbye: 'Merci. Nous vous enverrons les coordonnées par SMS.',
    smsFollowUp: 'BridgeUp: Nous vous enverrons les coordonnées par SMS.',
    sayLanguage: 'fr-FR', sayVoice: 'Polly.Lea', gatherLang: 'fr-FR',
  },

  // ── Morocco / Egypt ──────────────────────────────────────────────────────────
  MA: {
    language:    'ar',
    name:        'Arabic',
    greeting:    'مرحباً بك في BridgeUp. أخبرني بما تحتاجه.',
    gathering:   'استمر.',
    noInput:     'لم أسمعك. تحدث الآن من فضلك.',
    goodbye:     'شكراً. سنرسل لك تفاصيل المساعد عبر الرسائل القصيرة.',
    smsFollowUp: 'BridgeUp: سنرسل لك تفاصيل الاتصال قريباً.',
    sayLanguage: 'ar-SA',
    sayVoice:    'Polly.Zeina',
    gatherLang:  'ar-SA',
  },
  EG: {
    language: 'ar', name: 'Arabic',
    greeting: 'مرحباً بك في BridgeUp. أخبرني بما تحتاجه.',
    gathering: 'استمر.', noInput: 'لم أسمعك. تحدث الآن من فضلك.',
    goodbye: 'شكراً. سنرسل لك تفاصيل المساعد عبر الرسائل القصيرة.',
    smsFollowUp: 'BridgeUp: سنرسل لك تفاصيل الاتصال قريباً.',
    sayLanguage: 'ar-SA', sayVoice: 'Polly.Zeina', gatherLang: 'ar-SA',
  },

  // ── Canada / USA ─────────────────────────────────────────────────────────────
  CA: {
    language:    'en',
    name:        'English',
    greeting:    'Welcome to BridgeUp. Tell me what you need.',
    gathering:   'Go ahead.',
    noInput:     'I didn\'t catch that. Please speak now.',
    goodbye:     'Thank you. We will send you helper contact details by SMS shortly.',
    smsFollowUp: 'BridgeUp: We will text you helper contact details shortly.',
    sayLanguage: 'en-CA',
    sayVoice:    'Polly.Joanna',
    gatherLang:  'en-CA',
  },
  US: {
    language: 'en', name: 'English',
    greeting: 'Welcome to BridgeUp. Tell me what you need.',
    gathering: 'Go ahead.', noInput: 'I didn\'t catch that. Please speak now.',
    goodbye: 'Thank you. We will send you helper contact details by SMS shortly.',
    smsFollowUp: 'BridgeUp: We will text you helper contact details shortly.',
    sayLanguage: 'en-US', sayVoice: 'Polly.Joanna', gatherLang: 'en-US',
  },

  // ── UK / France (international callers) ─────────────────────────────────────
  GB: {
    language: 'en', name: 'English',
    greeting: 'Welcome to BridgeUp. Tell me what you need.',
    gathering: 'Go ahead.', noInput: 'I didn\'t hear you. Please speak now.',
    goodbye: 'Thank you. We will send you helper details by SMS shortly.',
    smsFollowUp: 'BridgeUp: We will send you helper contact details by SMS.',
    sayLanguage: 'en-GB', sayVoice: 'Polly.Amy', gatherLang: 'en-GB',
  },
  FR: {
    language: 'fr', name: 'Français',
    greeting: 'Bienvenue sur BridgeUp. Dites-moi ce dont vous avez besoin.',
    gathering: 'Je vous écoute.', noInput: 'Parlez maintenant, s\'il vous plaît.',
    goodbye: 'Merci. Nous vous enverrons les coordonnées par SMS.',
    smsFollowUp: 'BridgeUp: Nous vous enverrons les coordonnées par SMS.',
    sayLanguage: 'fr-FR', sayVoice: 'Polly.Lea', gatherLang: 'fr-FR',
  },
};

// Universal fallback for any country not in the table above
const DEFAULT_CONFIG = COUNTRY_CONFIG.US;

// Maximum turns per call per spec
const MAX_CALL_TURNS = 5;

// Gather speech recognition timeout (seconds)
const SPEECH_TIMEOUT = 3;
const GATHER_TIMEOUT = 10; // total gather window

// ─── PUBLIC FUNCTION 1: getGreetingByCountryCode ─────────────────────────────
/**
 * Returns the full language/voice/greeting configuration for a given country.
 *
 * @param {string} countryCode  ISO 3166-1 alpha-2 (e.g. 'RW', 'KE', 'CA')
 * @returns {{
 *   language:    string,   ISO 639-1 code for Claude targeting
 *   name:        string,   Human-readable language name
 *   greeting:    string,   Opening line per spec
 *   gathering:   string,   "please speak" prompt
 *   noInput:     string,   Silence fallback prompt
 *   goodbye:     string,   Closing message
 *   smsFollowUp: string,   Follow-up SMS body
 *   sayLanguage: string,   Twilio <Say> language attribute
 *   sayVoice:    string,   Twilio voice name
 *   gatherLang:  string,   Twilio <Gather> language attribute
 * }}
 */
function getGreetingByCountryCode(countryCode) {
  const config = COUNTRY_CONFIG[String(countryCode).toUpperCase()];
  if (!config) {
    console.warn(`[VoiceService] Unknown country code "${countryCode}" — using default (en-US)`);
    return DEFAULT_CONFIG;
  }
  return config;
}

// ─── PUBLIC FUNCTION 2: buildVoiceResponse ───────────────────────────────────
/**
 * Builds a TwiML VoiceResponse that speaks text and opens a speech Gather.
 * This is the core TwiML factory used by all voice route handlers.
 *
 * @param {Object}  opts
 * @param {string}  opts.sayText        Text to speak before the Gather opens
 * @param {string}  opts.sayLanguage    IETF BCP-47 language (e.g. 'en-US', 'rw-RW')
 * @param {string}  opts.sayVoice       Twilio/Polly voice name
 * @param {string}  opts.gatherAction   URL Twilio will POST the transcription to
 * @param {string}  opts.gatherLanguage Speech recognition language
 * @param {string}  [opts.fallbackText] Text spoken if Gather receives no input
 * @param {boolean} [opts.endCall]      If true: speak sayText and hang up, no Gather
 * @returns {string}  TwiML XML string ready for res.type('text/xml').send(...)
 */
function buildVoiceResponse({
  sayText,
  sayLanguage,
  sayVoice,
  gatherAction,
  gatherLanguage,
  fallbackText,
  endCall = false,
}) {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const response = new VoiceResponse();

  if (endCall) {
    // Terminal response — speak and hang up
    const say = response.say({ language: sayLanguage, voice: sayVoice });
    say.addText(sayText);
    response.hangup();
    return response.toString();
  }

  // Build a Gather that collects speech input
  const gather = response.gather({
    input:          'speech',
    action:         gatherAction,
    method:         'POST',
    language:       gatherLanguage,
    speechTimeout:  SPEECH_TIMEOUT,      // seconds of silence = end of speech
    timeout:        GATHER_TIMEOUT,      // total window to start speaking
    enhanced:       true,                // use Twilio's enhanced speech model
  });

  // The <Say> inside <Gather> is spoken WHILE the gather is open
  gather.say({ language: sayLanguage, voice: sayVoice }, sayText);

  // Fallback: if caller says nothing within the timeout window
  if (fallbackText) {
    const fallbackSay = response.say({ language: sayLanguage, voice: sayVoice });
    fallbackSay.addText(fallbackText);
    // Redirect back to the same action URL to try again (Twilio loops)
    response.redirect({ method: 'POST' }, gatherAction);
  }

  return response.toString();
}

// ─── PUBLIC FUNCTION 3: buildGreetingTwiML ───────────────────────────────────
/**
 * Builds the opening TwiML for an incoming call.
 * Used by POST /voice/answer.
 *
 * @param {string} countryCode   Caller's country (from Twilio CalledCountry or From number)
 * @param {string} processUrl    URL to POST transcription to (e.g. '/voice/process')
 * @returns {{ twiml: string, config: Object }}
 */
function buildGreetingTwiML(countryCode, processUrl) {
  const config = getGreetingByCountryCode(countryCode);

  const twiml = buildVoiceResponse({
    sayText:      config.greeting,
    sayLanguage:  config.sayLanguage,
    sayVoice:     config.sayVoice,
    gatherAction: processUrl,
    gatherLanguage: config.gatherLang,
    fallbackText: config.noInput,
  });

  return { twiml, config };
}

// ─── PUBLIC FUNCTION 4: processVoiceTurn ─────────────────────────────────────
/**
 * Processes a single speech turn from the caller:
 *   1. Loads call state from Firestore (keyed by CallSid)
 *   2. Passes transcription + history to Claude via generateTwilioResponse()
 *   3. Saves updated state back to Firestore
 *   4. Returns TwiML for the next Gather (or goodbye TwiML if complete)
 *
 * @param {string} callSid        Twilio CallSid — unique ID for this call
 * @param {string} transcription  What Twilio heard the caller say
 * @param {string} callerPhone    E.164 caller phone number
 * @param {string} countryCode    Caller's ISO country code
 * @param {string} processUrl     URL to POST next transcription to
 * @returns {Promise<string>}     TwiML XML string
 */
async function processVoiceTurn(callSid, transcription, callerPhone, countryCode, processUrl) {
  const config = getGreetingByCountryCode(countryCode);
  const ref    = db.collection('voice_calls').doc(callSid);
  const snap   = await ref.get();

  const callState = snap.exists
    ? snap.data()
    : { turns: 0, history: [], language: config.language, callerPhone, countryCode };

  // Guard: max 5 turns per spec
  if (callState.turns >= MAX_CALL_TURNS) {
    await finaliseCall(ref, callState, null);
    return buildVoiceResponse({
      sayText:   config.goodbye,
      sayLanguage: config.sayLanguage,
      sayVoice:  config.sayVoice,
      endCall:   true,
    });
  }

  // Build conversation history for Claude
  const history = [
    ...(callState.history || []),
    { role: 'user', content: transcription },
  ];

  // Call Claude for the AI response
  let claudeResult;
  try {
    claudeResult = await generateTwilioResponse(transcription, callState.history || [], countryCode);
  } catch (err) {
    console.error(`[VoiceService] Claude error on call ${callSid}:`, err.message);
    // Safe fallback — ask them to try again
    const errorPrompts = {
      en: 'Sorry, I had a problem. Please say that again.',
      rw: 'Mbabarira, hari ikibazo. Vuga nanone.',
      sw: 'Samahani, kulikuwa na tatizo. Tafadhali sema tena.',
      fr: 'Désolé, il y a eu un problème. Dites-le encore.',
      ar: 'آسف، حدثت مشكلة. قل ذلك مرة أخرى.',
    };
    const errorText = errorPrompts[callState.language] || errorPrompts.en;
    return buildVoiceResponse({
      sayText: errorText, sayLanguage: config.sayLanguage, sayVoice: config.sayVoice,
      gatherAction: processUrl, gatherLanguage: config.gatherLang,
    });
  }

  const updatedHistory = [...history, { role: 'assistant', content: claudeResult.twimlText }];
  const newTurns = (callState.turns || 0) + 1;

  // ── Intake complete — close call, store need, send SMS follow-up ──────────
  if (claudeResult.isComplete) {
    await finaliseCall(ref, { ...callState, history: updatedHistory, turns: newTurns }, claudeResult.intakeData);

    // Store voice_messages record per spec schema
    await db.collection(COLLECTIONS.VOICE_MESSAGES).add({
      userId:         callerPhone,
      audioUrl:       null,           // Twilio recording URL added by /voice/complete
      transcription:  transcription,
      claudeResponse: claudeResult.twimlText,
      language:       callState.language,
      timestamp:      FieldValue.serverTimestamp(),
      status:         'complete',
      intakeData:     claudeResult.intakeData,
      callSid,
    });

    return buildVoiceResponse({
      sayText:    config.goodbye,
      sayLanguage: config.sayLanguage,
      sayVoice:   config.sayVoice,
      endCall:    true,
    });
  }

  // ── Conversation continues — save state, return next Gather ──────────────
  await ref.set({
    ...callState,
    history:  updatedHistory,
    turns:    newTurns,
    updatedAt: FieldValue.serverTimestamp(),
    ...(snap.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
  }, { merge: true });

  return buildVoiceResponse({
    sayText:      claudeResult.twimlText,
    sayLanguage:  config.sayLanguage,
    sayVoice:     config.sayVoice,
    gatherAction: processUrl,
    gatherLanguage: config.gatherLang,
    fallbackText: config.noInput,
  });
}

// ─── INTERNAL: finalise call state in Firestore ───────────────────────────────
async function finaliseCall(ref, callState, intakeData) {
  await ref.set({
    ...callState,
    status:    intakeData ? 'intake_complete' : 'max_turns_reached',
    intakeData: intakeData || null,
    completedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  // If intake is complete, write a matching request just like the SMS flow
  if (intakeData) {
    setImmediate(async () => {
      try {
        await db.collection(COLLECTIONS.NEEDS).add({
          phone:    callState.callerPhone,
          ...intakeData,
          channel:  'voice',
          language: callState.language,
          status:   'pending_match',
          createdAt: FieldValue.serverTimestamp(),
        });
      } catch (err) {
        console.error('[VoiceService] Failed to write need from voice call:', err.message);
      }
    });
  }
}

// ─── PUBLIC FUNCTION 5: buildGoodbyeTwiML ────────────────────────────────────
/**
 * Builds a simple goodbye TwiML used by POST /voice/complete.
 * @param {string} countryCode
 * @returns {string} TwiML XML
 */
function buildGoodbyeTwiML(countryCode) {
  const config = getGreetingByCountryCode(countryCode);
  return buildVoiceResponse({
    sayText:    config.goodbye,
    sayLanguage: config.sayLanguage,
    sayVoice:   config.sayVoice,
    endCall:    true,
  });
}

// ─── PUBLIC FUNCTION 6: validateTwilioSignature ──────────────────────────────
/**
 * Verifies that an incoming webhook request is genuinely from Twilio.
 * Must be called on every /voice/* and /sms/* endpoint.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function validateTwilioSignature(req) {
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const signature  = req.headers['x-twilio-signature'];
  const url        = `${process.env.APP_URL || ''}${req.originalUrl}`;
  const params     = req.body;

  if (!signature) return false;
  return twilio.validateRequest(authToken, signature, url, params);
}

// ─── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
  getGreetingByCountryCode,
  buildVoiceResponse,
  buildGreetingTwiML,
  processVoiceTurn,
  buildGoodbyeTwiML,
  validateTwilioSignature,
  COUNTRY_CONFIG,
  MAX_CALL_TURNS,
};
