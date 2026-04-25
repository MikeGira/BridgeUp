'use strict';

const express      = require('express');
const multer       = require('multer');
const nodemailer   = require('nodemailer');
const path         = require('path');
const { db, FieldValue, COLLECTIONS, docToObject, queryToArray, writeAuditLog, bucket } = require('../services/firebase');
const { requireAuth } = require('./auth');
const { sendSMS }     = require('../services/twilio');

const router = express.Router();

// ─── Constants ────────────────────────────────────────────────────────────────
const VALID_HELP_TYPES   = ['food', 'housing', 'employment', 'medical', 'training', 'funding', 'other'];
const VALID_STATUSES     = ['pending_approval', 'approved', 'rejected', 'suspended'];
const VALID_CONTACT      = ['phone', 'sms', 'whatsapp', 'email'];
const NEARBY_MAX_RADIUS  = 200;   // km — hard cap to prevent full-table scans
const NEARBY_DEFAULT_KM  = 25;
const NEARBY_MAX_RESULTS = 50;

// ─── Multer — memory storage, then we stream to Firebase Storage ──────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 5 * 1024 * 1024 },  // 5 MB max
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowed = ['.pdf', '.jpg', '.jpeg', '.png', '.webp'];
    if (allowed.includes(ext)) return cb(null, true);
    cb(new Error('Verification document must be a PDF, JPG, PNG, or WEBP file.'));
  },
});

// ─── Haversine formula ────────────────────────────────────────────────────────
/**
 * Returns the great-circle distance in kilometres between two WGS-84 points.
 * @param {number} lat1  Decimal degrees
 * @param {number} lon1  Decimal degrees
 * @param {number} lat2  Decimal degrees
 * @param {number} lon2  Decimal degrees
 * @returns {number} Distance in km (rounded to 2 decimal places)
 */
function haversineKm(lat1, lon1, lat2, lon2) {
  const R     = 6371;                          // Earth's mean radius, km
  const toRad = (d) => d * (Math.PI / 180);
  const dLat  = toRad(lat2 - lat1);
  const dLon  = toRad(lon2 - lon1);
  const a     = Math.sin(dLat / 2) ** 2
              + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2))
              * Math.sin(dLon / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 100) / 100;
}

/**
 * Returns a lat/lng bounding box (min/max values) for a circle query.
 * Used to pre-filter Firestore documents before the precise Haversine check.
 *
 * @param {number} lat     Centre latitude
 * @param {number} lon     Centre longitude
 * @param {number} radiusKm
 * @returns {{ minLat, maxLat, minLon, maxLon }}
 */
function boundingBox(lat, lon, radiusKm) {
  const latDelta = radiusKm / 111.0;
  const lonDelta = radiusKm / (111.0 * Math.cos(lat * (Math.PI / 180)));
  return {
    minLat: lat - latDelta,
    maxLat: lat + latDelta,
    minLon: lon - lonDelta,
    maxLon: lon + lonDelta,
  };
}

// ─── Email helper (requires SMTP_* secrets — graceful no-op if not configured) ─
/**
 * Sends a transactional email.  Will silently skip if SMTP credentials are
 * not yet configured so development is unblocked and deployment can add them
 * later without any code change.
 *
 * Required secrets: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
 */
async function sendEmail({ to, subject, text, html }) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.log(`[Helpers] Email skipped (SMTP not configured): ${subject} → ${to}`);
    return;
  }
  try {
    const transporter = nodemailer.createTransport({
      host:   SMTP_HOST,
      port:   parseInt(SMTP_PORT || '587', 10),
      secure: parseInt(SMTP_PORT || '587', 10) === 465,
      auth:   { user: SMTP_USER, pass: SMTP_PASS },
    });
    await transporter.sendMail({
      from:    SMTP_FROM || `BridgeUp <${SMTP_USER}>`,
      to, subject, text, html,
    });
    console.log(`[Helpers] Email sent: ${subject} → ${to}`);
  } catch (err) {
    console.error(`[Helpers] Email failed (${subject} → ${to}):`, err.message);
  }
}

