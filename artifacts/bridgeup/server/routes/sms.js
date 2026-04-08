'use strict';

/**
 * SMS Route — BridgeUp inbound SMS handling via Twilio
 *
 * Mounted at TWO paths in index.js:
 *   /sms         — Twilio webhooks (POST /receive, POST /status)
 *   /api/sms     — Admin API       (GET  /conversations)
 *
 * CRITICAL: Every route that Twilio calls (/receive, /status) MUST return a
 * valid TwiML XML document, even on errors. Returning plain text or an HTTP
 * error without a TwiML body causes Twilio to retry the webhook indefinitely,
 * resulting in duplicate messages sent to people in crisis.
 */

const express = require('express');
const { validateTwilioSignature }              = require('../services/voice-service');
const { processSMSConversation, SMS_CONVERSATION_STEPS } = require('../services/twilio');
const { db, FieldValue, COLLECTIONS, writeAuditLog }     = require('../services/firebase');
const { requireAuth }                          = require('./auth');

const router = express.Router();

// ─── TwiML helpers ────────────────────────────────────────────────────────────

/**
 * Builds a valid TwiML MessagingResponse XML string.
 * If `body` is falsy, returns an empty <Response/> (no outbound SMS).
 * All user-facing text is XML-escaped to prevent TwiML injection.
 *
 * @param {string|null} body  The reply message text, or null for an empty response
 * @returns {string}          Well-formed TwiML XML
 */
