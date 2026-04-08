'use strict';

/**
 * Voice Route — BridgeUp IVR (Interactive Voice Response) via Twilio
 *
 * Mounted at TWO paths in index.js:
 *   /voice       — Twilio webhooks (POST /answer, /process, /complete, /status)
 *   /api/voice   — Admin API       (GET  /calls)
 *
 * CRITICAL: Every route that Twilio calls (/answer, /process, /complete) MUST
 * return a valid TwiML VoiceResponse XML document, even on errors. Returning
 * plain text or an HTTP error without TwiML causes Twilio to play a generic
 * error tone and potentially retry, which creates duplicate interactions.
 *
 * EXCEPTION: POST /status returns 204 No Content — Twilio's status callbacks
 * only need a 2xx acknowledgment; they ignore any response body.
 */

const express = require('express');
const {
  validateTwilioSignature,
  buildGreetingTwiML,
  processVoiceTurn,
  buildGoodbyeTwiML,
  getGreetingByCountryCode,
} = require('../services/voice-service');
const { countryCodeFromPhone } = require('../services/twilio');
const { db, COLLECTIONS, writeAuditLog } = require('../services/firebase');
const { requireAuth } = require('./auth');

const router = express.Router();

// ─── Constants ────────────────────────────────────────────────────────────────

// Empty TwiML for 403/400 error responses on voice webhook routes.
// Twilio requires a valid XML response — plain text causes a retry loop.
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response/>';

// Twilio CallSid pattern: exactly "CA" + 32 lowercase hex characters (34 chars total)
const CALLSID_PATTERN = /^CA[0-9a-f]{32}$/i;