// ─── Upload verification doc to Firebase Storage ─────────────────────────────
/**
 * Streams a multer memory-buffer file to the Firebase Storage bucket.
 * Returns the public download URL.
 *
 * @param {Express.Multer.File} file
 * @param {string}              userId
 * @returns {Promise<string>}   Public URL
 */
async function uploadVerificationDoc(file, userId) {
  if (!bucket) {
    throw new Error('File storage is not configured. Set FIREBASE_STORAGE_BUCKET or migrate to Supabase Storage.');
  }
  const ext        = path.extname(file.originalname).toLowerCase();
  const storagePath = `verification-docs/${userId}/${Date.now()}${ext}`;
  const fileRef    = bucket.file(storagePath);

  await fileRef.save(file.buffer, {
    metadata: {
      contentType: file.mimetype,
      metadata:    { uploadedBy: userId, purpose: 'helper-verification' },
    },
  });

  // Make the file publicly readable and return its URL
  await fileRef.makePublic();
  return `https://storage.googleapis.com/${bucket.name}/${storagePath}`;
}

// ─── Sanitise helper for public API responses ─────────────────────────────────
/**
 * Strips internal/admin-only fields before returning a helper profile to the client.
 * @param {Object}  helper         Raw Firestore document + id
 * @param {boolean} isOwnerOrAdmin If true, include private fields (phone, email, doc URL)
 */
