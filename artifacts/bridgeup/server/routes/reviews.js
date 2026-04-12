'use strict';

/**
 * reviews.js — Review submission, moderation, and retrieval for BridgeUp matches.
 *
 * Mount: /api/reviews  (index.js: app.use('/api/reviews', loadRoute('./routes/reviews', 'reviews')))
 *
 * Endpoints:
 *   POST  /api/reviews/submit           — Submit a review for a resolved match (auth)
 *   GET   /api/reviews/my               — My submitted reviews (auth)
 *   GET   /api/reviews/pending          — Resolved needs awaiting my review (auth)
 *   GET   /api/reviews/flagged          — All flagged reviews (admin/superadmin, tenant-scoped)
 *   GET   /api/reviews/helper/:id       — Public paginated reviews for an approved helper
 *   POST  /api/reviews/:id/flag         — Flag an inappropriate review (auth)
 *   PATCH /api/reviews/:id/moderate     — Moderate a flagged review (admin only)
 *
 * Review document schema (all stored fields):
 *   matchId, needId, helperId, reviewerId, reviewerRole, rating, comment,
 *   reviewType, tenantId, createdAt,
 *   isFlagged (false), flagReason (null), flaggedAt (null), flaggedBy (null),
 *   isModerated (false), moderatedAt (null), moderatedBy (null), isVisible (true)
 *
 * Security:
 *   - requireAuth on all endpoints except GET /helper/:id (public, paginated)
 *   - Duplicate guard: one review per reviewerId + matchId pair
 *   - Tenant isolation: admin endpoints scope to req.user.tenantId; superadmin sees all
 *   - Reviewer phone numbers never returned in any response
 *   - Rating update runs inside a Firestore transaction (running average)
 *
 * Firestore composite indexes required:
 *   reviews: (reviewerId ASC, matchId ASC)                      — duplicate guard
 *   reviews: (reviewerId ASC, createdAt DESC)                    — GET /my
 *   reviews: (helperId ASC, isVisible ASC, createdAt DESC)       — GET /helper/:id
 *   reviews: (isFlagged ASC, tenantId ASC, createdAt DESC)       — GET /flagged
 *   needs:   (userId ASC, status ASC)                            — GET /pending
 */

const express   = require('express');
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

const router = express.Router();

// ─── Constants ────────────────────────────────────────────────────────────────

const VALID_REVIEW_TYPES = ['need_to_helper', 'helper_to_need'];
const ADMIN_ROLES        = new Set(['admin', 'superadmin']);
const DOC_ID_PATTERN     = /^[a-zA-Z0-9]{10,128}$/;
const PAGE_SIZE_DEFAULT  = 20;
const PAGE_SIZE_MAX      = 50;

// ─── Rate limiters ────────────────────────────────────────────────────────────

// Submit: 5/min per user — involves 2 Firestore reads + a transaction per request
const submitLimiter = rateLimit({
  windowMs:        60 * 1000,
  max:             5,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'Too many review submissions. Please wait before submitting again.' },
  keyGenerator:    (req) => req.user?.userId || req.ip,
});

// General: 30/min per authenticated user for read endpoints
const readLimiter = rateLimit({
  windowMs:        60 * 1000,
  max:             30,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'Too many requests. Please wait a moment.' },
  keyGenerator:    (req) => req.user?.userId || req.ip,
});

// Public: 30/min per IP for unauthenticated endpoints (GET /helper/:id)
// The global 100/min IP limiter in index.js is too loose for endpoints
// that perform multiple Firestore reads without any auth gate.
const publicLimiter = rateLimit({
  windowMs:        60 * 1000,
  max:             30,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'Too many requests. Please wait a moment.' },
  keyGenerator:    (req) => req.ip,
});

// ─── Role middleware ──────────────────────────────────────────────────────────

function requireAdminOrSuper(req, res, next) {
  if (!ADMIN_ROLES.has(req.user?.role)) {
    return res.status(403).json({ error: 'Admin or superadmin role required.' });
  }
  next();
}

function requireAdminOnly(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin role required to moderate reviews.' });
  }
  next();
}

// ─── Utility helpers ──────────────────────────────────────────────────────────

/** Converts a Firestore Timestamp or Date to ISO string, or null. */
function tsToISO(val) {
  if (!val) return null;
  if (typeof val.toDate === 'function') return val.toDate().toISOString();
  if (val instanceof Date) return val.toISOString();
  return null;
}

/**
 * Formats a review document for API response.
 * Never includes reviewer phone numbers.
 * includeReviewerId: true for owner-scoped or admin views; false for public views.
 */