function buildMessagingTwiML(body) {
  if (!body) return '<?xml version="1.0" encoding="UTF-8"?><Response/>';

  const safe = String(body)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&apos;');

  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${safe}</Message></Response>`;
}

/**
 * Sanitizes inbound SMS content before it reaches Claude.
 * Strips HTML/XML tags, null bytes, and other control characters.
 * Limits length to 320 characters (two concatenated standard SMS segments).
 *
 * @param {*}      raw  Raw value from req.body.Body
 * @returns {string}    Clean, safe text
 */
function sanitizeSMSBody(raw) {
  if (typeof raw !== 'string') return '';

  return raw
    .replace(/<[^>]*>/g, '')                                   // strip HTML/XML tags
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')        // strip control chars (keep \t \n \r)
    .replace(/\u202E|\u200B|\u200C|\u200D|\uFEFF/g, '')        // strip unicode bidirectional/zero-width
    .trim()
    .slice(0, 320);
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 1 — POST /receive
// Twilio inbound SMS webhook
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Twilio calls this endpoint for every inbound SMS received on any BridgeUp number.
 *
 * Processing order:
 *   1. Verify Twilio HMAC signature           — 403 TwiML on failure
 *   2. Extract and validate From / Body       — 400 TwiML on failure
 *   3. Sanitize message body                  — strip tags / control chars
 *   4. Advance 7-step state machine           — via processSMSConversation()
 *   5. Write audit log                        — fire-and-forget
 *   6. Return TwiML MessagingResponse         — always valid XML
 *
 * Twilio request body fields used:
 *   From        — E.164 sender phone number
 *   To          — E.164 BridgeUp receiving number
 *   Body        — SMS text content
 *   MessageSid  — Unique message identifier
 */
router.post('/receive', async (req, res) => {
  // All responses from this route must be TwiML
  res.type('text/xml');

  // ── 1. Verify Twilio signature ─────────────────────────────────────────────
  // Prevents spoofed webhooks. Returns false if the X-Twilio-Signature header
  // is absent or does not match the HMAC of (AUTH_TOKEN + URL + POST params).
  if (!validateTwilioSignature(req)) {
    console.warn('[SMS] Rejected /receive — invalid Twilio signature | IP:', req.ip);
    // 403 with valid empty TwiML — Twilio records the rejection but does not retry
    return res.status(403).send(buildMessagingTwiML(null));
  }

  // ── 2. Extract and validate fields ────────────────────────────────────────
  const from   = req.body.From;
  const msgSid = req.body.MessageSid || null;
  const toNum  = req.body.To         || null;

  // E.164 format required — Twilio always sends this correctly, but we guard anyway
  if (!from || !/^\+[1-9]\d{6,14}$/.test(from)) {
    console.warn('[SMS] /receive: missing or invalid From number');
    return res.status(400).send(buildMessagingTwiML(null));
  }

  // ── 3. Sanitize message body ──────────────────────────────────────────────
  const body = sanitizeSMSBody(req.body.Body || '');

  // ── 4. Advance the conversation state machine ─────────────────────────────
  let result;
  try {
    result = await processSMSConversation(from, body);
  } catch (err) {
    console.error(`[SMS] State machine error for ***${from.slice(-4)}:`, err.message);
    // Return a safe English error — conversation state is preserved in Firestore
    // and the user can retry. Do NOT bubble the raw error to the TwiML response.
    result = {
      reply: 'Sorry, something went wrong. Please send your message again in a moment.',
      step:  'error',
    };
  }

  // ── 5. Audit log (fire-and-forget) ───────────────────────────────────────
  writeAuditLog({
    action:   'sms_inbound',
    actorId:  `phone:***${from.slice(-4)}`,
    targetId: msgSid || 'unknown',
    meta: {
      step:   result.step,
      toNum,
    },
  }).catch(() => {});

  // ── 6. Return TwiML ───────────────────────────────────────────────────────
  return res.send(buildMessagingTwiML(result.reply));
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 2 — POST /status
// Twilio delivery status callback
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Twilio sends delivery status updates here for every outbound SMS we send.
 * This allows us to track whether messages actually reached their recipients —
 * critical for people in crisis who may have basic feature phones with poor coverage.
 *
 * Status progression:
 *   queued → sending → sent → delivered   (success path)
 *   queued → sending → undelivered        (carrier delivery failure)
 *   queued → failed                       (Twilio could not send at all)
 *
 * Twilio request body fields used:
 *   MessageSid     — Unique message SID
 *   MessageStatus  — Current delivery status
 *   To             — Destination number
 *   ErrorCode      — Twilio error code (present only on failure)
 */
router.post('/status', async (req, res) => {
  res.type('text/xml');

  // ── 1. Verify Twilio signature ─────────────────────────────────────────────
  if (!validateTwilioSignature(req)) {
    console.warn('[SMS] Rejected /status callback — invalid Twilio signature | IP:', req.ip);
    return res.status(403).send(buildMessagingTwiML(null));
  }

  const { MessageSid, MessageStatus, To, ErrorCode } = req.body;

  const isFailed    = ['undelivered', 'failed'].includes(MessageStatus);
  const toRedacted  = To ? `***${String(To).slice(-4)}` : null;

  // ── 2. Write structured audit log entry ────────────────────────────────────
  writeAuditLog({
    action:   isFailed ? 'sms_delivery_failed' : 'sms_delivery_update',
    actorId:  'system:twilio',
    targetId: MessageSid || 'unknown',
    meta: {
      status:    MessageStatus || 'unknown',
      toRedacted,
      errorCode: ErrorCode || null,
    },
  }).catch(() => {});

  // ── 3. Log failures conspicuously — important for on-call monitoring ───────
  if (isFailed) {
    console.error(
      `[SMS] Delivery ${MessageStatus} | SID: ${MessageSid} | To: ${toRedacted} | ErrorCode: ${ErrorCode || 'none'}`
    );
  }

  // ── 4. Always 200 with empty TwiML — Twilio ignores the body for status CBs
  return res.send(buildMessagingTwiML(null));
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 3 — GET /conversations
// Admin: paginated SMS conversation history
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Returns SMS conversation records from the sms_queue collection for the admin
 * dashboard. Paginated via Firestore cursor. Phone numbers are redacted to
 * last 4 digits in every response — full numbers are never returned via API.
 *
 * Auth: admin or superadmin JWT required.
 *
 * Query params:
 *   limit   number  Max results per page  (default 50, max 200)
 *   cursor  string  Document ID of the last item from the previous page
 *   step    string  Filter by conversation step (greeting|location|urgency|
 *                   confirm|matching|matched|complete|failed)
 */
router.get('/conversations', requireAuth, async (req, res) => {
  const { role } = req.user;

  if (!['admin', 'superadmin'].includes(role)) {
    return res.status(403).json({ error: 'Access denied. Admin role required.' });
  }

  const { cursor: cursorId, step: rawStep, limit: rawLimit } = req.query;
  const pageLimit = Math.min(parseInt(rawLimit, 10) || 50, 200);

  // Validate the step filter against the known enum values
  const validSteps = Object.values(SMS_CONVERSATION_STEPS);
  const stepFilter = rawStep && validSteps.includes(String(rawStep).trim()) ? String(rawStep).trim() : null;

  try {
    let query = db.collection(COLLECTIONS.SMS_QUEUE);

    if (stepFilter) {
      query = query.where('step', '==', stepFilter);
    }

    query = query.orderBy('updatedAt', 'desc').limit(pageLimit);

    // Cursor-based pagination: startAfter the document with the given ID
    if (cursorId) {
      const cursorSnap = await db.collection(COLLECTIONS.SMS_QUEUE).doc(cursorId).get();
      if (cursorSnap.exists) query = query.startAfter(cursorSnap);
    }

    const snap = await query.get();

    const conversations = snap.docs.map(doc => {
      const data = doc.data();

      // PII reduction: never return the full phone number via the API.
      // The conversation history content is preserved for support purposes.
      return {
        id:             doc.id,
        phoneLast4:     data.phone ? `***${String(data.phone).slice(-4)}` : null,
        country:        data.country   || null,
        language:       data.language  || null,
        step:           data.step      || null,
        intakeData:     data.intakeData || null,
        turnCount:      Array.isArray(data.conversationHistory)
                          ? data.conversationHistory.length
                          : 0,
        conversationHistory: (data.conversationHistory || []).map(turn => ({
          role:    turn.role,
          content: turn.content,
        })),
        createdAt:      data.createdAt  || null,
        updatedAt:      data.updatedAt  || null,
      };
    });

    return res.json({
      conversations,
      count:      conversations.length,
      hasMore:    conversations.length === pageLimit,
      nextCursor: conversations.length === pageLimit
        ? conversations[conversations.length - 1].id
        : null,
    });
  } catch (err) {
    console.error('[SMS] GET /conversations error:', err.message);
    return res.status(500).json({ error: 'Could not load conversation history. Please try again.' });
  }
});

module.exports = router;