function sanitizeHelper(helper, isOwnerOrAdmin = false) {
  if (!helper) return null;
  const out = { ...helper };

  // Convert Timestamps to ISO strings
  for (const f of ['createdAt', 'approvedAt', 'suspendedAt', 'rejectedAt', 'updatedAt']) {
    if (out[f]?.toDate) out[f] = out[f].toDate().toISOString();
    else if (out[f] instanceof Date) out[f] = out[f].toISOString();
  }

  if (!isOwnerOrAdmin) {
    // Public view — remove private contact details and admin fields
    delete out.contactPhone;
    delete out.contactEmail;
    delete out.verificationDocUrl;
    delete out.rejectionReason;
    delete out.suspendedAt;
    delete out.rejectedAt;
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 1 — POST /register
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Registers a new helper. The caller must be authenticated (JWT).
 * An optional verification document is uploaded via multipart/form-data.
 *
 * Body fields (multipart/form-data):
 *   name                 string        Full name
 *   organization         string?       NGO / company name (optional)
 *   helpTypes            JSON string   e.g. '["food","medical"]'
 *   city                 string        Service area city
 *   country              string        ISO 3166-1 alpha-2 (e.g. "RW")
 *   latitude             number        Decimal degrees
 *   longitude            number        Decimal degrees
 *   contactMethod        phone|sms|whatsapp|email
 *   contactPhone         string?       E.164 or local phone
 *   contactEmail         string?       Email address
 *   availabilitySchedule JSON string   e.g. '{"mon":"08:00-17:00","fri":"08:00-12:00"}'
 *   bio                  string?       Short bio (max 500 chars)
 *   file                 File?         Verification document (PDF/image, ≤5 MB)
 */
router.post('/register', requireAuth, upload.single('file'), async (req, res) => {
  const {
    name, organization, helpTypes: rawHelpTypes,
    city, country, latitude: rawLat, longitude: rawLon,
    contactMethod, contactPhone, contactEmail,
    availabilitySchedule: rawSchedule, bio,
  } = req.body;

  // ── Validate name ───────────────────────────────────────────────────────────
  if (!name || String(name).trim().length < 2) {
    return res.status(400).json({ error: 'Name is required (minimum 2 characters).' });
  }

  // ── Validate helpTypes ──────────────────────────────────────────────────────
  let helpTypes;
  try {
    helpTypes = typeof rawHelpTypes === 'string' ? JSON.parse(rawHelpTypes) : rawHelpTypes;
    if (!Array.isArray(helpTypes) || helpTypes.length === 0) throw new Error();
    helpTypes = helpTypes.filter(t => VALID_HELP_TYPES.includes(t));
    if (helpTypes.length === 0) throw new Error();
  } catch {
    return res.status(400).json({
      error: `helpTypes must be a JSON array containing at least one of: ${VALID_HELP_TYPES.join(', ')}.`,
    });
  }

  // ── Validate location ───────────────────────────────────────────────────────
  if (!city || String(city).trim().length < 2) {
    return res.status(400).json({ error: 'City is required.' });
  }
  if (!country || String(country).trim().length < 2) {
    return res.status(400).json({ error: 'Country is required (e.g. "RW" for Rwanda).' });
  }
  const lat = parseFloat(rawLat);
  const lon = parseFloat(rawLon);
  if (isNaN(lat) || lat < -90  || lat > 90)  return res.status(400).json({ error: 'latitude must be a valid decimal number between -90 and 90.' });
  if (isNaN(lon) || lon < -180 || lon > 180) return res.status(400).json({ error: 'longitude must be a valid decimal number between -180 and 180.' });

  // ── Validate contactMethod ──────────────────────────────────────────────────
  if (!contactMethod || !VALID_CONTACT.includes(contactMethod)) {
    return res.status(400).json({ error: `contactMethod must be one of: ${VALID_CONTACT.join(', ')}.` });
  }

  // ── Parse availabilitySchedule ──────────────────────────────────────────────
  let schedule = {};
  if (rawSchedule) {
    try {
      schedule = typeof rawSchedule === 'string' ? JSON.parse(rawSchedule) : rawSchedule;
      if (typeof schedule !== 'object' || Array.isArray(schedule)) schedule = {};
    } catch {
      return res.status(400).json({ error: 'availabilitySchedule must be a valid JSON object.' });
    }
  }

  // ── Guard: one profile per user ─────────────────────────────────────────────
  const existingSnap = await db.collection(COLLECTIONS.HELPERS)
    .where('userId', '==', req.user.userId).limit(1).get();
  if (!existingSnap.empty) {
    return res.status(409).json({ error: 'You already have a helper profile. Use PATCH /api/helpers/my/profile to update it.' });
  }

  // ── Upload verification document (if provided) ───────────────────────────────
  let verificationDocUrl = null;
  if (req.file) {
    try {
      verificationDocUrl = await uploadVerificationDoc(req.file, req.user.userId);
    } catch (err) {
      console.error('[Helpers] Doc upload failed:', err.message);
      return res.status(502).json({ error: 'Verification document upload failed. Please try again.' });
    }
  }

  // ── Write helper document ───────────────────────────────────────────────────
  const helperDoc = {
    userId:               req.user.userId,
    name:                 String(name).trim().slice(0, 100),
    organization:         organization ? String(organization).trim().slice(0, 200) : null,
    helpTypes,
    serviceArea:          { city: String(city).trim(), country: String(country).trim().toUpperCase() },
    city:                 String(city).trim(),
    country:              String(country).trim().toUpperCase(),
    latitude:             lat,
    longitude:            lon,
    contactMethod,
    contactPhone:         contactPhone  ? String(contactPhone).trim()  : null,
    contactEmail:         contactEmail  ? String(contactEmail).trim().toLowerCase() : null,
    availabilitySchedule: schedule,
    bio:                  bio ? String(bio).trim().slice(0, 500) : null,
    status:               'pending_approval',
    isOnline:             false,
    rating:               0,
    totalRatings:         0,
    totalResolved:        0,
    verificationDocUrl,
    createdAt:            FieldValue.serverTimestamp(),
    updatedAt:            FieldValue.serverTimestamp(),
    approvedAt:           null,
    suspendedAt:          null,
    rejectedAt:           null,
    rejectionReason:      null,
  };

  let docRef;
  try {
    docRef = await db.collection(COLLECTIONS.HELPERS).add(helperDoc);
  } catch (err) {
    console.error('[Helpers] Firestore write failed:', err.message);
    return res.status(500).json({ error: 'Could not save your profile. Please try again.' });
  }

  // ── Notify admins (Firestore notification + fire-and-forget) ─────────────────
  setImmediate(async () => {
    try {
      await db.collection(COLLECTIONS.NOTIFICATIONS).add({
        type:     'helper_pending_approval',
        helperId: docRef.id,
        userId:   req.user.userId,
        name:     String(name).trim(),
        city:     String(city).trim(),
        country:  String(country).trim().toUpperCase(),
        read:     false,
        roles:    ['admin', 'superadmin'],
        createdAt: FieldValue.serverTimestamp(),
      });
    } catch (e) { console.error('[Helpers] Admin notification failed:', e.message); }
  });

  writeAuditLog({ action: 'helper_registered', actorId: req.user.userId, targetId: docRef.id,
    meta: { city, country, helpTypes } }).catch(() => {});

  return res.status(201).json({
    success:  true,
    helperId: docRef.id,
    status:   'pending_approval',
    message:  'Your application has been submitted. You will be notified by SMS and email once reviewed.',
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 2 — GET /nearby  (Core matching query — real Haversine distances)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Returns approved, online helpers within a radius, sorted by real distance.
 *
 * Implementation:
 *   1. Calculate a lat/lng bounding box for the radius (fast Firestore filter)
 *   2. Firestore range query on latitude (only one inequality allowed per query)
 *   3. In-memory filter on longitude and Haversine distance
 *   4. Sort ascending by distance_km, return top NEARBY_MAX_RESULTS
 *
 * Query params:
 *   lat        number    Caller's latitude  (required)
 *   lng        number    Caller's longitude (required)
 *   radius     number    Search radius in km (default 25, max 200)
 *   category   string    Filter by help type (e.g. "food")
 *   limit      number    Max results (default 20, max 50)
 *   onlineOnly boolean   If "true", only return currently-online helpers (default true)
 */
router.get('/nearby', async (req, res) => {
  const {
    lat:        rawLat,
    lng:        rawLng,
    radius:     rawRadius   = String(NEARBY_DEFAULT_KM),
    category:   rawCategory,
    limit:      rawLimit    = '20',
    onlineOnly: rawOnline   = 'true',
  } = req.query;

  // ── Validate coordinates ────────────────────────────────────────────────────
  const lat = parseFloat(rawLat);
  const lng = parseFloat(rawLng);
  if (isNaN(lat) || lat < -90  || lat > 90)  return res.status(400).json({ error: 'lat must be a valid decimal latitude (-90 to 90).' });
  if (isNaN(lng) || lng < -180 || lng > 180) return res.status(400).json({ error: 'lng must be a valid decimal longitude (-180 to 180).' });

  const radiusKm  = Math.min(Math.max(parseFloat(rawRadius) || NEARBY_DEFAULT_KM, 1), NEARBY_MAX_RADIUS);
  const pageLimit = Math.min(parseInt(rawLimit, 10) || 20, NEARBY_MAX_RESULTS);
  const onlineOnly = rawOnline !== 'false';

  // ── Validate category filter ────────────────────────────────────────────────
  const categoryFilter = rawCategory && VALID_HELP_TYPES.includes(rawCategory.trim())
    ? rawCategory.trim() : null;

  // ── Compute bounding box for initial Firestore lat filter ───────────────────
  const box = boundingBox(lat, lng, radiusKm);

  try {
    // Firestore supports at most one inequality filter per query.
    // We filter on latitude range here; longitude is filtered in-memory below.
    let query = db.collection(COLLECTIONS.HELPERS)
      .where('status',    '==', 'approved')
      .where('latitude',  '>=', box.minLat)
      .where('latitude',  '<=', box.maxLat);

    if (onlineOnly) query = query.where('isOnline', '==', true);

    const snap   = await query.get();
    const rawDocs = queryToArray(snap);

    // ── In-memory: longitude filter + Haversine distance ───────────────────
    const results = rawDocs
      .filter(h => {
        // Longitude bounding box (second filter Firestore can't apply)
        if (h.longitude < box.minLon || h.longitude > box.maxLon) return false;
        // Category filter
        if (categoryFilter && !h.helpTypes?.includes(categoryFilter)) return false;
        return true;
      })
      .map(h => ({
        ...h,
        distance_km: haversineKm(lat, lng, h.latitude, h.longitude),
      }))
      // Precise radius check after Haversine (bounding box slightly over-selects corners)
      .filter(h => h.distance_km <= radiusKm)
      // Sort ascending: nearest first
      .sort((a, b) => a.distance_km - b.distance_km)
      .slice(0, pageLimit);

    const safeResults = results.map(h => {
      const pub = sanitizeHelper(h, false);
      pub.distance_km = h.distance_km;
      return pub;
    });

    return res.json({
      helpers:    safeResults,
      count:      safeResults.length,
      radiusKm,
      centreLat:  lat,
      centreLng:  lng,
    });
  } catch (err) {
    console.error('[Helpers] /nearby error:', err.message);
    return res.status(500).json({ error: 'Could not search for helpers right now. Please try again.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 3 — GET /my  (Authenticated helper's own profile + stats)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/my', requireAuth, async (req, res) => {
  try {
    const snap = await db.collection(COLLECTIONS.HELPERS)
      .where('userId', '==', req.user.userId).limit(1).get();

    if (snap.empty) {
      return res.status(404).json({ error: 'You do not have a helper profile yet. POST /api/helpers/register to create one.' });
    }

    const helper = { id: snap.docs[0].id, ...snap.docs[0].data() };

    // Pull recent resolved matches for stats panel
    const matchesSnap = await db.collection(COLLECTIONS.MATCHES)
      .where('helperId', '==', helper.id)
      .where('status', '==', 'resolved')
      .orderBy('resolvedAt', 'desc')
      .limit(10)
      .get();

    const recentResolved = queryToArray(matchesSnap).map(m => ({
      needId:     m.needId,
      category:   m.category,
      resolvedAt: m.resolvedAt?.toDate?.()?.toISOString() || null,
    }));

    return res.json({
      helper:         sanitizeHelper(helper, true),
      stats: {
        totalResolved: helper.totalResolved || 0,
        totalRatings:  helper.totalRatings  || 0,
        averageRating: helper.rating        || 0,
        recentResolved,
      },
    });
  } catch (err) {
    console.error('[Helpers] GET /my error:', err.message);
    return res.status(500).json({ error: 'Could not load your profile. Please try again.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 4 — PATCH /my/availability  (Toggle online / offline)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Body: { isOnline: boolean }
 * Only approved helpers can go online. Pending or suspended helpers stay offline.
 */
router.patch('/my/availability', requireAuth, async (req, res) => {
  const { isOnline } = req.body;
  if (typeof isOnline !== 'boolean') {
    return res.status(400).json({ error: 'isOnline must be a boolean (true or false).' });
  }

  try {
    const snap = await db.collection(COLLECTIONS.HELPERS)
      .where('userId', '==', req.user.userId).limit(1).get();

    if (snap.empty) {
      return res.status(404).json({ error: 'Helper profile not found.' });
    }

    const doc    = snap.docs[0];
    const helper = doc.data();

    if (helper.status !== 'approved') {
      return res.status(403).json({
        error: `Only approved helpers can change availability. Your current status is "${helper.status}".`,
      });
    }

    await doc.ref.update({ isOnline, updatedAt: FieldValue.serverTimestamp() });

    return res.json({ success: true, isOnline });
  } catch (err) {
    console.error('[Helpers] PATCH /my/availability error:', err.message);
    return res.status(500).json({ error: 'Could not update your availability. Please try again.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 5 — PATCH /my/profile  (Update own helper profile fields)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Updatable fields: name, organization, helpTypes, city, country, latitude,
 * longitude, contactMethod, contactPhone, contactEmail, availabilitySchedule, bio
 *
 * Status, rating, totalResolved are never updatable by the helper themselves.
 * Re-uploading a verification doc requires a new registration flow.
 */
router.patch('/my/profile', requireAuth, async (req, res) => {
  const UPDATABLE = ['name','organization','helpTypes','city','country',
    'latitude','longitude','contactMethod','contactPhone','contactEmail',
    'availabilitySchedule','bio'];

  try {
    const snap = await db.collection(COLLECTIONS.HELPERS)
      .where('userId', '==', req.user.userId).limit(1).get();

    if (snap.empty) {
      return res.status(404).json({ error: 'Helper profile not found.' });
    }

    const doc = snap.docs[0];
    const updates = {};

    for (const field of UPDATABLE) {
      if (req.body[field] === undefined) continue;

      switch (field) {
        case 'name':
          if (String(req.body.name).trim().length < 2) return res.status(400).json({ error: 'Name must be at least 2 characters.' });
          updates.name = String(req.body.name).trim().slice(0, 100);
          break;
        case 'helpTypes': {
          const ht = typeof req.body.helpTypes === 'string'
            ? JSON.parse(req.body.helpTypes)
            : req.body.helpTypes;
          const valid = Array.isArray(ht) ? ht.filter(t => VALID_HELP_TYPES.includes(t)) : [];
          if (valid.length === 0) return res.status(400).json({ error: `helpTypes must contain at least one of: ${VALID_HELP_TYPES.join(', ')}.` });
          updates.helpTypes = valid;
          break;
        }
        case 'latitude': {
          const v = parseFloat(req.body.latitude);
          if (isNaN(v) || v < -90 || v > 90) return res.status(400).json({ error: 'latitude must be between -90 and 90.' });
          updates.latitude = v;
          break;
        }
        case 'longitude': {
          const v = parseFloat(req.body.longitude);
          if (isNaN(v) || v < -180 || v > 180) return res.status(400).json({ error: 'longitude must be between -180 and 180.' });
          updates.longitude = v;
          break;
        }
        case 'contactMethod':
          if (!VALID_CONTACT.includes(req.body.contactMethod)) return res.status(400).json({ error: `contactMethod must be one of: ${VALID_CONTACT.join(', ')}.` });
          updates.contactMethod = req.body.contactMethod;
          break;
        case 'availabilitySchedule':
          try {
            updates.availabilitySchedule = typeof req.body.availabilitySchedule === 'string'
              ? JSON.parse(req.body.availabilitySchedule)
              : req.body.availabilitySchedule;
          } catch { return res.status(400).json({ error: 'availabilitySchedule must be valid JSON.' }); }
          break;
        case 'bio':
          updates.bio = req.body.bio ? String(req.body.bio).trim().slice(0, 500) : null;
          break;
        case 'organization':
          updates.organization = req.body.organization ? String(req.body.organization).trim().slice(0, 200) : null;
          break;
        case 'city':
          updates.city = String(req.body.city).trim();
          updates.serviceArea = { ...(doc.data().serviceArea || {}), city: updates.city };
          break;
        case 'country':
          updates.country = String(req.body.country).trim().toUpperCase();
          updates.serviceArea = { ...(doc.data().serviceArea || {}), country: updates.country };
          break;
        default:
          updates[field] = req.body[field];
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No updatable fields provided.' });
    }

    updates.updatedAt = FieldValue.serverTimestamp();
    await doc.ref.update(updates);

    writeAuditLog({ action: 'helper_profile_updated', actorId: req.user.userId,
      targetId: doc.id, meta: { fields: Object.keys(updates) } }).catch(() => {});

    return res.json({ success: true, updated: Object.keys(updates).filter(k => k !== 'updatedAt') });
  } catch (err) {
    console.error('[Helpers] PATCH /my/profile error:', err.message);
    return res.status(500).json({ error: 'Could not update your profile. Please try again.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 6 — GET /pending  (Admin: list helpers awaiting approval)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Returns helpers in pending_approval status for the caller's tenant.
 * Accessible to: admin, superadmin.
 */
router.get('/pending', requireAuth, async (req, res) => {
  const { role, tenantId } = req.user;
  if (!['admin', 'superadmin'].includes(role)) {
    return res.status(403).json({ error: 'Only admins can view pending helper applications.' });
  }

  try {
    let query = db.collection(COLLECTIONS.HELPERS)
      .where('status', '==', 'pending_approval')
      .orderBy('createdAt', 'asc');

    const snap = await query.get();
    let helpers = queryToArray(snap);

    // Admins are scoped to their tenant (superadmin sees all)
    if (role === 'admin' && tenantId) {
      helpers = helpers.filter(h => h.tenantId === tenantId || !h.tenantId);
    }

    return res.json({
      helpers: helpers.map(h => sanitizeHelper(h, true)),
      count:   helpers.length,
    });
  } catch (err) {
    console.error('[Helpers] GET /pending error:', err.message);
    return res.status(500).json({ error: 'Could not load pending applications. Please try again.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 7 — GET /:id  (Public helper profile)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  if (!id || id.length > 128) return res.status(400).json({ error: 'Invalid helper ID.' });

  try {
    const snap = await db.collection(COLLECTIONS.HELPERS).doc(id).get();
    if (!snap.exists) return res.status(404).json({ error: 'Helper not found.' });

    const helper = { id: snap.id, ...snap.data() };

    // Only expose approved profiles publicly
    if (helper.status !== 'approved') {
      return res.status(404).json({ error: 'Helper not found.' });
    }

    // Check if the requester is the owner or an admin
    let isOwnerOrAdmin = false;
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      try {
        const jwt     = require('jsonwebtoken');
        const decoded = jwt.verify(authHeader.slice(7), process.env.SESSION_SECRET,
          { issuer: 'bridgeup', audience: 'bridgeup-app' });
        isOwnerOrAdmin = decoded.userId === helper.userId ||
                         ['admin', 'superadmin'].includes(decoded.role);
      } catch { /* anonymous visitor */ }
    }

    return res.json({ helper: sanitizeHelper(helper, isOwnerOrAdmin) });
  } catch (err) {
    console.error('[Helpers] GET /:id error:', err.message);
    return res.status(500).json({ error: 'Could not load helper profile. Please try again.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 8 — PATCH /:id/approve  (Admin: approve a helper)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Sets the helper's status to 'approved', sets approvedAt timestamp,
 * then notifies the helper by both SMS and email.
 *
 * Body: { note?: string }  — optional internal approval note
 */
router.patch('/:id/approve', requireAuth, async (req, res) => {
  if (!['admin', 'superadmin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Only admins can approve helpers.' });
  }

  const { id } = req.params;
  const { note } = req.body;

  try {
    const ref  = db.collection(COLLECTIONS.HELPERS).doc(id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Helper not found.' });

    const helper = snap.data();

    if (helper.status === 'approved') {
      return res.status(409).json({ error: 'This helper is already approved.' });
    }

    await ref.update({
      status:     'approved',
      approvedAt: FieldValue.serverTimestamp(),
      approvedBy: req.user.userId,
      approvalNote: note || null,
      updatedAt:  FieldValue.serverTimestamp(),
    });

    // ── Notify helper via SMS ────────────────────────────────────────────────
    if (helper.contactPhone) {
      const smsMessages = {
        RW: `BridgeUp: Murakoze! Konti yanyu yemejwe. Ubu mwemerewe gukoresha serivisi yacu nka helper. Mwifatanije na bagenzi!`,
        KE: `BridgeUp: Hongera! Akaunti yako imeidhinishwa. Sasa unaweza kuanza kusaidia watu kwenye jukwaa letu.`,
        DEFAULT: `BridgeUp: Congratulations! Your helper application has been approved. You can now log in and start helping people in your community.`,
      };
      const country  = helper.country || 'DEFAULT';
      const smsBody  = smsMessages[country] || smsMessages.DEFAULT;
      sendSMS(helper.contactPhone, smsBody).catch(e =>
        console.error('[Helpers] Approval SMS failed:', e.message));
    }

    // ── Notify helper via email ──────────────────────────────────────────────
    if (helper.contactEmail) {
      sendEmail({
        to:      helper.contactEmail,
        subject: 'BridgeUp: Your Helper Application has been Approved',
        text:    `Hello ${helper.name},\n\nCongratulations! Your application to become a verified BridgeUp helper has been approved.\n\nYou can now log in to the BridgeUp platform and start helping people in your community.\n\nThank you for making a difference.\n\n— The BridgeUp Team`,
        html:    `<p>Hello <strong>${helper.name}</strong>,</p>
                  <p>Congratulations! Your application to become a verified BridgeUp helper has been <strong style="color:green">approved</strong>.</p>
                  <p>You can now log in to the BridgeUp platform and start helping people in your community.</p>
                  <p>Thank you for making a difference.</p>
                  <p>— The BridgeUp Team</p>`,
      }).catch(e => console.error('[Helpers] Approval email failed:', e.message));
    }

    // ── Firestore notification (for in-app bell) ─────────────────────────────
    setImmediate(async () => {
      try {
        await db.collection(COLLECTIONS.NOTIFICATIONS).add({
          type:     'helper_approved',
          helperId: id,
          userId:   helper.userId,
          read:     false,
          createdAt: FieldValue.serverTimestamp(),
        });
      } catch { /* non-critical */ }
    });

    writeAuditLog({ action: 'helper_approved', actorId: req.user.userId, targetId: id,
      meta: { note: note || null } }).catch(() => {});

    return res.json({ success: true, helperId: id, status: 'approved' });
  } catch (err) {
    console.error('[Helpers] PATCH /:id/approve error:', err.message);
    return res.status(500).json({ error: 'Could not approve this helper. Please try again.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 9 — PATCH /:id/reject  (Admin: reject a helper application)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Sets the helper's status to 'rejected'. A rejection reason is strongly
 * recommended — it is included in the SMS and email notification to the
 * applicant so they know what to fix and can reapply.
 *
 * Body: { reason: string }  — required for a meaningful rejection
 */
router.patch('/:id/reject', requireAuth, async (req, res) => {
  if (!['admin', 'superadmin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Only admins can reject helpers.' });
  }

  const { id } = req.params;
  const { reason } = req.body;

  if (!reason || String(reason).trim().length < 5) {
    return res.status(400).json({ error: 'A rejection reason is required (minimum 5 characters) so the applicant knows what to address.' });
  }

  try {
    const ref  = db.collection(COLLECTIONS.HELPERS).doc(id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Helper not found.' });

    const helper = snap.data();

    if (['rejected', 'suspended'].includes(helper.status)) {
      return res.status(409).json({ error: `This helper is already "${helper.status}".` });
    }

    await ref.update({
      status:          'rejected',
      rejectedAt:      FieldValue.serverTimestamp(),
      rejectedBy:      req.user.userId,
      rejectionReason: String(reason).trim(),
      updatedAt:       FieldValue.serverTimestamp(),
    });

    // ── Notify helper via SMS ────────────────────────────────────────────────
    if (helper.contactPhone) {
      const smsBody = `BridgeUp: Your helper application was not approved at this time. Reason: ${String(reason).trim().slice(0, 120)}. Please contact support if you have questions.`;
      sendSMS(helper.contactPhone, smsBody).catch(e =>
        console.error('[Helpers] Rejection SMS failed:', e.message));
    }

    // ── Notify helper via email ──────────────────────────────────────────────
    if (helper.contactEmail) {
      sendEmail({
        to:      helper.contactEmail,
        subject: 'BridgeUp: Update on Your Helper Application',
        text:    `Hello ${helper.name},\n\nThank you for applying to become a BridgeUp helper. After reviewing your application, we are unable to approve it at this time.\n\nReason: ${reason}\n\nIf you believe this is an error or you have additional information to provide, please contact our support team.\n\n— The BridgeUp Team`,
        html:    `<p>Hello <strong>${helper.name}</strong>,</p>
                  <p>Thank you for applying to become a BridgeUp helper. After reviewing your application, we are unable to approve it at this time.</p>
                  <p><strong>Reason:</strong> ${reason}</p>
                  <p>If you believe this is an error or you have additional information, please contact our support team.</p>
                  <p>— The BridgeUp Team</p>`,
      }).catch(e => console.error('[Helpers] Rejection email failed:', e.message));
    }

    // ── In-app notification ──────────────────────────────────────────────────
    setImmediate(async () => {
      try {
        await db.collection(COLLECTIONS.NOTIFICATIONS).add({
          type:     'helper_rejected',
          helperId: id,
          userId:   helper.userId,
          reason:   String(reason).trim(),
          read:     false,
          createdAt: FieldValue.serverTimestamp(),
        });
      } catch { /* non-critical */ }
    });

    writeAuditLog({ action: 'helper_rejected', actorId: req.user.userId, targetId: id,
      meta: { reason: String(reason).trim() } }).catch(() => {});

    return res.json({ success: true, helperId: id, status: 'rejected' });
  } catch (err) {
    console.error('[Helpers] PATCH /:id/reject error:', err.message);
    return res.status(500).json({ error: 'Could not reject this application. Please try again.' });
  }
});

module.exports = router;
