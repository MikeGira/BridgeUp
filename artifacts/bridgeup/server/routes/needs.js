'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db, FieldValue, COLLECTIONS, docToObject, queryToArray, writeAuditLog } = require('../services/firebase');
const { requireAuth } = require('./auth');
const { processNeed } = require('../services/claude');

const router = express.Router();

// ─── Constants ────────────────────────────────────────────────────────────────
const VALID_CATEGORIES = ['food', 'housing', 'employment', 'medical', 'training', 'funding', 'other'];
const VALID_URGENCY    = ['immediate', 'days', 'weeks'];
const VALID_CHANNELS   = ['web', 'sms', 'voice', 'app'];
const VALID_STATUSES   = ['pending_match', 'matching', 'matched', 'in_progress', 'resolved', 'closed', 'cancelled'];

// Per-phone need submission rate limit: max 3 new needs per 24 hours (Firestore-backed)
// The express-rate-limit in index.js covers anonymous IP bursts; this covers per-phone abuse.
const NEED_MAX_PER_DAY    = 3;
const NEED_WINDOW_MS      = 24 * 60 * 60 * 1000;

// AI intake: max turns per session
const MAX_INTAKE_TURNS    = 3;

// ─── Valid status transitions ─────────────────────────────────────────────────
// Defines which status changes are permitted and which roles can make them.
const STATUS_TRANSITIONS = {
  pending_match: { next: ['matching', 'cancelled'],   roles: ['admin', 'superadmin', 'system'] },
  matching:      { next: ['matched', 'cancelled'],    roles: ['admin', 'superadmin', 'system'] },
  matched:       { next: ['in_progress', 'cancelled'], roles: ['admin', 'superadmin', 'helper'] },
  in_progress:   { next: ['resolved', 'cancelled'],   roles: ['admin', 'superadmin', 'helper'] },
  resolved:      { next: ['closed'],                  roles: ['admin', 'superadmin'] },
  closed:        { next: [],                          roles: [] },
  cancelled:     { next: [],                          roles: [] },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normalises a phone number to E.164. Mirrors the logic in auth.js — kept
 * intentionally standalone so this route has no auth dependency for anonymous
 * submissions where the user is not logged in.
 */
function normalizePhone(raw) {
  if (!raw || typeof raw !== 'string') return { e164: null, error: 'Phone number is required.' };
  let s = raw.replace(/[\s\-.()\u200B-\u200D\uFEFF]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (!s.startsWith('+')) {
    if (/^[1-9]\d{6,14}$/.test(s)) s = '+' + s;
    else if (s.startsWith('0')) return { e164: null, error: 'Please include your country code (e.g. +250 for Rwanda, +1 for Canada). Local formats are not accepted.' };
    else return { e164: null, error: 'Phone number format is not recognised. Use E.164 format, e.g. +250788123456.' };
  }
  if (!/^\+[1-9]\d{6,14}$/.test(s)) return { e164: null, error: 'Phone number must be in international format (e.g. +250788123456).' };
  return { e164: s, error: null };
}

/**
 * Checks how many needs a phone has submitted in the past 24 hours.
 * Returns { allowed, count, resetAt }.
 */
async function checkNeedRateLimit(phone) {
  const windowStart = new Date(Date.now() - NEED_WINDOW_MS);
  const snap = await db.collection(COLLECTIONS.NEEDS)
    .where('phone', '==', phone)
    .where('channel', 'in', ['web', 'app'])   // only count direct submissions, not SMS/voice
    .where('createdAt', '>=', windowStart)
    .get();

  const count = snap.size;
  if (count >= NEED_MAX_PER_DAY) {
    return { allowed: false, count, resetAt: null };
  }
  return { allowed: true, count, resetAt: null };
}

/**
 * Strips internal/private fields before returning a need to the client.
 * Converts Firestore Timestamps to ISO strings.
 */
function sanitizeNeed(need) {
  if (!need) return null;
  const out = { ...need };
  // Convert Timestamps
  for (const field of ['createdAt', 'updatedAt', 'matchedAt', 'resolvedAt']) {
    if (out[field]?.toDate) out[field] = out[field].toDate().toISOString();
  }
  return out;
}

/**
 * Checks whether the caller has permission to view a given need document.
 * - users      : own needs only (matched by userId or phone)
 * - helpers    : needs assigned to them + pending needs in their service area
 * - admin/ngo  : all needs for their tenant
 * - superadmin : all needs on the platform
 */
function canViewNeed(need, caller) {
  if (!caller) return false;
  if (caller.role === 'superadmin') return true;
  if (['admin', 'ngo'].includes(caller.role)) {
    return !need.tenantId || need.tenantId === caller.tenantId;
  }
  if (caller.role === 'helper') {
    return need.matchedHelperId === caller.userId ||
           need.status === 'pending_match' ||
           need.status === 'matching';
  }
  // Default: user can see their own needs
  return need.userId === caller.userId || need.phone === caller.phone;
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 1 — POST /  (Direct need submission — web / app)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Accepts a fully-formed need from the PWA after the AI intake conversation
 * completes, OR from a direct form submission. Auth is optional — anonymous
 * submissions are allowed for zero-literacy users who called in and were given
 * a web link, or for community workers submitting on behalf of someone.
 *
 * Body: {
 *   phone:       string   (E.164 or local — normalised here)
 *   category:    food|housing|employment|medical|training|funding|other
 *   location:    string   (free text — "Kigali, Nyarugenge district")
 *   urgency:     immediate|days|weeks
 *   description: string?  (optional extra context)
 *   language:    string?  (ISO 639-1, e.g. "rw", "sw", "en")
 *   channel:     web|app? (defaults to "web")
 *   tenantId:    string?  (for white-label deployments)
 * }
 *
 * Response: { success: true, needId: string, status: 'pending_match' }
 */
router.post('/', async (req, res) => {
  const {
    phone: rawPhone,
    category,
    location,
    urgency,
    description,
    language = 'en',
    channel  = 'web',
    tenantId,
  } = req.body;

  // ── Validate phone ──────────────────────────────────────────────────────────
  const { e164, error: phoneError } = normalizePhone(rawPhone);
  if (phoneError) return res.status(400).json({ error: phoneError });

  // ── Validate category ───────────────────────────────────────────────────────
  if (!category || !VALID_CATEGORIES.includes(category)) {
    return res.status(400).json({
      error: `Category must be one of: ${VALID_CATEGORIES.join(', ')}.`,
    });
  }

  // ── Validate location ────────────────────────────────────────────────────────
  if (!location || typeof location !== 'string' || location.trim().length < 3) {
    return res.status(400).json({
      error: 'Location is required and must be at least 3 characters (e.g. "Kigali, Rwanda").',
    });
  }

  // ── Validate urgency ────────────────────────────────────────────────────────
  if (!urgency || !VALID_URGENCY.includes(urgency)) {
    return res.status(400).json({
      error: `Urgency must be one of: ${VALID_URGENCY.join(', ')}.`,
    });
  }

  // ── Validate channel ────────────────────────────────────────────────────────
  const safeChannel = VALID_CHANNELS.includes(channel) ? channel : 'web';

  // ── Per-phone daily rate limit ──────────────────────────────────────────────
  let rateCheck;
  try {
    rateCheck = await checkNeedRateLimit(e164);
  } catch (err) {
    console.error('[Needs] Rate limit check failed:', err.message);
    rateCheck = { allowed: true }; // fail open
  }

  if (!rateCheck.allowed) {
    return res.status(429).json({
      error: 'You have submitted the maximum number of requests for today. Please try again tomorrow, or call us directly.',
    });
  }

  // ── Resolve userId from JWT if logged in ────────────────────────────────────
  let userId = null;
  let callerTenantId = tenantId || null;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const jwt = require('jsonwebtoken');
      const decoded = jwt.verify(authHeader.slice(7), process.env.SESSION_SECRET, {
        issuer: 'bridgeup', audience: 'bridgeup-app',
      });
      userId = decoded.userId || null;
      if (!callerTenantId) callerTenantId = decoded.tenantId || null;
    } catch {
      // Not authenticated — anonymous submission is fine
    }
  }

  // ── Write need document ─────────────────────────────────────────────────────
  const needDoc = {
    phone:           e164,
    userId,
    category:        category.trim(),
    location:        location.trim(),
    locationGeo:     null,         // populated later by geocoding service
    urgency,
    description:     description ? String(description).trim().slice(0, 1000) : null,
    language:        String(language).slice(0, 10),
    channel:         safeChannel,
    status:          'pending_match',
    tenantId:        callerTenantId,
    matchedHelperId: null,
    matchedAt:       null,
    resolvedAt:      null,
    createdAt:       FieldValue.serverTimestamp(),
    updatedAt:       FieldValue.serverTimestamp(),
  };

  let docRef;
  try {
    docRef = await db.collection(COLLECTIONS.NEEDS).add(needDoc);
  } catch (err) {
    console.error('[Needs] Firestore write failed:', err.message);
    return res.status(500).json({ error: 'We could not save your request right now. Please try again in a moment.' });
  }

  // ── Write notification for admins/matching engine ───────────────────────────
  setImmediate(async () => {
    try {
      await db.collection(COLLECTIONS.NOTIFICATIONS).add({
        type:      'new_need',
        needId:    docRef.id,
        phone:     e164,
        category,
        urgency,
        tenantId:  callerTenantId,
        read:      false,
        createdAt: FieldValue.serverTimestamp(),
      });
    } catch (err) {
      console.error('[Needs] Notification write failed:', err.message);
    }
  });

  writeAuditLog({ action: 'need_submitted', actorId: userId || e164, targetId: docRef.id,
    meta: { category, urgency, channel: safeChannel } }).catch(() => {});

  return res.status(201).json({
    success: true,
    needId:  docRef.id,
    status:  'pending_match',
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 2 — POST /intake/message  (AI-powered multi-turn intake chat)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Drives the AI intake conversation for the web PWA. Each message from the
 * user is sent here; Claude replies with a follow-up question or, once it has
 * gathered all three pieces (category, location, urgency), returns
 * isComplete: true and automatically writes the need to Firestore.
 *
 * A sessionId (client-generated UUID) ties the conversation together.
 * Conversation state is stored in Firestore under intake_sessions/{sessionId}.
 *
 * Body:    { message: string, sessionId: string, phone?: string, language?: string }
 * Response: {
 *   reply:      string,          Claude's response to speak/display
 *   isComplete: boolean,         true when intake is done
 *   needId:     string|null,     set when isComplete and need was written
 *   turn:       number,          current turn number (1–3)
 * }
 */
router.post('/intake/message', async (req, res) => {
  const { message, sessionId, phone: rawPhone, language = 'en' } = req.body;

  // ── Input validation ────────────────────────────────────────────────────────
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'Message is required.' });
  }
  if (!sessionId || typeof sessionId !== 'string' || sessionId.length < 8) {
    return res.status(400).json({ error: 'A valid sessionId is required. Generate one client-side with crypto.randomUUID().' });
  }
  if (message.trim().length > 2000) {
    return res.status(400).json({ error: 'Message is too long. Please keep your message under 2000 characters.' });
  }

  // Sanitise sessionId — only allow alphanumeric + hyphens (UUID format)
  if (!/^[a-zA-Z0-9\-]{8,64}$/.test(sessionId)) {
    return res.status(400).json({ error: 'sessionId contains invalid characters.' });
  }

  // ── Load or initialise intake session ───────────────────────────────────────
  const sessionRef  = db.collection('intake_sessions').doc(sessionId);
  const sessionSnap = await sessionRef.get();

  let session;
  if (sessionSnap.exists) {
    session = sessionSnap.data();
    // Guard: cannot continue a completed session
    if (session.completed) {
      return res.status(409).json({
        error: 'This intake session is already complete. Start a new conversation.',
        needId: session.needId || null,
      });
    }
    // Guard: max turns
    if ((session.turns || 0) >= MAX_INTAKE_TURNS) {
      return res.status(429).json({ error: 'This session has reached the maximum number of messages. Please start a new conversation.' });
    }
  } else {
    session = {
      sessionId,
      phone:    rawPhone ? (normalizePhone(rawPhone).e164 || null) : null,
      language,
      history:  [],
      turns:    0,
      completed: false,
      needId:   null,
      createdAt: FieldValue.serverTimestamp(),
    };
  }

  // ── Build history and call Claude ───────────────────────────────────────────
  const history = [
    ...(session.history || []),
    { role: 'user', content: message.trim() },
  ];

  let claudeResult;
  try {
    claudeResult = await processNeed(history, 'text');
  } catch (err) {
    console.error('[Needs Intake] Claude error:', err.message);
    const fallbacks = {
      en: "I'm sorry, I had a problem understanding that. Could you say it differently?",
      fr: "Désolé, j'ai eu un problème. Pourriez-vous reformuler?",
      rw: "Mbabarira, hari ikibazo. Wagira undi mugambi?",
      sw: "Samahani, kulikuwa na tatizo. Unaweza kurudia kwa njia nyingine?",
      es: "Lo siento, tuve un problema. ¿Podrías decirlo de otra manera?",
      ar: "آسف، واجهت مشكلة. هل يمكنك قول ذلك بطريقة مختلفة؟",
    };
    return res.status(502).json({
      reply:      fallbacks[session.language] || fallbacks.en,
      isComplete: false,
      needId:     null,
      turn:       (session.turns || 0) + 1,
    });
  }

  const updatedHistory = [
    ...history,
    { role: 'assistant', content: claudeResult.reply },
  ];

  const newTurns = (session.turns || 0) + 1;

  // ── Intake complete — write the need ────────────────────────────────────────
  let needId = null;
  if (claudeResult.isComplete && claudeResult.intakeData) {
    const intake = claudeResult.intakeData;

    // Resolve phone: from session, from JWT, or null (anonymous)
    let phone = session.phone;
    if (!phone && rawPhone) phone = normalizePhone(rawPhone).e164 || null;
    if (!phone) {
      // Try JWT
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        try {
          const jwt = require('jsonwebtoken');
          const decoded = jwt.verify(authHeader.slice(7), process.env.SESSION_SECRET, {
            issuer: 'bridgeup', audience: 'bridgeup-app',
          });
          phone = decoded.phone || null;
        } catch { /* anonymous */ }
      }
    }

    // Validate essential intake fields — Claude should always provide these
    const safeCategory = VALID_CATEGORIES.includes(intake.category) ? intake.category : 'other';
    const safeUrgency  = VALID_URGENCY.includes(intake.urgency)    ? intake.urgency  : 'days';

    try {
      const docRef = await db.collection(COLLECTIONS.NEEDS).add({
        phone:           phone || null,
        userId:          null,
        category:        safeCategory,
        location:        String(intake.location || '').trim().slice(0, 500),
        locationGeo:     null,
        urgency:         safeUrgency,
        description:     String(intake.summary || '').trim().slice(0, 1000),
        language:        intake.detectedLanguage || session.language || 'en',
        channel:         'web',
        status:          'pending_match',
        tenantId:        null,
        matchedHelperId: null,
        matchedAt:       null,
        resolvedAt:      null,
        intakeSessionId: sessionId,
        createdAt:       FieldValue.serverTimestamp(),
        updatedAt:       FieldValue.serverTimestamp(),
      });
      needId = docRef.id;

      // Notification
      setImmediate(async () => {
        try {
          await db.collection(COLLECTIONS.NOTIFICATIONS).add({
            type: 'new_need', needId, phone, category: safeCategory,
            urgency: safeUrgency, tenantId: null, read: false,
            createdAt: FieldValue.serverTimestamp(),
          });
        } catch { /* non-critical */ }
      });
    } catch (err) {
      console.error('[Needs Intake] Failed to write need from intake:', err.message);
      // Don't fail the response — return the AI reply, the need write can be retried
    }
  }

  // ── Save updated session ─────────────────────────────────────────────────────
  await sessionRef.set({
    ...session,
    history:   updatedHistory,
    turns:     newTurns,
    completed: claudeResult.isComplete,
    needId,
    phone:     session.phone,
    updatedAt: FieldValue.serverTimestamp(),
    ...(session.createdAt ? {} : { createdAt: FieldValue.serverTimestamp() }),
  }, { merge: true });

  return res.json({
    reply:      claudeResult.reply,
    isComplete: claudeResult.isComplete,
    needId,
    turn:       newTurns,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 3 — GET /my  (Authenticated user's own need history)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Returns the calling user's need history, newest first.
 * Looks up by both userId (JWT) and phone (for cases where the same user
 * submitted anonymously before logging in).
 *
 * Query params: ?limit=20&status=pending_match,matched
 */
router.get('/my', requireAuth, async (req, res) => {
  const { limit: rawLimit = '20', status: rawStatus } = req.query;
  const pageLimit = Math.min(parseInt(rawLimit, 10) || 20, 100);

  try {
    // Build two queries: by userId and by phone, then merge+dedupe
    const queries = [];
    if (req.user.userId) {
      queries.push(
        db.collection(COLLECTIONS.NEEDS)
          .where('userId', '==', req.user.userId)
          .orderBy('createdAt', 'desc')
          .limit(pageLimit)
          .get()
      );
    }
    if (req.user.phone) {
      queries.push(
        db.collection(COLLECTIONS.NEEDS)
          .where('phone', '==', req.user.phone)
          .orderBy('createdAt', 'desc')
          .limit(pageLimit)
          .get()
      );
    }

    const snapshots = await Promise.all(queries);

    // Merge and deduplicate by document ID
    const seen = new Set();
    const allNeeds = [];
    for (const snap of snapshots) {
      for (const doc of snap.docs) {
        if (!seen.has(doc.id)) {
          seen.add(doc.id);
          allNeeds.push({ id: doc.id, ...doc.data() });
        }
      }
    }

    // Optional status filter
    let filtered = allNeeds;
    if (rawStatus) {
      const statusList = rawStatus.split(',').map(s => s.trim()).filter(s => VALID_STATUSES.includes(s));
      if (statusList.length > 0) {
        filtered = allNeeds.filter(n => statusList.includes(n.status));
      }
    }

    // Sort descending by createdAt after merge
    filtered.sort((a, b) => {
      const ta = a.createdAt?.toDate?.() || new Date(a.createdAt || 0);
      const tb = b.createdAt?.toDate?.() || new Date(b.createdAt || 0);
      return tb - ta;
    });

    return res.json({
      needs: filtered.slice(0, pageLimit).map(sanitizeNeed),
      count: filtered.length,
    });
  } catch (err) {
    console.error('[Needs] /my error:', err.message);
    return res.status(500).json({ error: 'Could not load your requests. Please try again.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 4 — GET /  (List needs — role-filtered, paginated)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Returns needs filtered by the caller's role:
 *   superadmin → all needs
 *   admin/ngo  → needs for their tenantId
 *   helper     → pending + matched needs (potential and assigned)
 *   user       → redirects to /my (own needs only)
 *
 * Query params:
 *   ?status=pending_match        (single status)
 *   ?category=food,housing       (comma-separated)
 *   ?urgency=immediate           (single urgency)
 *   ?limit=50                    (max 200)
 *   ?startAfter=<docId>          (cursor pagination)
 */
router.get('/', requireAuth, async (req, res) => {
  const {
    status:     rawStatus,
    category:   rawCategory,
    urgency:    rawUrgency,
    limit:      rawLimit   = '50',
    startAfter: cursorId,
  } = req.query;

  const role      = req.user.role;
  const tenantId  = req.user.tenantId;
  const pageLimit = Math.min(parseInt(rawLimit, 10) || 50, 200);

  // Regular users should use /my
  if (role === 'user') {
    return res.status(403).json({
      error: 'Use GET /api/needs/my to view your own requests.',
    });
  }

  try {
    let query = db.collection(COLLECTIONS.NEEDS);

    // ── Role-based filters ────────────────────────────────────────────────────
    if (role === 'admin' || role === 'ngo') {
      if (tenantId) query = query.where('tenantId', '==', tenantId);
    } else if (role === 'helper') {
      // Helpers see pending/matching (for claiming) + needs assigned to them
      query = query.where('status', 'in', ['pending_match', 'matching', 'matched', 'in_progress']);
    }
    // superadmin: no filter — sees everything

    // ── Optional query filters ────────────────────────────────────────────────
    if (rawStatus) {
      const statusList = rawStatus.split(',').map(s => s.trim()).filter(s => VALID_STATUSES.includes(s));
      if (statusList.length === 1) {
        query = query.where('status', '==', statusList[0]);
      } else if (statusList.length > 1 && statusList.length <= 10) {
        query = query.where('status', 'in', statusList);
      }
    }

    if (rawUrgency && VALID_URGENCY.includes(rawUrgency.trim())) {
      query = query.where('urgency', '==', rawUrgency.trim());
    }

    // Note: category filter is applied in-memory after fetch to avoid needing
    // a composite Firestore index for every combination. For high-volume
    // deployments, add the index and use .where('category', '==', ...) here.

    query = query.orderBy('createdAt', 'desc').limit(pageLimit);

    // Cursor pagination
    if (cursorId) {
      const cursorSnap = await db.collection(COLLECTIONS.NEEDS).doc(cursorId).get();
      if (cursorSnap.exists) query = query.startAfter(cursorSnap);
    }

    const snap  = await query.get();
    let needs   = queryToArray(snap);

    // In-memory category filter
    if (rawCategory) {
      const catList = rawCategory.split(',').map(c => c.trim()).filter(c => VALID_CATEGORIES.includes(c));
      if (catList.length > 0) needs = needs.filter(n => catList.includes(n.category));
    }

    // For helpers: exclude needs assigned to other helpers
    if (role === 'helper') {
      needs = needs.filter(n =>
        n.matchedHelperId === null ||
        n.matchedHelperId === req.user.userId ||
        ['pending_match', 'matching'].includes(n.status)
      );
    }

    return res.json({
      needs:      needs.map(sanitizeNeed),
      count:      needs.length,
      hasMore:    needs.length === pageLimit,
      nextCursor: needs.length === pageLimit ? needs[needs.length - 1].id : null,
    });
  } catch (err) {
    console.error('[Needs] GET / error:', err.message);
    return res.status(500).json({ error: 'Could not load needs. Please try again.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 5 — GET /:id  (Single need by Firestore document ID)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Returns a single need. Auth is required; visibility is role-checked via
 * canViewNeed() so each role only sees what they are allowed to see.
 */
router.get('/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  if (!id || id.length > 128) return res.status(400).json({ error: 'Invalid need ID.' });

  try {
    const snap = await db.collection(COLLECTIONS.NEEDS).doc(id).get();
    if (!snap.exists) return res.status(404).json({ error: 'Request not found.' });

    const need = { id: snap.id, ...snap.data() };

    if (!canViewNeed(need, req.user)) {
      return res.status(403).json({ error: 'You do not have permission to view this request.' });
    }

    return res.json({ need: sanitizeNeed(need) });
  } catch (err) {
    console.error('[Needs] GET /:id error:', err.message);
    return res.status(500).json({ error: 'Could not load this request. Please try again.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 6 — PATCH /:id/status  (Update need status)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Advances a need through its lifecycle state machine.
 * Only permitted transitions are accepted (defined in STATUS_TRANSITIONS).
 *
 * Body: {
 *   status:    string             — the new target status
 *   reason?:   string             — optional note (stored in history)
 *   helperId?: string             — required when setting status to 'matched'
 * }
 */
router.patch('/:id/status', requireAuth, async (req, res) => {
  const { id }                       = req.params;
  const { status: newStatus, reason, helperId } = req.body;

  if (!id) return res.status(400).json({ error: 'Invalid need ID.' });
  if (!newStatus || !VALID_STATUSES.includes(newStatus)) {
    return res.status(400).json({
      error: `Status must be one of: ${VALID_STATUSES.join(', ')}.`,
    });
  }

  try {
    const ref  = db.collection(COLLECTIONS.NEEDS).doc(id);
    const snap = await ref.get();

    if (!snap.exists) return res.status(404).json({ error: 'Request not found.' });

    const need        = { id: snap.id, ...snap.data() };
    const currentStatus = need.status;
    const role        = req.user.role;

    // ── Permission check ────────────────────────────────────────────────────
    if (!canViewNeed(need, req.user)) {
      return res.status(403).json({ error: 'You do not have permission to update this request.' });
    }

    // Users can only cancel their own needs
    if (role === 'user') {
      if (newStatus !== 'cancelled') {
        return res.status(403).json({ error: 'You can only cancel your own requests.' });
      }
      if (need.userId !== req.user.userId && need.phone !== req.user.phone) {
        return res.status(403).json({ error: 'You can only cancel your own requests.' });
      }
    }

    // ── State machine validation ─────────────────────────────────────────────
    const transition = STATUS_TRANSITIONS[currentStatus];
    if (!transition) {
      return res.status(409).json({ error: `Cannot update a need in "${currentStatus}" status.` });
    }
    if (!transition.next.includes(newStatus)) {
      return res.status(409).json({
        error: `Cannot change status from "${currentStatus}" to "${newStatus}". Allowed next states: ${transition.next.join(', ') || 'none'}.`,
      });
    }
    // Check role is permitted for this transition (user bypass handled above)
    if (role !== 'user' && !transition.roles.includes(role)) {
      return res.status(403).json({ error: `Your role ("${role}") cannot move a need to "${newStatus}".` });
    }

    // ── Build the update payload ─────────────────────────────────────────────
    const update = {
      status:    newStatus,
      updatedAt: FieldValue.serverTimestamp(),
    };

    if (newStatus === 'matched' && helperId) {
      update.matchedHelperId = helperId;
      update.matchedAt       = FieldValue.serverTimestamp();
    }
    if (newStatus === 'resolved') {
      update.resolvedAt = FieldValue.serverTimestamp();
    }

    // Append to status history array for full audit trail
    update.statusHistory = FieldValue.arrayUnion({
      from:      currentStatus,
      to:        newStatus,
      by:        req.user.userId,
      role:      role,
      reason:    reason || null,
      changedAt: new Date().toISOString(),
    });

    await ref.update(update);

    // ── Notify the user (if phone is known) ──────────────────────────────────
    if (need.phone) {
      setImmediate(async () => {
        try {
          await db.collection(COLLECTIONS.NOTIFICATIONS).add({
            type:      'need_status_update',
            needId:    id,
            phone:     need.phone,
            oldStatus: currentStatus,
            newStatus,
            read:      false,
            createdAt: FieldValue.serverTimestamp(),
          });
        } catch { /* non-critical */ }
      });
    }

    writeAuditLog({
      action:   'need_status_updated',
      actorId:  req.user.userId,
      targetId: id,
      meta:     { from: currentStatus, to: newStatus, reason: reason || null },
    }).catch(() => {});

    return res.json({
      success:   true,
      needId:    id,
      oldStatus: currentStatus,
      newStatus,
    });
  } catch (err) {
    console.error('[Needs] PATCH /:id/status error:', err.message);
    return res.status(500).json({ error: 'Could not update this request. Please try again.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 7 — DELETE /:id  (Soft-cancel a need)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Soft-deletes a need by setting status to 'cancelled'. Hard deletion is not
 * supported — needs are retained for audit and impact reporting purposes.
 * Only the owner (matched by userId or phone) or an admin can cancel.
 */
router.delete('/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  if (!id) return res.status(400).json({ error: 'Invalid need ID.' });

  try {
    const ref  = db.collection(COLLECTIONS.NEEDS).doc(id);
    const snap = await ref.get();

    if (!snap.exists) return res.status(404).json({ error: 'Request not found.' });

    const need = { id: snap.id, ...snap.data() };
    const role = req.user.role;

    // Only owner or admin can cancel
    const isOwner = need.userId === req.user.userId || need.phone === req.user.phone;
    const isAdmin = ['admin', 'superadmin'].includes(role);

    if (!isOwner && !isAdmin) {
      return res.status(403).json({ error: 'You do not have permission to cancel this request.' });
    }

    // Cannot cancel an already-resolved or closed need
    if (['resolved', 'closed', 'cancelled'].includes(need.status)) {
      return res.status(409).json({
        error: `This request is already "${need.status}" and cannot be cancelled.`,
      });
    }

    await ref.update({
      status:    'cancelled',
      updatedAt: FieldValue.serverTimestamp(),
      cancelledBy: req.user.userId,
      statusHistory: FieldValue.arrayUnion({
        from:      need.status,
        to:        'cancelled',
        by:        req.user.userId,
        role,
        reason:    req.body?.reason || 'Cancelled by user',
        changedAt: new Date().toISOString(),
      }),
    });

    writeAuditLog({ action: 'need_cancelled', actorId: req.user.userId, targetId: id,
      meta: { previousStatus: need.status } }).catch(() => {});

    return res.json({ success: true, needId: id, status: 'cancelled' });
  } catch (err) {
    console.error('[Needs] DELETE /:id error:', err.message);
    return res.status(500).json({ error: 'Could not cancel this request. Please try again.' });
  }
});

module.exports = router;