function formatReview(r, { includeReviewerId = false, includeFlagReason = false } = {}) {
  return {
    id:           r.id,
    matchId:      r.matchId      || null,
    needId:       r.needId       || null,
    helperId:     r.helperId     || null,
    reviewerRole: r.reviewerRole || null,
    ...(includeReviewerId  ? { reviewerId:  r.reviewerId  || null } : {}),
    ...(includeFlagReason  ? { flagReason:  r.flagReason  || null,
                                flaggedAt:   tsToISO(r.flaggedAt),
                                flaggedBy:   r.flaggedBy   || null } : {}),
    rating:       r.rating,
    comment:      r.comment      || null,
    reviewType:   r.reviewType,
    isFlagged:    r.isFlagged    ?? false,
    isModerated:  r.isModerated  ?? false,
    isVisible:    r.isVisible    ?? true,
    createdAt:    tsToISO(r.createdAt),
    moderatedAt:  tsToISO(r.moderatedAt),
    moderatedBy:  r.moderatedBy  || null,
  };
}

/**
 * Writes a notification document non-critically (swallowed on failure).
 * Called via setImmediate so it never delays the HTTP response.
 */
async function writeNotification(payload) {
  try {
    await db.collection(COLLECTIONS.NOTIFICATIONS).add({
      ...payload,
      read:      false,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error('[Reviews] Notification write failed:', err.message);
  }
}

// ─── Running-average rating update ───────────────────────────────────────────

/**
 * Updates the helper's `rating` field using a running average inside a
 * Firestore transaction so concurrent review submissions don't race each other.
 *
 * Formula: newRating = ((currentRating × currentCount) + newRating) / (currentCount + 1)
 *
 * The helper doc is expected to carry `ratingCount` (integer).
 * Legacy docs without `ratingCount` are treated as having 1 prior rating.
 */
async function updateHelperRating(helperId, newRating) {
  const helperRef = db.collection(COLLECTIONS.HELPERS).doc(helperId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(helperRef);
    if (!snap.exists) return; // helper removed — skip silently

    const d             = snap.data();
    const currentRating = typeof d.rating     === 'number' ? d.rating     : 0;
    const currentCount  = typeof d.ratingCount === 'number' ? d.ratingCount
                          : (d.rating ? 1 : 0);
    const newCount      = currentCount + 1;
    const averaged      = Math.round(
      ((currentRating * currentCount) + newRating) / newCount * 10
    ) / 10;

    tx.update(helperRef, {
      rating:      averaged,
      ratingCount: newCount,
      updatedAt:   FieldValue.serverTimestamp(),
    });
  });
}

// ─── Routes ───────────────────────────────────────────────────────────────────
//
// ORDERING NOTE: Static-segment paths (/submit, /my, /pending, /flagged) are
// declared before parameterised paths (/:id/flag, /:id/moderate, /helper/:id)
// to prevent Express treating "my", "pending", etc. as :id values.
//
// ─────────────────────────────────────────────────────────────────────────────

// ── POST /api/reviews/submit ──────────────────────────────────────────────────
/**
 * Submits a review for a resolved match.
 * Validates match existence and resolved status, enforces duplicate guard,
 * stores the review document, and updates the helper's running rating average.
 */
router.post('/submit', requireAuth, submitLimiter, async (req, res, next) => {
  try {
    const { matchId, rating, comment, reviewType } = req.body || {};
    const { userId, role, tenantId } = req.user;

    // ── Input validation ─────────────────────────────────────────────────────
    if (!matchId || typeof matchId !== 'string' || !DOC_ID_PATTERN.test(matchId.trim())) {
      return res.status(400).json({ error: 'matchId is required and must be a valid document ID.' });
    }
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'rating must be an integer between 1 and 5.' });
    }
    if (!VALID_REVIEW_TYPES.includes(reviewType)) {
      return res.status(400).json({
        error: `reviewType must be one of: ${VALID_REVIEW_TYPES.join(', ')}.`,
      });
    }
    const safeComment = comment ? String(comment).trim().slice(0, 500) : null;
    const safeMatchId = matchId.trim();

    // ── Validate match: exists & resolved ────────────────────────────────────
    const matchSnap = await db.collection(COLLECTIONS.MATCHES).doc(safeMatchId).get();
    if (!matchSnap.exists) {
      return res.status(404).json({ error: 'Match not found.' });
    }
    const match = matchSnap.data();
    if (match.status !== 'resolved') {
      return res.status(422).json({
        error: 'Reviews can only be submitted for resolved matches.',
      });
    }
    const needId   = match.needId   || null;
    const helperId = match.helperId || null;

    // ── Tenant isolation: match must belong to the reviewer's tenant ──────────
    // Prevents a user in tenant A from submitting a review on tenant B's match.
    if (match.tenantId && tenantId && match.tenantId !== tenantId) {
      return res.status(403).json({
        error: 'You do not have permission to review this match.',
      });
    }

    // ── IDOR guard: reviewer must be a participant in this match ──────────────
    // Without this, any authenticated user who knows a resolved matchId can
    // submit a fake review and manipulate a helper's running rating average.
    // The match document stores `userId` (seeker) and `helperUserId` (helper).
    const isSeeker = match.userId       && match.userId       === userId;
    const isHelper = match.helperUserId && match.helperUserId === userId;
    if (!isSeeker && !isHelper) {
      return res.status(403).json({
        error: 'You can only submit a review for a match you participated in.',
      });
    }

    // ── Duplicate guard ───────────────────────────────────────────────────────
    const dupSnap = await db.collection(COLLECTIONS.REVIEWS)
      .where('reviewerId', '==', userId)
      .where('matchId',   '==', safeMatchId)
      .limit(1)
      .get();
    if (!dupSnap.empty) {
      return res.status(409).json({
        error: 'You have already submitted a review for this match.',
      });
    }

    // ── Write review document ─────────────────────────────────────────────────
    const reviewDoc = {
      matchId:      safeMatchId,
      needId:       needId,
      helperId:     helperId,
      reviewerId:   userId,
      reviewerRole: role,
      rating:       rating,
      comment:      safeComment,
      reviewType:   reviewType,
      tenantId:     tenantId || null,
      createdAt:    FieldValue.serverTimestamp(),
      isFlagged:    false,
      flagReason:   null,
      flaggedAt:    null,
      flaggedBy:    null,
      isModerated:  false,
      moderatedAt:  null,
      moderatedBy:  null,
      isVisible:    true,
    };
    const reviewRef = await db.collection(COLLECTIONS.REVIEWS).add(reviewDoc);

    // ── Update helper running rating (non-blocking) ───────────────────────────
    // Only update the helper's aggregate rating when the seeker reviews the helper.
    if (helperId && reviewType === 'need_to_helper') {
      updateHelperRating(helperId, rating).catch(err =>
        console.error('[Reviews] Helper rating update failed:', err.message)
      );
    }

    // ── Audit log ─────────────────────────────────────────────────────────────
    writeAuditLog({
      action:   'review_submitted',
      actorId:  userId,
      targetId: reviewRef.id,
      tenantId: tenantId || null,
      meta:     { matchId: safeMatchId, reviewType, rating },
    });

    // ── Notify reviewed party ─────────────────────────────────────────────────
    // seeker → helper: notify the helper's userId; helper → need: notify the need owner
    const notifyTargetId = reviewType === 'need_to_helper'
      ? (match.helperUserId || null)   // some schemas store helperUserId separately
      : (match.userId       || null);
    if (notifyTargetId) {
      setImmediate(() => writeNotification({
        type:       'new_review',
        reviewId:   reviewRef.id,
        reviewType,
        rating,
        targetId:   notifyTargetId,
        tenantId:   tenantId || null,
      }));
    }

    res.status(201).json({
      message:  'Review submitted successfully.',
      reviewId: reviewRef.id,
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/reviews/my ───────────────────────────────────────────────────────
/**
 * Returns all reviews submitted by the authenticated user, newest first.
 * Capped at 100 to avoid runaway reads; reviewerId is included (owner view).
 */
router.get('/my', requireAuth, readLimiter, async (req, res, next) => {
  try {
    const { userId } = req.user;

    const snap = await db.collection(COLLECTIONS.REVIEWS)
      .where('reviewerId', '==', userId)
      .orderBy('createdAt', 'desc')
      .limit(100)
      .get();

    const reviews = snap.docs.map(doc => {
      const r = { id: doc.id, ...doc.data() };
      return formatReview(r, { includeReviewerId: true });
    });

    res.json({ count: reviews.length, reviews });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/reviews/pending ──────────────────────────────────────────────────
/**
 * Returns resolved needs belonging to the authenticated user that have not yet
 * received a review from them. Used by the UI to prompt the review flow.
 *
 * Strategy:
 *   1. Fetch resolved needs where userId == authenticatedUser (up to 50)
 *   2. Fetch all reviews submitted by this user to build a set of reviewed needIds
 *   3. Return needs whose id is not in that set
 */
router.get('/pending', requireAuth, readLimiter, async (req, res, next) => {
  try {
    const { userId } = req.user;

    const [needsSnap, reviewsSnap] = await Promise.all([
      db.collection(COLLECTIONS.NEEDS)
        .where('userId', '==', userId)
        .where('status', '==', 'resolved')
        .orderBy('createdAt', 'desc')
        .limit(50)
        .get(),
      db.collection(COLLECTIONS.REVIEWS)
        .where('reviewerId', '==', userId)
        .get(),
    ]);

    const resolvedNeeds   = needsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const reviewedNeedIds = new Set(
      reviewsSnap.docs.map(d => d.data().needId).filter(Boolean)
    );

    const pending = resolvedNeeds
      .filter(n => !reviewedNeedIds.has(n.id))
      .map(n => ({
        needId:     n.id,
        category:   n.category   || null,
        urgency:    n.urgency    || null,
        location:   n.location   || null,
        matchId:    n.matchId    || null,
        resolvedAt: tsToISO(n.resolvedAt),
      }));

    res.json({ count: pending.length, pending });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/reviews/flagged ──────────────────────────────────────────────────
/**
 * Returns all flagged reviews with full context.
 * Admin sees their tenant only; superadmin sees all tenants.
 * Returns flagReason, flaggedAt, flaggedBy for moderator context.
 */
router.get('/flagged', requireAuth, requireAdminOrSuper, readLimiter, async (req, res, next) => {
  try {
    const { role, tenantId } = req.user;

    let q = db.collection(COLLECTIONS.REVIEWS).where('isFlagged', '==', true);
    if (role !== 'superadmin' && tenantId) {
      q = q.where('tenantId', '==', tenantId);
    }
    q = q.orderBy('createdAt', 'desc').limit(200);

    const snap    = await q.get();
    const reviews = snap.docs.map(doc => {
      const r = { id: doc.id, ...doc.data() };
      return {
        ...formatReview(r, { includeReviewerId: true, includeFlagReason: true }),
        tenantId: r.tenantId || null,
      };
    });

    res.json({ count: reviews.length, reviews });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/reviews/helper/:id ───────────────────────────────────────────────
/**
 * Public endpoint — no auth required.
 * Returns paginated, visible reviews for an approved helper.
 * Sorted by createdAt descending. Cursor-based pagination via ?cursor=<ISO timestamp>.
 * Never returns reviewerId or any phone-derived field.
 */
router.get('/helper/:id', publicLimiter, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!DOC_ID_PATTERN.test(id)) {
      return res.status(400).json({ error: 'Invalid helper ID format.' });
    }

    // Only serve reviews for approved helpers.
    // gRPC code 5 (NOT_FOUND) can be thrown by the Firestore Admin SDK when
    // the document does not exist in some SDK/env combinations — treat it as 404.
    let helperSnap;
    try {
      helperSnap = await db.collection(COLLECTIONS.HELPERS).doc(id).get();
    } catch (fsErr) {
      if (fsErr.code === 5) {
        return res.status(404).json({ error: 'Helper not found.' });
      }
      throw fsErr;
    }
    if (!helperSnap.exists) {
      return res.status(404).json({ error: 'Helper not found.' });
    }
    if (helperSnap.data().status !== 'approved') {
      return res.status(403).json({
        error: 'Reviews are only available for approved helpers.',
      });
    }

    // Pagination params
    const rawSize = parseInt(req.query.pageSize, 10);
    const pageSize = Number.isFinite(rawSize) && rawSize > 0
      ? Math.min(rawSize, PAGE_SIZE_MAX)
      : PAGE_SIZE_DEFAULT;

    let q = db.collection(COLLECTIONS.REVIEWS)
      .where('helperId',  '==', id)
      .where('isVisible', '==', true)
      .orderBy('createdAt', 'desc')
      .limit(pageSize + 1);   // fetch one extra to determine hasMore

    // Cursor: ISO timestamp of the last doc from the previous page
    const cursorParam = req.query.cursor;
    if (cursorParam) {
      const cursorDate = new Date(String(cursorParam).slice(0, 32));
      if (!isNaN(cursorDate.getTime())) {
        q = q.startAfter(Timestamp.fromDate(cursorDate));
      }
    }

    const snap    = await q.get();
    const docs    = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const hasMore = docs.length > pageSize;
    const page    = hasMore ? docs.slice(0, pageSize) : docs;

    // nextCursor is the createdAt of the oldest doc on this page (for next call)
    const nextCursor = hasMore ? tsToISO(page[page.length - 1].createdAt) : null;

    const reviews = page.map(r => ({
      id:           r.id,
      rating:       r.rating,
      comment:      r.comment      || null,
      reviewType:   r.reviewType,
      reviewerRole: r.reviewerRole || null,
      createdAt:    tsToISO(r.createdAt),
    }));

    res.json({
      helperId:   id,
      pageSize,
      hasMore,
      nextCursor,
      count:      reviews.length,
      reviews,
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/reviews/:id/flag ────────────────────────────────────────────────
/**
 * Flags an inappropriate review. Any authenticated user may flag any visible review.
 * Requires flagReason in the request body (max 300 chars).
 * A review that is already flagged cannot be flagged again.
 * Writes an admin notification for moderator queue.
 */
router.post('/:id/flag', requireAuth, readLimiter, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { userId, tenantId } = req.user;

    if (!DOC_ID_PATTERN.test(id)) {
      return res.status(400).json({ error: 'Invalid review ID format.' });
    }

    const rawFlagReason = req.body?.flagReason;
    if (!rawFlagReason || typeof rawFlagReason !== 'string' || !rawFlagReason.trim()) {
      return res.status(400).json({ error: 'flagReason is required.' });
    }
    const flagReason = rawFlagReason.trim().slice(0, 300);

    const reviewRef  = db.collection(COLLECTIONS.REVIEWS).doc(id);
    const reviewSnap = await reviewRef.get();
    if (!reviewSnap.exists) {
      return res.status(404).json({ error: 'Review not found.' });
    }
    const review = reviewSnap.data();
    if (review.isFlagged) {
      return res.status(409).json({ error: 'This review has already been flagged.' });
    }

    await reviewRef.update({
      isFlagged:  true,
      flagReason: flagReason,
      flaggedAt:  FieldValue.serverTimestamp(),
      flaggedBy:  userId,
    });

    // Notify admins — non-critical, fire-and-forget
    setImmediate(() => writeNotification({
      type:       'review_flagged',
      reviewId:   id,
      flagReason: flagReason,
      flaggedBy:  userId,
      targetRole: 'admin',
      tenantId:   review.tenantId || tenantId || null,
    }));

    res.json({
      message: 'Review flagged. It will be reviewed by a moderator.',
    });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/reviews/:id/moderate ──────────────────────────────────────────
/**
 * Moderates a flagged review. Admin role only.
 * action "approve" — clears the flag, marks as moderated, review stays visible.
 * action "remove"  — sets isVisible: false, marks as moderated.
 * Writes an audit log entry and notifies the original reviewer of the outcome.
 */
router.patch('/:id/moderate', requireAuth, requireAdminOnly, readLimiter, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { userId, tenantId } = req.user;
    const { action } = req.body || {};

    if (!DOC_ID_PATTERN.test(id)) {
      return res.status(400).json({ error: 'Invalid review ID format.' });
    }
    if (action !== 'approve' && action !== 'remove') {
      return res.status(400).json({ error: 'action must be "approve" or "remove".' });
    }

    const reviewRef  = db.collection(COLLECTIONS.REVIEWS).doc(id);
    const reviewSnap = await reviewRef.get();
    if (!reviewSnap.exists) {
      return res.status(404).json({ error: 'Review not found.' });
    }
    const review = reviewSnap.data();

    // Tenant isolation: admin may only moderate reviews within their own tenant
    if (review.tenantId && tenantId && review.tenantId !== tenantId) {
      return res.status(403).json({
        error: 'You do not have permission to moderate this review.',
      });
    }

    const updatePayload = {
      isModerated: true,
      moderatedAt: FieldValue.serverTimestamp(),
      moderatedBy: userId,
      isFlagged:   false,   // clear flag regardless of action
      flagReason:  null,
    };
    if (action === 'remove') {
      updatePayload.isVisible = false;
    }
    await reviewRef.update(updatePayload);

    // Audit log
    writeAuditLog({
      action:   `review_moderated_${action}`,
      actorId:  userId,
      targetId: id,
      tenantId: tenantId || null,
      meta:     {
        action,
        reviewId: id,
        matchId:  review.matchId  || null,
        helperId: review.helperId || null,
      },
    });

    // Notify original reviewer of the moderation outcome — non-critical
    if (review.reviewerId) {
      setImmediate(() => writeNotification({
        type:       'review_moderation_outcome',
        reviewId:   id,
        action:     action,
        targetId:   review.reviewerId,
        tenantId:   review.tenantId || tenantId || null,
      }));
    }

    res.json({
      message: action === 'remove'
        ? 'Review removed and hidden from public view.'
        : 'Review approved — flag cleared, review remains visible.',
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