// Twilio call status allowlist — all values defined in Twilio's REST API docs
const VALID_CALL_STATUSES = [
  'queued', 'ringing', 'in-progress', 'canceled',
  'completed', 'failed', 'busy', 'no-answer',
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Sanitizes speech transcription text before it is passed to Claude.
 * Strips HTML/XML tags, null bytes, other control characters, and Unicode
 * bidirectional/zero-width characters that could be used for injection.
 * Caps at 500 characters (a complete spoken sentence is far shorter).
 *
 * @param {*}      raw  Raw value from req.body.SpeechResult
 * @returns {string}    Clean, safe transcription text
 */
function sanitizeSpeech(raw) {
  if (typeof raw !== 'string') return '';

  return raw
    .replace(/<[^>]*>/g, '')                                   // strip HTML/XML tags
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')        // strip control chars (keep \t \n \r)
    .replace(/\u202E|\u200B|\u200C|\u200D|\uFEFF/g, '')        // strip bidirectional/zero-width
    .trim()
    .slice(0, 500);
}

/**
 * Resolves the caller's country code.
 * Prefers Twilio's FromCountry field (pre-computed, accurate),
 * falls back to phone prefix lookup via countryCodeFromPhone().
 *
 * @param {string|null} fromCountry  req.body.FromCountry (ISO 3166-1 alpha-2)
 * @param {string}      fromPhone    E.164 caller phone number
 * @returns {string}                 ISO 3166-1 alpha-2 country code
 */
function resolveCountryCode(fromCountry, fromPhone) {
  if (fromCountry && /^[A-Z]{2}$/i.test(String(fromCountry))) {
    return String(fromCountry).toUpperCase();
  }
  return countryCodeFromPhone(fromPhone || '');
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 1 — POST /answer
// Twilio calls this when an inbound call arrives on any BridgeUp number.
// We speak a language-appropriate greeting and open a speech Gather.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Twilio request body fields used:
 *   From         — E.164 caller phone number
 *   FromCountry  — ISO 3166-1 alpha-2 country of the caller
 *   CallSid      — Unique call identifier
 */
router.post('/answer', async (req, res) => {
  res.type('text/xml');

  // ── 1. Verify Twilio signature — absolute first operation ────────────────
  if (!validateTwilioSignature(req)) {
    console.warn('[Voice] Rejected /answer — invalid Twilio signature | IP:', req.ip);
    return res.status(403).send(EMPTY_TWIML);
  }

  // ── 2. Extract and validate fields ────────────────────────────────────────
  const from        = req.body.From        || null;
  const fromCountry = req.body.FromCountry || null;
  const callSid     = req.body.CallSid     || null;

  if (!from || !/^\+[1-9]\d{6,14}$/.test(from)) {
    console.warn('[Voice] /answer: missing or invalid From number');
    return res.status(400).send(EMPTY_TWIML);
  }

  // ── 3. Resolve country and build greeting TwiML ──────────────────────────
  const countryCode = resolveCountryCode(fromCountry, from);

  // processUrl is the full absolute URL Twilio will POST speech transcriptions to
  const processUrl  = `${process.env.APP_URL || ''}/voice/process`;

  const { twiml } = buildGreetingTwiML(countryCode, processUrl);

  // ── 4. Audit log (fire-and-forget) ───────────────────────────────────────
  writeAuditLog({
    action:   'voice_call_received',
    actorId:  `phone:***${from.slice(-4)}`,
    targetId: callSid || 'unknown',
    meta: { countryCode },
  }).catch(() => {});

  return res.send(twiml);
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 2 — POST /process
// Twilio POSTs here after each Gather collects speech from the caller.
// SpeechResult carries the transcribed text; we pass it to the AI state machine.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Twilio request body fields used:
 *   CallSid       — Unique call identifier (used as Firestore document key)
 *   SpeechResult  — Transcribed text from caller's speech
 *   From          — E.164 caller phone number
 *   FromCountry   — ISO 3166-1 alpha-2 country of the caller
 */
router.post('/process', async (req, res) => {
  res.type('text/xml');

  // ── 1. Verify Twilio signature ─────────────────────────────────────────────
  if (!validateTwilioSignature(req)) {
    console.warn('[Voice] Rejected /process — invalid Twilio signature | IP:', req.ip);
    return res.status(403).send(EMPTY_TWIML);
  }

  // ── 2. Extract fields ─────────────────────────────────────────────────────
  const callSid     = req.body.CallSid      || null;
  const rawSpeech   = req.body.SpeechResult || '';
  const from        = req.body.From         || null;
  const fromCountry = req.body.FromCountry  || null;

  // ── 3. Validate CallSid format before it touches any Firestore path ───────
  // processVoiceTurn() also validates internally, but this early check gives
  // a clean 400 without entering the service layer.
  if (!callSid || !CALLSID_PATTERN.test(callSid)) {
    console.warn('[Voice] /process: invalid or missing CallSid');
    return res.status(400).send(EMPTY_TWIML);
  }

  // ── 4. Validate caller phone ──────────────────────────────────────────────
  if (!from || !/^\+[1-9]\d{6,14}$/.test(from)) {
    console.warn('[Voice] /process: missing or invalid From number');
    return res.status(400).send(EMPTY_TWIML);
  }

  // ── 5. Sanitize transcription ─────────────────────────────────────────────
  // Strip HTML tags, control characters, and Unicode bidirectional/zero-width
  // characters before passing caller speech to Claude.
  const transcription = sanitizeSpeech(rawSpeech);
  const countryCode   = resolveCountryCode(fromCountry, from);
  const processUrl    = `${process.env.APP_URL || ''}/voice/process`;

  // ── 6. Advance the AI conversation state machine (max 5 turns) ───────────
  let twiml;
  try {
    twiml = await processVoiceTurn(callSid, transcription, from, countryCode, processUrl);
  } catch (err) {
    console.error(`[Voice] processVoiceTurn error for ***${from.slice(-4)}:`, err.message);
    // On a fatal error, play the goodbye message and hang up cleanly.
    // The call state document in Firestore is preserved for debugging.
    // A generic error message is not played — goodbye TwiML is safest
    // because it ends the call without leaving the caller waiting.
    twiml = buildGoodbyeTwiML(countryCode);
  }

  return res.send(twiml);
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 3 — POST /complete
// Twilio calls this when a call ends (caller hangs up, or call is redirected).
// Used to speak a final goodbye and log the completed call.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Twilio request body fields used:
 *   From          — E.164 caller phone number
 *   FromCountry   — ISO 3166-1 alpha-2 country
 *   CallSid       — Unique call identifier
 *   CallDuration  — Duration in seconds (integer string)
 */
router.post('/complete', async (req, res) => {
  res.type('text/xml');

  // ── 1. Verify Twilio signature ─────────────────────────────────────────────
  if (!validateTwilioSignature(req)) {
    console.warn('[Voice] Rejected /complete — invalid Twilio signature | IP:', req.ip);
    return res.status(403).send(EMPTY_TWIML);
  }

  const from         = req.body.From         || null;
  const fromCountry  = req.body.FromCountry  || null;
  const callSid      = req.body.CallSid      || null;
  const callDuration = req.body.CallDuration || null;

  const countryCode = resolveCountryCode(fromCountry, from || '');

  // ── 2. Build goodbye TwiML (includes <Hangup> via endCall: true) ──────────
  const twiml = buildGoodbyeTwiML(countryCode);

  // ── 3. Audit log — phone redacted to last 4 digits ───────────────────────
  writeAuditLog({
    action:   'voice_call_complete',
    actorId:  from ? `phone:***${String(from).slice(-4)}` : 'phone:unknown',
    targetId: callSid || 'unknown',
    meta: {
      countryCode,
      callDurationSeconds: callDuration ? parseInt(callDuration, 10) : null,
    },
  }).catch(() => {});

  return res.send(twiml);
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 4 — POST /status
// Twilio call status callback — tracks call outcome for monitoring.
// Returns 204 No Content (not TwiML — Twilio ignores the body on status CBs).
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Twilio request body fields used:
 *   CallSid       — Unique call identifier
 *   CallStatus    — queued|ringing|in-progress|canceled|completed|failed|busy|no-answer
 *   CallDuration  — Duration in seconds (present only on terminal statuses)
 *   From          — E.164 caller phone number
 *   ErrorCode     — Twilio error code (present only on failure)
 */
router.post('/status', async (req, res) => {
  // ── 1. Verify Twilio signature ─────────────────────────────────────────────
  if (!validateTwilioSignature(req)) {
    console.warn('[Voice] Rejected /status callback — invalid Twilio signature | IP:', req.ip);
    return res.status(403).end();
  }

  const { CallSid, CallStatus, CallDuration, From, ErrorCode } = req.body;

  // ── 2. Validate CallStatus against the Twilio allowlist ──────────────────
  // Prevents arbitrary strings from being written to the audit log if a
  // signed-but-crafted webhook sends an unexpected status value.
  const safeStatus = VALID_CALL_STATUSES.includes(CallStatus) ? CallStatus : 'unknown';

  const isFailed    = ['failed', 'busy', 'no-answer', 'canceled'].includes(safeStatus);
  const fromRedacted = From ? `***${String(From).slice(-4)}` : null;
  const durationSec  = CallDuration ? parseInt(CallDuration, 10) : null;

  // ── 3. Write to audit_log ─────────────────────────────────────────────────
  writeAuditLog({
    action:   isFailed ? 'voice_call_failed' : 'voice_call_status',
    actorId:  'system:twilio',
    targetId: CallSid || 'unknown',
    meta: {
      status:              safeStatus,
      fromRedacted,
      callDurationSeconds: durationSec,
      errorCode:           ErrorCode || null,
    },
  }).catch(() => {});

  // ── 4. Log failures conspicuously for on-call monitoring ─────────────────
  if (isFailed) {
    console.error(
      `[Voice] Call ${safeStatus} | SID: ${CallSid} | From: ${fromRedacted} | Duration: ${durationSec ?? 0}s | Error: ${ErrorCode || 'none'}`
    );
  }

  // ── 5. 204 No Content — Twilio does not require TwiML on status callbacks
  return res.status(204).end();
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 5 — GET /calls
// Admin: paginated voice call history from the voice_calls collection
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Returns voice call state documents for the admin dashboard.
 * Each document is keyed by CallSid and contains call metadata, turn count,
 * and final intake data (if the conversation completed successfully).
 *
 * Auth: superadmin JWT required.
 *
 * Tenant isolation note: voice_calls documents are created by processVoiceTurn()
 * and do not carry a tenantId field (callers are anonymous pre-auth users).
 * There is no safe Firestore filter that would scope an admin to their own
 * tenant's calls. Restricted to superadmin until processVoiceTurn() is updated
 * to persist tenantId, after which WHERE('tenantId', '==', req.user.tenantId)
 * can be added to the query below.
 *
 * Query params:
 *   limit    number  Max results per page (default 50, max 200)
 *   cursor   string  Document ID (CallSid) of the last item on the previous page
 *   status   string  Filter by call status (completed|failed|in-progress|etc)
 */
router.get('/calls', requireAuth, async (req, res) => {
  const { role } = req.user;

  if (role !== 'superadmin') {
    return res.status(403).json({
      error: 'Access denied. Voice call history requires superadmin role.',
    });
  }

  const { cursor: cursorId, status: rawStatus, limit: rawLimit } = req.query;
  const pageLimit = Math.min(parseInt(rawLimit, 10) || 50, 200);

  // Validate status filter against the known Twilio call status enum
  // plus internal finalise statuses written by voice-service.js
  const INTERNAL_STATUSES   = ['intake_complete', 'max_turns_reached'];
  const ALL_VALID_STATUSES  = [...VALID_CALL_STATUSES, ...INTERNAL_STATUSES];
  const statusFilter = rawStatus && ALL_VALID_STATUSES.includes(String(rawStatus).trim())
    ? String(rawStatus).trim()
    : null;

  try {
    // voice_calls has no COLLECTIONS constant — keyed by CallSid in voice-service.js
    let query = db.collection('voice_calls');

    if (statusFilter) {
      query = query.where('status', '==', statusFilter);
    }

    query = query.orderBy('updatedAt', 'desc').limit(pageLimit);

    // Cursor-based pagination: validate cursorId before using as Firestore doc path.
    // CallSids are 34-char alphanumeric (CA + 32 hex) — covered by this pattern.
    if (cursorId) {
      if (!/^[a-zA-Z0-9_-]{10,128}$/.test(String(cursorId))) {
        return res.status(400).json({ error: 'Invalid cursor value.' });
      }
      const cursorSnap = await db.collection('voice_calls').doc(cursorId).get();
      if (cursorSnap.exists) query = query.startAfter(cursorSnap);
    }

    const snap = await query.get();

    const calls = snap.docs.map(doc => {
      const data = doc.data();

      // PII reduction: phone is redacted to last 4 digits — full number never returned.
      // The CallSid document ID is a Twilio system identifier, not user PII.
      return {
        callSid:      doc.id,
        phoneLast4:   data.callerPhone
                        ? `***${String(data.callerPhone).slice(-4)}`
                        : null,
        countryCode:  data.countryCode || null,
        language:     data.language    || null,
        status:       data.status      || null,
        turns:        data.turns       || 0,
        intakeData:   data.intakeData  || null,
        createdAt:    data.createdAt   || null,
        updatedAt:    data.updatedAt   || null,
        completedAt:  data.completedAt || null,
      };
    });

    return res.json({
      calls,
      count:      calls.length,
      hasMore:    calls.length === pageLimit,
      nextCursor: calls.length === pageLimit ? calls[calls.length - 1].callSid : null,
    });
  } catch (err) {
    console.error('[Voice] GET /calls error:', err.message);
    return res.status(500).json({ error: 'Could not load call history. Please try again.' });
  }
});

module.exports = router;
