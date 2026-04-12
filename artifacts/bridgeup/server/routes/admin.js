'use strict';

/**
 * admin.js — Admin dashboard, tenant management, audit log, AI assistant, system health.
 *
 * Mount point: /api/admin  (index.js: app.use('/api/admin', loadRoute('./routes/admin', 'admin')))
 *
 * Endpoints
 *   GET  /api/admin/dashboard      — Real-time KPI metrics (admin → tenant-scoped, superadmin → all)
 *   GET  /api/admin/tenants        — List all tenant organisations (superadmin only)
 *   POST /api/admin/tenants        — Create a new tenant (superadmin only)
 *   GET  /api/admin/audit-log      — Cursor-paginated audit log (admin → tenant, superadmin → all)
 *   POST /api/admin/ai-assistant   — Natural-language question answered with live Firestore data
 *   GET  /api/admin/system-health  — API / Firestore / Twilio / Stripe status (superadmin only)
 *
 * Security model
 *   - Every endpoint: requireAuth + requireAdminRole (admin or superadmin)
 *   - Tenant isolation enforced on every Firestore query for admin role
 *   - Phone numbers redacted in all outbound responses
 *   - AI assistant endpoint has a dedicated 20 req/min rate limiter
 *   - POST /tenants and GET /system-health require superadmin specifically
 *
 * Firestore composite indexes required (firebase.json or Firebase Console):
 *   needs       : (tenantId ASC, createdAt ASC)
 *   needs       : (tenantId ASC, status ASC)
 *   helpers     : (tenantId ASC, status ASC)
 *   helpers     : (tenantId ASC, status ASC, resolvedCount DESC)
 *   audit_log   : (tenantId ASC, timestamp DESC)
 *   audit_log   : (tenantId ASC, action ASC, timestamp DESC)
 *   users       : (tenantId ASC, flagged ASC)
 */

const express  = require('express');
const rateLimit = require('express-rate-limit');
const {
  db,
  FieldValue,
  Timestamp,
  COLLECTIONS,
  queryToArray,
  writeAuditLog,
} = require('../services/firebase');
const { requireAuth } = require('./auth');
const { answerAdminQuestion } = require('../services/claude');

const router = express.Router();

// ─── Constants ────────────────────────────────────────────────────────────────

const VALID_PLANS        = ['free', 'pro', 'ngo', 'enterprise'];
const DOC_ID_PATTERN     = /^[a-zA-Z0-9]{10,128}$/;
const EMAIL_PATTERN      = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PAGE_SIZE_DEFAULT  = 20;
const PAGE_SIZE_MAX      = 100;

// ─── AI assistant rate limiter: 20 requests per minute per IP ────────────────
// Separate from the general 100/min limiter in index.js — Claude API calls are
// expensive; this prevents a single admin from hammering the AI endpoint.
const aiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'You have sent too many AI assistant requests. Please wait before asking again.',
  },
  keyGenerator: (req) => req.user?.userId || req.ip,
});

// ─── Role middleware ──────────────────────────────────────────────────────────

/**
 * Allows admin or superadmin through; rejects everyone else with 403.
 */
function requireAdminRole(req, res, next) {
  const role = req.user?.role;
  if (role !== 'admin' && role !== 'superadmin') {
    return res.status(403).json({ error: 'Admin or superadmin role required.' });
  }
  next();
}

/**
 * Allows only superadmin through; rejects everyone else (including admin) with 403.
 */
function requireSuperAdmin(req, res, next) {
  if (req.user?.role !== 'superadmin') {
    return res.status(403).json({ error: 'Superadmin access required.' });
  }
  next();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Masks the phone field in a plain object: "+250788123456" → "***3456".
 * Safe to call on any object — no-ops if no phone field present.
 */
function redactPhone(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const out = { ...obj };
  if ('phone' in out && out.phone) {
    out.phone = '***' + String(out.phone).slice(-4);
  }
  return out;
}

/**
 * Recursively converts Firestore Timestamps to ISO strings in a plain object.
 * Also handles nested objects but not arrays of objects (flatten before passing).
 */
function serializeTimestamps(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v.toDate === 'function') {
      // Firestore Timestamp
      out[k] = v.toDate().toISOString();
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = serializeTimestamps(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Returns a Firestore CollectionReference scoped to a tenant when the caller
 * is an admin. Superadmins receive the unscoped collection reference.
 *
 * @param {string}      collection  — COLLECTIONS constant value
 * @param {string|null} tenantId    — null for superadmin (no scoping)
 * @returns {FirebaseFirestore.CollectionReference | FirebaseFirestore.Query}
 */
function scopedCollection(collection, tenantId) {
  const ref = db.collection(collection);
  return tenantId ? ref.where('tenantId', '==', tenantId) : ref;
}

// ─── Topic-driven context fetcher for the AI assistant ────────────────────────
/**
 * Inspects the admin's question and fetches only the Firestore collections
 * relevant to that topic. Always includes a lightweight dashboard summary so
 * Claude has baseline context regardless of the question.
 *
 * @param {string}      question  — raw question text
 * @param {string}      role      — 'admin' | 'superadmin'
 * @param {string|null} tenantId  — null for superadmin
 * @returns {Promise<Object>}     — plain context object passed to answerAdminQuestion
 */
async function fetchContextData(question, role, tenantId) {
  const q          = question.toLowerCase();
  const scopeTid   = role === 'superadmin' ? null : tenantId;
  const data       = {};
  const fetches    = [];

  // ── Helpers / approvals ──────────────────────────────────────────────────────
  if (/helper|approv|verif|pending|volunteer/.test(q)) {
    fetches.push(
      scopedCollection(COLLECTIONS.HELPERS, scopeTid)
        .where('status', '==', 'pending').limit(20).get()
        .then(s => { data.pendingHelpers = queryToArray(s).map(redactPhone); })
    );
    fetches.push(
      scopedCollection(COLLECTIONS.HELPERS, scopeTid)
        .where('status', '==', 'active').limit(20).get()
        .then(s => { data.activeHelpers = queryToArray(s).map(redactPhone); })
    );
  }

  // ── Needs / crises / resolutions ────────────────────────────────────────────
  if (/need|crisis|request|resolv|case|submission/.test(q)) {
    fetches.push(
      scopedCollection(COLLECTIONS.NEEDS, scopeTid)
        .orderBy('createdAt', 'desc').limit(20).get()
        .then(s => { data.recentNeeds = queryToArray(s).map(redactPhone); })
    );
  }

  // ── Payments / revenue / subscription ───────────────────────────────────────
  if (/payment|subscription|revenue|billing|invoice|stripe|mobile.?money|flutterwave/.test(q)) {
    // Payments collection has no tenantId isolation yet — superadmin only
    if (role === 'superadmin') {
      fetches.push(
        db.collection(COLLECTIONS.PAYMENTS).orderBy('createdAt', 'desc').limit(20).get()
          .then(s => { data.recentPayments = queryToArray(s); })
      );
    }
  }

  // ── Audit log ────────────────────────────────────────────────────────────────
  if (/audit|log|action|history|who did|who changed/.test(q)) {
    let auditQ = db.collection(COLLECTIONS.AUDIT_LOG).orderBy('timestamp', 'desc').limit(20);
    if (scopeTid) {
      auditQ = db.collection(COLLECTIONS.AUDIT_LOG)
        .where('tenantId', '==', scopeTid)
        .orderBy('timestamp', 'desc').limit(20);
    }
    fetches.push(
      auditQ.get().then(s => { data.recentAuditLog = queryToArray(s).map(serializeTimestamps); })
    );
  }

  // ── Tenants / organisations ──────────────────────────────────────────────────
  if (/tenant|organ|ngo|partner|client/.test(q) && role === 'superadmin') {
    fetches.push(
      db.collection(COLLECTIONS.TENANTS).orderBy('createdAt', 'desc').limit(20).get()
        .then(s => { data.tenants = queryToArray(s).map(serializeTimestamps); })
    );
  }

  // ── Flagged accounts ─────────────────────────────────────────────────────────
  if (/flag|suspend|block|ban|abuse|report/.test(q)) {
    fetches.push(
      scopedCollection(COLLECTIONS.USERS, scopeTid)
        .where('flagged', '==', true).limit(20).get()
        .then(s => { data.flaggedUsers = queryToArray(s).map(redactPhone); })
    );
  }

  // ── Always-included dashboard summary ────────────────────────────────────────
  fetches.push(
    Promise.all([
      scopedCollection(COLLECTIONS.NEEDS, scopeTid).get(),
      scopedCollection(COLLECTIONS.NEEDS, scopeTid).where('status', '==', 'resolved').get(),
      scopedCollection(COLLECTIONS.HELPERS, scopeTid).where('status', '==', 'active').get(),
      scopedCollection(COLLECTIONS.HELPERS, scopeTid).where('status', '==', 'pending').get(),
    ]).then(([allNeeds, resolved, activeH, pendingH]) => {
      const total = allNeeds.size;
      data.summary = {
        totalNeeds:      total,
        resolvedNeeds:   resolved.size,
        resolutionRate:  total > 0 ? Math.round((resolved.size / total) * 100) : 0,
        activeHelpers:   activeH.size,
        pendingHelpers:  pendingH.size,
        dataScope:       role === 'superadmin' ? 'all_tenants' : tenantId,
      };
    })
  );

  await Promise.all(fetches);
  return data;
}

// ─── GET /api/admin/dashboard ─────────────────────────────────────────────────
/**
 * Returns real-time KPI metrics.
 * Admin role → data scoped strictly to req.user.tenantId.
 * Superadmin → aggregate across all tenants.
 *
 * Metrics returned:
 *   needsToday, needsAllTime, needsResolved, resolutionRate (%),
 *   activeHelpers, pendingApprovals, flaggedAccounts
 * Plus: top 5 helpers by resolution rate (resolved / totalAssigned)
 */
router.get('/dashboard', requireAuth, requireAdminRole, async (req, res, next) => {
  try {
    const { role, tenantId } = req.user;
    const scopeTid           = role === 'superadmin' ? null : tenantId;

    // Start of today in UTC — used for "needsToday" count
    const startOfToday = new Date();
    startOfToday.setUTCHours(0, 0, 0, 0);
    const todayTs = Timestamp.fromDate(startOfToday);

    // All 7 Firestore queries run concurrently
    const [
      needsTodaySnap,
      needsAllSnap,
      needsResolvedSnap,
      helpersActiveSnap,
      helpersPendingSnap,
      flaggedUsersSnap,
      topHelpersSnap,
    ] = await Promise.all([
      // Needs submitted today
      scopedCollection(COLLECTIONS.NEEDS, scopeTid)
        .where('createdAt', '>=', todayTs).get(),
      // All-time needs
      scopedCollection(COLLECTIONS.NEEDS, scopeTid).get(),
      // Resolved needs
      scopedCollection(COLLECTIONS.NEEDS, scopeTid)
        .where('status', '==', 'resolved').get(),
      // Active helpers
      scopedCollection(COLLECTIONS.HELPERS, scopeTid)
        .where('status', '==', 'active').get(),
      // Helpers awaiting approval
      scopedCollection(COLLECTIONS.HELPERS, scopeTid)
        .where('status', '==', 'pending').get(),
      // Flagged user accounts
      scopedCollection(COLLECTIONS.USERS, scopeTid)
        .where('flagged', '==', true).get(),
      // Top helpers (fetch 10, then re-sort and slice to 5 after computing rate)
      scopedCollection(COLLECTIONS.HELPERS, scopeTid)
        .where('status', '==', 'active')
        .orderBy('resolvedCount', 'desc')
        .limit(10).get(),
    ]);

    const needsAllTime   = needsAllSnap.size;
    const needsResolved  = needsResolvedSnap.size;
    const resolutionRate = needsAllTime > 0
      ? Math.round((needsResolved / needsAllTime) * 100)
      : 0;

    // Compute per-helper resolution rate, sort, take top 5
    const topHelpers = topHelpersSnap.docs
      .map(doc => {
        const d           = doc.data();
        const resolved    = typeof d.resolvedCount === 'number'    ? d.resolvedCount    : 0;
        const assigned    = typeof d.totalAssigned === 'number'    ? d.totalAssigned    : 0;
        const rate        = assigned > 0 ? Math.round((resolved / assigned) * 100) : 0;
        return {
          id:             doc.id,
          name:           d.name           || '—',
          category:       d.category       || null,
          location:       d.location       || null,
          tenantId:       d.tenantId       || null,
          resolvedCount:  resolved,
          totalAssigned:  assigned,
          resolutionRate: rate,
        };
      })
      .sort((a, b) => b.resolutionRate - a.resolutionRate)
      .slice(0, 5);

    res.json({
      scope:       role === 'superadmin' ? 'all_tenants' : tenantId,
      generatedAt: new Date().toISOString(),
      metrics: {
        needsToday:       needsTodaySnap.size,
        needsAllTime,
        needsResolved,
        resolutionRate,
        activeHelpers:    helpersActiveSnap.size,
        pendingApprovals: helpersPendingSnap.size,
        flaggedAccounts:  flaggedUsersSnap.size,
      },
      topHelpers,
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/admin/tenants ───────────────────────────────────────────────────
/**
 * Returns all tenant organisations. Superadmin only.
 * Ordered by creation date descending (newest first).
 */
router.get('/tenants', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const snap = await db.collection(COLLECTIONS.TENANTS)
      .orderBy('createdAt', 'desc')
      .get();

    const tenants = snap.docs.map(doc =>
      serializeTimestamps({ id: doc.id, ...doc.data() })
    );

    res.json({ tenants, total: tenants.length });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/admin/tenants ──────────────────────────────────────────────────
/**
 * Creates a new tenant organisation. Superadmin only.
 *
 * Body: { name: string, plan: "free"|"pro"|"ngo"|"enterprise", contactEmail: string }
 *
 * Validation:
 *   name          — 2–100 chars, must be unique (case-sensitive)
 *   plan          — must be one of VALID_PLANS
 *   contactEmail  — valid email format
 *
 * Writes an audit log entry on success.
 */
router.post('/tenants', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const { name, plan, contactEmail } = req.body || {};

    // ── Input validation ────────────────────────────────────────────────────────
    if (
      !name ||
      typeof name !== 'string' ||
      name.trim().length < 2 ||
      name.trim().length > 100
    ) {
      return res.status(400).json({ error: 'Tenant name must be between 2 and 100 characters.' });
    }

    if (!VALID_PLANS.includes(plan)) {
      return res.status(400).json({
        error: `Plan must be one of: ${VALID_PLANS.join(', ')}.`,
      });
    }

    if (!contactEmail || typeof contactEmail !== 'string' || !EMAIL_PATTERN.test(contactEmail)) {
      return res.status(400).json({ error: 'A valid contact email address is required.' });
    }

    const cleanName  = name.trim();
    const cleanEmail = contactEmail.toLowerCase().trim();

    // ── Duplicate name check ────────────────────────────────────────────────────
    const dupSnap = await db.collection(COLLECTIONS.TENANTS)
      .where('name', '==', cleanName)
      .limit(1)
      .get();

    if (!dupSnap.empty) {
      return res.status(409).json({
        error: `A tenant organisation named "${cleanName}" already exists.`,
      });
    }

    // ── Write tenant document ────────────────────────────────────────────────────
    const now    = FieldValue.serverTimestamp();
    const docRef = await db.collection(COLLECTIONS.TENANTS).add({
      name:         cleanName,
      plan,
      contactEmail: cleanEmail,
      status:       'active',
      createdBy:    req.user.userId,
      createdAt:    now,
      updatedAt:    now,
    });

    // Fire-and-forget audit log (never block the response)
    writeAuditLog({
      action:   'tenant_created',
      actorId:  req.user.userId,
      targetId: docRef.id,
      tenantId: null,             // system-level action, not scoped to a tenant
      meta:     { name: cleanName, plan, contactEmail: cleanEmail },
    }).catch(() => {});

    res.status(201).json({
      id:      docRef.id,
      message: `Tenant "${cleanName}" created successfully.`,
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/admin/audit-log ─────────────────────────────────────────────────
/**
 * Returns audit log entries with cursor-based pagination.
 *
 * Tenant isolation:
 *   admin      → only entries where tenantId === req.user.tenantId
 *   superadmin → all entries across all tenants
 *
 * Query params:
 *   cursor     — Document ID of the last item from the previous page
 *   limit      — Items per page (1–100, default 20)
 *   action     — Filter by exact action string (e.g. "tenant_created")
 *   startDate  — ISO date string, inclusive lower bound on timestamp
 *   endDate    — ISO date string, inclusive upper bound (end-of-day)
 */
router.get('/audit-log', requireAuth, requireAdminRole, async (req, res, next) => {
  try {
    const { role, tenantId } = req.user;
    const isSuperAdmin       = role === 'superadmin';
    const {
      action,
      cursor,
      limit: limitParam,
      startDate,
      endDate,
    } = req.query;

    // ── Validate limit ──────────────────────────────────────────────────────────
    const limit = Math.min(
      Math.max(parseInt(limitParam, 10) || PAGE_SIZE_DEFAULT, 1),
      PAGE_SIZE_MAX
    );

    // ── Validate cursor ─────────────────────────────────────────────────────────
    if (cursor && !DOC_ID_PATTERN.test(cursor)) {
      return res.status(400).json({ error: 'Invalid cursor value.' });
    }

    // ── Validate date range ─────────────────────────────────────────────────────
    let startTs, endTs;
    if (startDate) {
      const d = new Date(startDate);
      if (isNaN(d.getTime())) {
        return res.status(400).json({ error: 'Invalid startDate. Use ISO 8601 format (e.g. 2025-01-01).' });
      }
      startTs = Timestamp.fromDate(d);
    }
    if (endDate) {
      const d = new Date(endDate);
      if (isNaN(d.getTime())) {
        return res.status(400).json({ error: 'Invalid endDate. Use ISO 8601 format (e.g. 2025-01-31).' });
      }
      // Include the full end day by rolling to 23:59:59.999
      endTs = Timestamp.fromDate(new Date(d.getTime() + 86_400_000 - 1));
    }

    // ── Build query ─────────────────────────────────────────────────────────────
    let query = db.collection(COLLECTIONS.AUDIT_LOG);

    // Tenant isolation: admin can only see entries tagged with their tenantId
    if (!isSuperAdmin) {
      query = query.where('tenantId', '==', tenantId);
    }

    // Optional action filter
    if (action) {
      query = query.where('action', '==', String(action));
    }

    // Date range — applied before orderBy to satisfy Firestore's index requirements
    if (startTs) query = query.where('timestamp', '>=', startTs);
    if (endTs)   query = query.where('timestamp', '<=', endTs);

    query = query.orderBy('timestamp', 'desc');

    // Cursor pagination — fetch the cursor document and startAfter it
    if (cursor) {
      const cursorDoc = await db.collection(COLLECTIONS.AUDIT_LOG).doc(cursor).get();
      if (cursorDoc.exists) {
        query = query.startAfter(cursorDoc);
      }
    }

    // Fetch limit + 1 so we know if there is a next page
    query = query.limit(limit + 1);

    const snap    = await query.get();
    const hasMore = snap.docs.length > limit;
    const docs    = hasMore ? snap.docs.slice(0, limit) : snap.docs;

    const entries = docs.map(doc => {
      const d = doc.data();
      return serializeTimestamps(redactPhone({
        id:       doc.id,
        action:   d.action,
        actorId:  d.actorId,
        targetId: d.targetId,
        tenantId: d.tenantId || null,
        meta:     d.meta     || {},
        timestamp: d.timestamp,
      }));
    });

    res.json({
      entries,
      nextCursor: hasMore ? docs[docs.length - 1].id : null,
      hasMore,
      limit,
    });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/admin/ai-assistant ─────────────────────────────────────────────
/**
 * Answers a natural-language question using live Firestore context.
 * Rate limited to 20 requests per minute per user to prevent Claude API abuse.
 *
 * Body:
 *   question  {string}     — The admin's question (max 1 000 chars)
 *   language  {string?}    — ISO 639-1 code for response language (default: 'en')
 *   history   {Object[]?}  — Prior {role, content} turns for multi-turn sessions
 *
 * Behaviour:
 *   1. Keyword-matches the question against known topics
 *   2. Fetches only the relevant Firestore collections (not everything)
 *   3. Calls answerAdminQuestion() from claude.js with the curated data
 *   4. Returns Claude's plain-language answer
 *
 * Tenant isolation: context data is always scoped to req.user.tenantId for admin;
 * superadmin receives aggregate data.
 */
router.post('/ai-assistant', requireAuth, requireAdminRole, aiLimiter, async (req, res, next) => {
  try {
    const { role, tenantId, userId } = req.user;
    const { question, language = 'en', history = [] } = req.body || {};

    // ── Input validation ────────────────────────────────────────────────────────
    if (!question || typeof question !== 'string' || !question.trim()) {
      return res.status(400).json({ error: 'A question is required.' });
    }
    if (question.length > 1_000) {
      return res.status(400).json({ error: 'Question must be 1 000 characters or fewer.' });
    }
    if (typeof language !== 'string' || !/^[a-z]{2,3}(-[A-Z]{2})?$/.test(language)) {
      return res.status(400).json({ error: 'Invalid language code. Use ISO 639-1 format (e.g. "en", "fr", "rw").' });
    }
    if (!Array.isArray(history)) {
      return res.status(400).json({ error: 'History must be an array of conversation turns.' });
    }
    // Cap history depth to prevent token explosion
    if (history.length > 20) {
      return res.status(400).json({ error: 'Conversation history exceeds the 20-turn limit.' });
    }

    // ── Fetch relevant Firestore context ────────────────────────────────────────
    const firestoreData = await fetchContextData(
      question.trim(),
      role,
      role === 'superadmin' ? null : tenantId
    );

    // ── Call Claude ─────────────────────────────────────────────────────────────
    const answer = await answerAdminQuestion(
      question.trim(),
      firestoreData,
      role,                 // 'admin' or 'superadmin' (both handled by claude.js)
      { language, history }
    );

    // Fire-and-forget audit log — never block the response
    writeAuditLog({
      action:   'ai_assistant_query',
      actorId:  userId,
      targetId: userId,
      tenantId: role === 'superadmin' ? null : tenantId,
      meta:     {
        questionLength: question.trim().length,
        language,
        topicsDetected: Object.keys(firestoreData).filter(k => k !== 'summary'),
      },
    }).catch(() => {});

    res.json({
      answer,
      dataFetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    // Surface Claude timeout with a clear message
    if (err.message && err.message.includes('timed out')) {
      return res.status(504).json({
        error: 'The AI assistant took too long to respond. Please try again.',
      });
    }
    next(err);
  }
});

// ─── GET /api/admin/system-health ─────────────────────────────────────────────
/**
 * Returns live status of all external service integrations. Superadmin only.
 *
 * Checks:
 *   api       — always "up" if this handler is reached
 *   firestore — lightweight Firestore read (list 1 tenant document)
 *   twilio    — Twilio balance fetch via REST API
 *   stripe    — Stripe account retrieval
 *
 * Each check is independent — a failure in one never blocks the others.
 * Sensitive values (e.g. Twilio balance amount, Stripe payout status) are
 * included so superadmins can spot billing problems early.
 */
router.get('/system-health', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const checkedAt = new Date().toISOString();

    // ── Lazy SDK getters (mirror pattern from payments.js) ─────────────────────
    function getTwilioClient() {
      const sid   = process.env.TWILIO_ACCOUNT_SID;
      const token = process.env.TWILIO_AUTH_TOKEN;
      if (!sid || !token) throw new Error('TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN not set.');
      return require('twilio')(sid, token);
    }

    function getStripeClient() {
      const key = process.env.STRIPE_SECRET_KEY;
      if (!key) throw new Error('STRIPE_SECRET_KEY not set.');
      return require('stripe')(key);
    }

    // ── Run all checks concurrently, each isolated from the others ────────────
    const [firestoreResult, twilioResult, stripeResult] = await Promise.all([
      // Firestore: list 1 tenant to confirm read access
      (async () => {
        try {
          const snap = await db.collection(COLLECTIONS.TENANTS).limit(1).get();
          return {
            status:       'up',
            latencyMs:    null, // Firestore SDK doesn't expose RTT easily
            tenantsTotal: snap.size > 0 ? '1+' : '0',
          };
        } catch (err) {
          console.error('[Admin/Health] Firestore check failed:', err.message);
          return { status: 'down', error: 'Firestore read failed.' };
        }
      })(),

      // Twilio: fetch account balance
      (async () => {
        try {
          const client  = getTwilioClient();
          const balance = await client.balance.fetch();
          return {
            status:   'up',
            currency: balance.currency,
            balance:  balance.balance,
          };
        } catch (err) {
          console.error('[Admin/Health] Twilio check failed:', err.message);
          const msg = err.message.includes('not set')
            ? 'Twilio credentials not configured.'
            : 'Twilio API unreachable.';
          return { status: 'down', error: msg };
        }
      })(),

      // Stripe: retrieve the connected account
      (async () => {
        try {
          const stripe  = getStripeClient();
          const account = await stripe.accounts.retrieve();
          return {
            status:         'up',
            chargesEnabled: account.charges_enabled,
            payoutsEnabled: account.payouts_enabled,
            country:        account.country,
          };
        } catch (err) {
          console.error('[Admin/Health] Stripe check failed:', err.message);
          const msg = err.message.includes('not set')
            ? 'Stripe credentials not configured.'
            : 'Stripe API unreachable.';
          return { status: 'down', error: msg };
        }
      })(),
    ]);

    const allUp    = firestoreResult.status === 'up'
      && twilioResult.status  === 'up'
      && stripeResult.status  === 'up';

    res.json({
      overall:   allUp ? 'healthy' : 'degraded',
      checkedAt,
      services: {
        api:       { status: 'up' },
        firestore: firestoreResult,
        twilio:    twilioResult,
        stripe:    stripeResult,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
