'use strict';

/**
 * Matching Route — BridgeUp AI-powered need-to-helper matching engine
 *
 * Mounted at /api/matching in index.js.
 *
 * Security:
 *   - matchingLimiter (30 req/min per IP) guards the three expensive mutation
 *     routes (POST /trigger, PATCH /accept, PATCH /decline) in addition to the
 *     global 100 req/min generalLimiter applied in index.js.
 *
 * Algorithm overview:
 *   1. Load the need document; verify it has geocoordinates (lat/lng).
 *   2. Query the helpers collection using a lat/lng bounding box (fast Firestore
 *      range filter on latitude), then filter in-memory on longitude and Haversine
 *      distance (Firestore only allows one inequality field per compound query).
 *   3. Hard-filter: status === 'approved', isOnline === true,
 *      helpTypes.includes(category), distanceKm <= 200.
 *   4. Score remaining candidates (max 100 pts):
 *        - Distance   : 60 pts × (1 – dist/200)  — nearer = better
 *        - Rating     : 30 pts × (rating/5)       — higher = better
 *        - Experience : up to 10 pts (1 per 5 resolved cases)
 *   5. Select the top scorer, write the match record, update the need,
 *      send SMS to both parties in their languages.
 *   6. If no helper found: set need to no_match_found, send honest SMS.
 */

const express    = require('express');
const rateLimit  = require('express-rate-limit');
const {
  db, FieldValue, COLLECTIONS, docToObject, queryToArray, writeAuditLog,
} = require('../services/firebase');
const { requireAuth } = require('./auth');
const { sendSMS }     = require('../services/twilio');

const router = express.Router();

// Tighter per-IP limiter for the three expensive mutation endpoints.
// These routes execute multi-step Firestore transactions and send SMS messages,
// so a burst of 100 req/min (the global limit) would exhaust quota and
// generate unbounded SMS costs. This limiter caps them at 30/min per IP.
const matchingLimiter = rateLimit({
  windowMs:        60 * 1000,
  max:             30,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'Too many matching requests. Please slow down.' },
});

// ─── Constants ─────────────────────────────────────────────────────────────────

const MATCH_RADIUS_KM = 200;    // hard cap from spec

// Scoring weights — must sum to 100
const SCORE_DISTANCE   = 60;    // max pts: proximity  (0 km → 60, 200 km → 0)
const SCORE_RATING     = 30;    // max pts: rating     (5.0  → 30,  0.0  → 0)
const SCORE_EXPERIENCE = 10;    // max pts: experience (1 pt per 5 resolved, capped at 10)

// Firestore auto-generated document IDs are 20 alphanumeric chars.
// This pattern is intentionally permissive to be robust across Firestore versions.
const DOC_ID_PATTERN = /^[a-zA-Z0-9]{10,128}$/;

// Valid lifecycle statuses for a match document
const MATCH_STATUSES = ['pending', 'accepted', 'declined', 'in_progress', 'resolved', 'cancelled'];

// Roles permitted to trigger matching via POST /trigger
const TRIGGER_ROLES = ['admin', 'superadmin'];

// Statuses a need must be in before matching can run
const MATCHABLE_NEED_STATUSES = ['pending_match', 'matching', 'no_match_found'];

// ─── Geo helpers ───────────────────────────────────────────────────────────────
// These replicate the exact functions in helpers.js (same formulae, same constants).
// Duplicated here to keep matching.js self-contained and avoid a circular require.

/**
 * Returns the great-circle distance in kilometres between two WGS-84 points.
 * Uses the Haversine formula — never estimates or approximates.
 *
 * @param {number} lat1  Decimal degrees
 * @param {number} lon1  Decimal degrees
 * @param {number} lat2  Decimal degrees
 * @param {number} lon2  Decimal degrees
 * @returns {number} Distance in km (rounded to 2 decimal places)
 */
function haversineKm(lat1, lon1, lat2, lon2) {
  const R     = 6371;                          // Earth's mean radius, km
  const toRad = d => d * (Math.PI / 180);
  const dLat  = toRad(lat2 - lat1);
  const dLon  = toRad(lon2 - lon1);
  const a     = Math.sin(dLat / 2) ** 2
              + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2))
              * Math.sin(dLon / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 100) / 100;
}

/**
 * Computes a lat/lng bounding box for a given centre and radius.
 * Used to build a Firestore latitude range query before the precise Haversine check.
 *
 * @param {number} lat       Centre latitude (decimal degrees)
 * @param {number} lon       Centre longitude (decimal degrees)
 * @param {number} radiusKm  Search radius in kilometres
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

// ─── Scoring ───────────────────────────────────────────────────────────────────

/**
 * Computes a match score out of 100 for a candidate helper.
 * Only called after hard-filters (approved, online, category match, ≤200 km) pass.
 *
 * @param {Object} helper       Helper document (from Firestore)
 * @param {number} distanceKm   Haversine distance from the need's location
 * @returns {number}            Score 0–100 (higher = better match)
 */
function scoreHelper(helper, distanceKm) {
  // Distance: 60 pts max; linear decay from 0 to MATCH_RADIUS_KM
  const distanceScore   = Math.round(SCORE_DISTANCE * (1 - distanceKm / MATCH_RADIUS_KM));

  // Rating: 30 pts max; helper.rating is 0–5
  const rating          = Math.min(Math.max(Number(helper.rating) || 0, 0), 5);
  const ratingScore     = Math.round(SCORE_RATING * (rating / 5));

  // Experience: 1 pt per 5 resolved cases, capped at 10
  const experienceScore = Math.min(Math.floor((Number(helper.totalResolved) || 0) / 5), SCORE_EXPERIENCE);

  return distanceScore + ratingScore + experienceScore;
}

// ─── SMS sanitisation helper ───────────────────────────────────────────────────

/**
 * Strips control characters (including CR, LF, TAB) from a short string token
 * before it is interpolated into an outbound SMS body.
 * Defense-in-depth against SMS header injection — need.category, need.location,
 * and helper.name originally came from user input.
 *
 * @param {string} value  Raw value to sanitize
 * @param {number} max    Maximum length after stripping (default 80)
 * @returns {string}
 */
function sanitizeSMSToken(value, max = 80) {
  return String(value || '')
    .replace(/[\r\n\t\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ')
    .trim()
    .slice(0, max);
}

// ─── Language helpers for SMS notifications ────────────────────────────────────

// Maps ISO 3166-1 alpha-2 country code → ISO 639-1 language code.
// Mirrors COUNTRY_CONFIG in voice-service.js; English is the default fallback.
const COUNTRY_LANGUAGE = {
  RW: 'rw', KE: 'sw', TZ: 'sw', UG: 'en',
  NG: 'en', GH: 'en', SN: 'fr', CI: 'fr',
  CM: 'fr', MA: 'ar', EG: 'ar',
  CA: 'en', US: 'en', GB: 'en', FR: 'fr',
};

/**
 * Returns the ISO 639-1 language code for a helper's country.
 * Defaults to 'en' for unlisted countries.
 * @param {string} countryCode  ISO 3166-1 alpha-2 (e.g. 'RW')
 * @returns {string}
 */
function getHelperLanguage(countryCode) {
  return COUNTRY_LANGUAGE[String(countryCode || '').toUpperCase()] || 'en';
}

/**
 * Builds an SMS body to send to the matched helper, in their language.
 * @param {string} language     ISO 639-1 code
 * @param {string} category     Need category (e.g. 'food', 'medical')
 * @param {string} location     Need location (free-text)
 * @returns {string}
 */
function buildHelperMatchSMS(language, category, location) {
  const cat = sanitizeSMSToken(category || 'assistance', 40);
  const loc = sanitizeSMSToken(location  || 'nearby',    80);

  const t = {
    en: `BridgeUp: You have been matched with someone who needs ${cat} help near ${loc}. Open BridgeUp to accept or decline this match.`,
    rw: `BridgeUp: Wahuganye n'umuntu ukeneye ubufasha bw'${cat} hafi ya ${loc}. Fungura BridgeUp kwemera cyangwa kwangwa.`,
    sw: `BridgeUp: Umeoanishwa na mtu anayehitaji msaada wa ${cat} karibu na ${loc}. Fungua BridgeUp kukubali au kukataa.`,
    fr: `BridgeUp: Vous avez été mis en contact avec une personne ayant besoin d'aide pour ${cat} près de ${loc}. Ouvrez BridgeUp pour accepter ou décliner.`,
    ar: `BridgeUp: تم توصيلك بشخص يحتاج إلى مساعدة في ${cat} بالقرب من ${loc}. افتح BridgeUp للقبول أو الرفض.`,
  };
  return t[language] || t.en;
}

/**
 * Builds an SMS body to send to the person in need confirming a match.
 * @param {string} language   ISO 639-1 code (from need.language)
 * @param {string} helperName Helper's name
 * @returns {string}
 */
function buildNeedMatchSMS(language, helperName) {
  const name = sanitizeSMSToken(helperName || 'a helper', 60);

  const t = {
    en: `BridgeUp: Good news — ${name} has been matched to help you. They will contact you shortly. Reply STOP to opt out.`,
    rw: `BridgeUp: Amakuru meza — ${name} yabonanye gufasha. Bazakuvugisha vuba. Subiza STOP kureka.`,
    sw: `BridgeUp: Habari njema — ${name} ameoanishwa kukusaidia. Watakuwasiliana hivi karibuni. Jibu STOP kujiondoa.`,
    fr: `BridgeUp: Bonne nouvelle — ${name} a été trouvé pour vous aider. Il vous contactera bientôt. Répondez STOP.`,
    ar: `BridgeUp: أخبار رائعة — تم توصيلك بـ${name} للمساعدة. سيتصلون بك قريباً. رد STOP للإلغاء.`,
  };
  return t[language] || t.en;
}

/**
 * Builds an SMS confirming to the person in need that their match was accepted.
 * @param {string} language   ISO 639-1 code
 * @param {string} helperName Helper's name
 * @returns {string}
 */
function buildMatchAcceptedSMS(language, helperName) {
  const name = sanitizeSMSToken(helperName || 'Your helper', 60);

  const t = {
    en: `BridgeUp: ${name} has accepted your request and will be in touch soon.`,
    rw: `BridgeUp: ${name} yemeye gusaba kwawe kandi azakuvugisha vuba.`,
    sw: `BridgeUp: ${name} amekubali ombi lako na atakuwasiliana hivi karibuni.`,
    fr: `BridgeUp: ${name} a accepté votre demande et vous contactera bientôt.`,
    ar: `BridgeUp: ${name} قبل طلبك وسيتواصل معك قريباً.`,
  };
  return t[language] || t.en;
}

/**
 * Builds an SMS telling the person in need their helper declined and we are
 * searching for another one.
 * @param {string} language  ISO 639-1 code
 * @returns {string}
 */
function buildDeclineRematchingSMS(language) {
  const t = {
    en: `BridgeUp: Your previous helper was unable to take your request. We are searching for another helper now.`,
    rw: `BridgeUp: Umusazizi wawe ntashoboye gufasha. Turagashakisha undi muntu.`,
    sw: `BridgeUp: Msaidizi wako hakuweza kusaidia. Tunatafuta msaidizi mwingine sasa.`,
    fr: `BridgeUp: Votre aidant précédent n'a pas pu prendre votre demande. Nous cherchons un autre aidant.`,
    ar: `BridgeUp: لم يتمكن المساعد السابق من قبول طلبك. نحن نبحث عن مساعد آخر الآن.`,
  };
  return t[language] || t.en;
}

/**
 * Builds an honest no-match SMS for the person in need.
 * @param {string} language  ISO 639-1 code
 * @param {string} category  Need category
 * @returns {string}
 */
function buildNoMatchSMS(language, category) {
  const cat = sanitizeSMSToken(category || 'your request', 40);

  const t = {
    en: `BridgeUp: We are sorry — no verified helper was found near you for ${cat} right now. We will keep looking and notify you by SMS if one becomes available.`,
    rw: `BridgeUp: Mbabarira — nta musazizi wabonetse hafi yawe kuri ${cat} ubu. Tuzakomeza gushakisha kandi tuzabimenyesha.`,
    sw: `BridgeUp: Samahani — hakuna msaidizi aliyepatikana karibu nawe kwa ${cat} kwa sasa. Tutaendelea kutafuta na kukujulisha.`,
    fr: `BridgeUp: Désolé — aucun aidant vérifié n'a été trouvé près de vous pour ${cat} en ce moment. Nous continuerons à chercher et vous informerons.`,
    ar: `BridgeUp: نأسف — لم يتم العثور على مساعد موثق بالقرب منك لـ${cat} الآن. سنواصل البحث وسنعلمك عند توفر أحد.`,
  };
  return t[language] || t.en;
}

// ─── Response sanitisation ─────────────────────────────────────────────────────

/**
 * Strips sensitive fields from a match document before returning it to the client.
 * Full phone numbers are never returned — only the last 4 digits.
 * Timestamps are converted to ISO strings.
 *
 * @param {Object} match  Raw match document (from Firestore + id)
 * @returns {Object}
 */
function sanitizeMatch(match) {
  if (!match) return null;
  const out = { ...match };

  // Convert Timestamps to ISO strings
  for (const f of ['createdAt', 'updatedAt', 'acceptedAt', 'declinedAt', 'resolvedAt']) {
    if (out[f]?.toDate) out[f] = out[f].toDate().toISOString();
    else if (out[f] instanceof Date) out[f] = out[f].toISOString();
  }

  // Phone redaction: full number is never returned; always show only last 4 digits
  if (out.userPhone) {
    out.userPhoneLast4 = `***${String(out.userPhone).slice(-4)}`;
    delete out.userPhone;
  }

  return out;
}

// ─── Core matching logic ───────────────────────────────────────────────────────

/**
 * Queries the helpers collection for all eligible candidates for a given need.
 * Uses a lat/lng bounding box (fast Firestore query) followed by in-memory
 * longitude filter and precise Haversine distance calculation.
 *
 * Hard filters applied:
 *   status       === 'approved'
 *   isOnline     === true
 *   helpTypes    includes need.category
 *   distanceKm   <= MATCH_RADIUS_KM (200 km)
 *   id           NOT IN excludeHelperIds
 *
 * @param {Object}   need              Need document (with locationGeo.lat/lng)
 * @param {string[]} excludeHelperIds  Helper doc IDs to skip (previously declined)
 * @returns {Promise<Array>}           Scored + sorted candidates (desc by score)
 */
async function findEligibleHelpers(need, excludeHelperIds = []) {
  const { lat, lng } = need.locationGeo;
  const box          = boundingBox(lat, lng, MATCH_RADIUS_KM);

  // Firestore supports only one inequality filter per query.
  // We filter on latitude; longitude and Haversine are done in-memory.
  const snap = await db.collection(COLLECTIONS.HELPERS)
    .where('status',   '==', 'approved')
    .where('isOnline', '==', true)
    .where('latitude', '>=', box.minLat)
    .where('latitude', '<=', box.maxLat)
    .get();

  const all = queryToArray(snap);

  const scored = all
    .filter(h => {
      // Longitude bounding box (second spatial filter — Firestore can't apply this)
      if (h.longitude < box.minLon || h.longitude > box.maxLon) return false;
      // Must handle this need's category
      if (!Array.isArray(h.helpTypes) || !h.helpTypes.includes(need.category)) return false;
      // Must not have been previously declined for this need
      if (excludeHelperIds.includes(h.id)) return false;
      return true;
    })
    .map(h => {
      const distKm = haversineKm(lat, lng, h.latitude, h.longitude);
      return { ...h, distanceKm: distKm };
    })
    // Precise radius check after Haversine (bounding box slightly over-selects corners)
    .filter(h => h.distanceKm <= MATCH_RADIUS_KM)
    .map(h => ({ ...h, score: scoreHelper(h, h.distanceKm) }))
    // Descending: highest score first
    .sort((a, b) => b.score - a.score);

  return scored;
}

/**
 * Core matching transaction: selects the best helper, writes the match record,
 * updates the need document, and sends SMS notifications to both parties.
 *
 * Called by POST /trigger and by PATCH /matches/:id/decline (re-match).
 *
 * @param {string}   needId       Firestore document ID for the need
 * @param {string}   actorId      userId of the caller (for audit log)
 * @param {string[]} excludeIds   Helper doc IDs to exclude (previously declined)
 * @returns {Promise<{
 *   matched:  boolean,
 *   matchId?: string,
 *   match?:   Object,   sanitized match record
 *   reason?:  string,   'need_not_found' | 'no_geocoordinates' | 'need_not_matchable' | 'no_helpers_found'
 * }>}
 */
async function runMatching(needId, actorId, excludeIds = []) {
  // ── 1. Load and validate the need document ──────────────────────────────────
  const needSnap = await db.collection(COLLECTIONS.NEEDS).doc(needId).get();
  if (!needSnap.exists) {
    return { matched: false, reason: 'need_not_found' };
  }

  const need = docToObject(needSnap);

  // ── 2. Geocoordinates must be present ────────────────────────────────────────
  // needs.js stores locationGeo: null initially, populated by the geocoding service.
  // Matching without coordinates would require a full-collection scan.
  const geo = need.locationGeo;
  if (!geo || typeof geo.lat !== 'number' || typeof geo.lng !== 'number'
      || isNaN(geo.lat) || isNaN(geo.lng)) {
    return { matched: false, reason: 'no_geocoordinates' };
  }

  // ── 3. Need status must allow matching ────────────────────────────────────────
  if (!MATCHABLE_NEED_STATUSES.includes(need.status)) {
    return { matched: false, reason: 'need_not_matchable', currentStatus: need.status };
  }

  // ── 4. Mark need as in-progress to prevent concurrent match triggers ─────────
  await db.collection(COLLECTIONS.NEEDS).doc(needId).update({
    status:    'matching',
    updatedAt: FieldValue.serverTimestamp(),
  });

  // ── 5. Find eligible candidates ───────────────────────────────────────────────
  let candidates;
  try {
    candidates = await findEligibleHelpers(need, excludeIds);
  } catch (err) {
    // Restore matchable status on query failure so the trigger can be retried
    await db.collection(COLLECTIONS.NEEDS).doc(needId).update({
      status:    need.status,  // restore original status
      updatedAt: FieldValue.serverTimestamp(),
    }).catch(() => {});
    throw err;  // propagate to route handler
  }

  // ── 6. No helpers found ────────────────────────────────────────────────────────
  if (candidates.length === 0) {
    await db.collection(COLLECTIONS.NEEDS).doc(needId).update({
      status:    'no_match_found',
      updatedAt: FieldValue.serverTimestamp(),
    });

    // Honest no-match SMS — fire-and-forget (never fail the API response over SMS)
    sendSMS(
      need.phone,
      buildNoMatchSMS(need.language || 'en', need.category)
    ).catch(err =>
      console.error(`[Matching] No-match SMS failed to ***${String(need.phone).slice(-4)}:`, err.message)
    );

    writeAuditLog({
      action:   'matching_no_match',
      actorId,
      targetId: needId,
      meta: { category: need.category, excludedCount: excludeIds.length },
    }).catch(() => {});

    return { matched: false, reason: 'no_helpers_found' };
  }

  // ── 7. Write the match record ─────────────────────────────────────────────────
  const best = candidates[0];

  const matchData = {
    needId,
    helperId:     best.id,
    helperUserId: best.userId,   // used for IDOR checks without a secondary lookup
    userId:       need.userId   || null,
    userPhone:    need.phone,    // stored for SMS; never returned raw in API responses
    category:     need.category,
    tenantId:     need.tenantId || null,
    distanceKm:   best.distanceKm,
    score:        best.score,
    status:       'pending',
    createdAt:    FieldValue.serverTimestamp(),
    updatedAt:    FieldValue.serverTimestamp(),
    acceptedAt:   null,
    declinedAt:   null,
    resolvedAt:   null,
    declineReason: null,
  };

  const matchRef = await db.collection(COLLECTIONS.MATCHES).add(matchData);

  // ── 8. Update the need document ───────────────────────────────────────────────
  await db.collection(COLLECTIONS.NEEDS).doc(needId).update({
    status:          'matched',
    matchedHelperId: best.id,
    matchedAt:       FieldValue.serverTimestamp(),
    updatedAt:       FieldValue.serverTimestamp(),
  });

  // ── 9. SMS to matched helper — fire-and-forget ────────────────────────────────
  const helperPhone = best.contactPhone || null;
  if (helperPhone) {
    const helperLang = getHelperLanguage(best.country || '');
    sendSMS(
      helperPhone,
      buildHelperMatchSMS(helperLang, need.category, need.location)
    ).catch(err =>
      console.error(`[Matching] Helper SMS failed to ***${String(helperPhone).slice(-4)}:`, err.message)
    );
  } else {
    console.warn(`[Matching] Helper ${best.id} has no contactPhone — SMS notification skipped`);
  }

  // ── 10. SMS to person in need — fire-and-forget ───────────────────────────────
  sendSMS(
    need.phone,
    buildNeedMatchSMS(need.language || 'en', best.name)
  ).catch(err =>
    console.error(`[Matching] Need SMS failed to ***${String(need.phone).slice(-4)}:`, err.message)
  );

  // ── 11. Audit log ─────────────────────────────────────────────────────────────
  writeAuditLog({
    action:   'match_created',
    actorId,
    targetId: matchRef.id,
    meta: {
      needId,
      helperId:    best.id,
      score:       best.score,
      distanceKm:  best.distanceKm,
      category:    need.category,
      candidateCount: candidates.length,
    },
  }).catch(() => {});

  return {
    matched: true,
    matchId: matchRef.id,
    match: sanitizeMatch({
      id:           matchRef.id,
      ...matchData,
      helperName:   best.name,
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 1 — POST /trigger
// Admin/superadmin initiates matching for a specific need.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Body:     { needId: string }
 * Auth:     admin | superadmin
 * Response: { matched: boolean, matchId?, ...matchFields }
 */
router.post('/trigger', matchingLimiter, requireAuth, async (req, res) => {
  const { role, userId: actorId, tenantId: callerTenantId } = req.user;

  if (!TRIGGER_ROLES.includes(role)) {
    return res.status(403).json({
      error: 'Access denied. Matching can only be triggered by admin or superadmin.',
    });
  }

  const { needId: rawNeedId } = req.body;

  // Validate needId format before using as a Firestore document path
  if (!rawNeedId || !DOC_ID_PATTERN.test(String(rawNeedId))) {
    return res.status(400).json({ error: 'needId is required and must be a valid document ID.' });
  }
  const needId = String(rawNeedId);

  // ── Tenant isolation: load need first so we can check tenantId ───────────────
  // superadmin can trigger for any need; admin only for their own tenant.
  let needForAuthCheck;
  try {
    const preSnap = await db.collection(COLLECTIONS.NEEDS).doc(needId).get();
    if (!preSnap.exists) {
      return res.status(404).json({ error: 'Need not found. Please check the needId.' });
    }
    needForAuthCheck = preSnap.data();
  } catch (err) {
    console.error('[Matching] /trigger pre-load error:', err.message);
    return res.status(500).json({ error: 'Could not load need. Please try again.' });
  }

  // Fail-closed: admin may only trigger matching for needs in their own tenant.
  // Removing the middle `&& needForAuthCheck.tenantId` guard (which was fail-open)
  // means needs with tenantId: null are also blocked for admins — only superadmin
  // can trigger matching for anonymous (tenantless) needs.
  if (role === 'admin' && needForAuthCheck.tenantId !== callerTenantId) {
    return res.status(403).json({
      error: 'Access denied. This need belongs to a different tenant.',
    });
  }

  // ── Run the matching engine ──────────────────────────────────────────────────
  try {
    const result = await runMatching(needId, actorId, []);

    if (!result.matched) {
      // Map internal reason codes to HTTP status codes and user-readable messages
      const STATUS_MAP = {
        need_not_found:     [404, 'Need not found. Please check the needId.'],
        no_geocoordinates:  [422, 'This need has no location coordinates. The geocoding service must run before matching can proceed.'],
        need_not_matchable: [409, `This need is in status "${result.currentStatus || 'unknown'}" and cannot be matched right now.`],
        no_helpers_found:   [200, 'No verified helpers were found within 200 km. The person in need has been notified by SMS.'],
      };

      const [httpStatus, message] = STATUS_MAP[result.reason] || [500, 'Matching could not be completed.'];

      return res.status(httpStatus).json({
        matched: false,
        reason:  result.reason,
        message,
      });
    }

    return res.json({
      matched:  true,
      matchId:  result.matchId,
      ...result.match,
    });
  } catch (err) {
    console.error('[Matching] /trigger error:', err.message);
    return res.status(500).json({ error: 'Matching could not be completed right now. Please try again.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 2 — GET /matches
// Returns matches filtered by the caller's role.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Role behaviour:
 *   helper    — matches where helperUserId === req.user.userId
 *   user      — matches where userId === req.user.userId OR userPhone === req.user.phone
 *   admin/ngo — all matches for their tenant (tenantId === req.user.tenantId)
 *   superadmin — all matches on the platform
 *
 * Query params:
 *   status   string   Filter by match status
 *   limit    number   Max results (default 50, max 200)
 *   cursor   string   Document ID of the last item on the previous page
 */
router.get('/matches', requireAuth, async (req, res) => {
  const { role, userId, phone: callerPhone, tenantId: callerTenantId } = req.user;

  const { cursor: rawCursor, status: rawStatus, limit: rawLimit } = req.query;
  // Clamp to [1, 200] — parseInt may return a negative number if the caller
  // sends e.g. limit=-1; Firestore throws on negative .limit() values.
  const pageLimit = Math.min(Math.max(parseInt(rawLimit, 10) || 50, 1), 200);

  const statusFilter = rawStatus && MATCH_STATUSES.includes(String(rawStatus).trim())
    ? String(rawStatus).trim() : null;

  try {
    let query = db.collection(COLLECTIONS.MATCHES);

    if (role === 'helper') {
      // Helpers see only their own assigned matches — identified by helperUserId (JWT claim)
      query = query.where('helperUserId', '==', userId);

    } else if (role === 'user') {
      // Users see only needs they submitted — matched by their JWT userId
      // Falls back to phone match for needs submitted anonymously (no userId)
      query = query.where('userId', '==', userId);
      // Note: anonymous needs matched by phone are handled by a separate query below

    } else if (['admin', 'ngo'].includes(role)) {
      // Admins see all matches for their tenant only
      query = query.where('tenantId', '==', callerTenantId);

    } else if (role === 'superadmin') {
      // Superadmin sees all matches — no tenant filter
    } else {
      return res.status(403).json({ error: 'Access denied.' });
    }

    if (statusFilter) query = query.where('status', '==', statusFilter);

    query = query.orderBy('createdAt', 'desc').limit(pageLimit);

    if (rawCursor) {
      if (!DOC_ID_PATTERN.test(String(rawCursor))) {
        return res.status(400).json({ error: 'Invalid cursor value.' });
      }
      const cursorSnap = await db.collection(COLLECTIONS.MATCHES).doc(String(rawCursor)).get();
      if (cursorSnap.exists) query = query.startAfter(cursorSnap);
    }

    const snap = await query.get();
    let matches = queryToArray(snap).map(sanitizeMatch);

    // For 'user' role: also fetch matches for anonymous needs submitted with this phone.
    // (Needs submitted before the user created an account have userId: null but phone set.)
    //
    // Intentionally single-field query (no compound index required — Firestore creates
    // single-field indexes automatically). Status filter is applied in-memory below.
    if (role === 'user') {
      const phoneSnap = await db.collection(COLLECTIONS.MATCHES)
        .where('userPhone', '==', callerPhone)
        .get();

      const phoneMatches = queryToArray(phoneSnap)
        .filter(m => !statusFilter || m.status === statusFilter)
        .map(sanitizeMatch);

      // Merge and de-duplicate (a match could appear in both if userId was set after creation)
      const seen = new Set(matches.map(m => m.id));
      for (const m of phoneMatches) {
        if (!seen.has(m.id)) matches.push(m);
      }

      // Re-sort merged result by createdAt desc
      matches.sort((a, b) => {
        const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return tb - ta;
      });

      matches = matches.slice(0, pageLimit);
    }

    return res.json({
      matches,
      count:      matches.length,
      hasMore:    matches.length === pageLimit,
      nextCursor: matches.length === pageLimit ? matches[matches.length - 1].id : null,
    });
  } catch (err) {
    console.error('[Matching] GET /matches error:', err.message);
    return res.status(500).json({ error: 'Could not load matches. Please try again.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 3 — PATCH /matches/:id/accept
// Helper accepts an assigned match.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Auth:     helper only (must own the match via helperUserId)
 * Response: { success: true, match: sanitizedMatch }
 */
router.patch('/matches/:id/accept', matchingLimiter, requireAuth, async (req, res) => {
  const { id: rawId } = req.params;
  const { userId, role } = req.user;

  // Only helpers can accept
  if (role !== 'helper') {
    return res.status(403).json({ error: 'Only a helper can accept a match.' });
  }

  // Validate match document ID
  if (!rawId || !DOC_ID_PATTERN.test(rawId)) {
    return res.status(400).json({ error: 'Invalid match ID.' });
  }
  const matchId = rawId;

  try {
    const matchSnap = await db.collection(COLLECTIONS.MATCHES).doc(matchId).get();
    if (!matchSnap.exists) {
      return res.status(404).json({ error: 'Match not found.' });
    }

    const match = docToObject(matchSnap);

    // IDOR: only the helper assigned to this match can accept it
    if (match.helperUserId !== userId) {
      return res.status(403).json({ error: 'Access denied. This match was not assigned to you.' });
    }

    // Status guard: can only accept a pending match
    if (match.status !== 'pending') {
      return res.status(409).json({
        error: `This match cannot be accepted. Current status: "${match.status}".`,
      });
    }

    // Update match status
    await db.collection(COLLECTIONS.MATCHES).doc(matchId).update({
      status:     'accepted',
      acceptedAt: FieldValue.serverTimestamp(),
      updatedAt:  FieldValue.serverTimestamp(),
    });

    // Load the need to get the user's language and phone for the SMS
    const needSnap = await db.collection(COLLECTIONS.NEEDS).doc(match.needId).get();
    const need     = needSnap.exists ? needSnap.data() : null;

    // Also update the need to in_progress
    if (need) {
      await db.collection(COLLECTIONS.NEEDS).doc(match.needId).update({
        status:    'in_progress',
        updatedAt: FieldValue.serverTimestamp(),
      });

      // Load helper name for the SMS
      const helperSnap = await db.collection(COLLECTIONS.HELPERS)
        .where('userId', '==', userId).limit(1).get();
      const helperName = helperSnap.empty ? 'Your helper' : helperSnap.docs[0].data().name;

      // Notify the person in need — fire-and-forget
      sendSMS(
        match.userPhone,
        buildMatchAcceptedSMS(need.language || 'en', helperName)
      ).catch(err =>
        console.error(`[Matching] Accept SMS failed to ***${String(match.userPhone).slice(-4)}:`, err.message)
      );
    }

    writeAuditLog({
      action:   'match_accepted',
      actorId:  userId,
      targetId: matchId,
      meta:     { needId: match.needId },
    }).catch(() => {});

    // Fetch updated match and return it
    const updatedSnap = await db.collection(COLLECTIONS.MATCHES).doc(matchId).get();
    return res.json({ success: true, match: sanitizeMatch(docToObject(updatedSnap)) });
  } catch (err) {
    console.error('[Matching] /accept error:', err.message);
    return res.status(500).json({ error: 'Could not accept match. Please try again.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 4 — PATCH /matches/:id/decline
// Helper declines. Automatically triggers re-matching for the next best helper.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Auth:     helper only (must own the match via helperUserId)
 * Response: { declined: true, rematched: boolean, newMatchId?, newMatch? }
 */
router.patch('/matches/:id/decline', matchingLimiter, requireAuth, async (req, res) => {
  const { id: rawId } = req.params;
  const { userId, role } = req.user;

  if (role !== 'helper') {
    return res.status(403).json({ error: 'Only a helper can decline a match.' });
  }

  if (!rawId || !DOC_ID_PATTERN.test(rawId)) {
    return res.status(400).json({ error: 'Invalid match ID.' });
  }
  const matchId = rawId;

  const { reason: rawReason } = req.body;
  // Sanitize optional decline reason — strip tags, control chars, cap length
  const declineReason = rawReason
    ? String(rawReason)
        .replace(/<[^>]*>/g, '')
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
        .trim()
        .slice(0, 300)
    : null;

  try {
    const matchSnap = await db.collection(COLLECTIONS.MATCHES).doc(matchId).get();
    if (!matchSnap.exists) {
      return res.status(404).json({ error: 'Match not found.' });
    }

    const match = docToObject(matchSnap);

    // IDOR: only the assigned helper can decline
    if (match.helperUserId !== userId) {
      return res.status(403).json({ error: 'Access denied. This match was not assigned to you.' });
    }

    if (match.status !== 'pending') {
      return res.status(409).json({
        error: `This match cannot be declined. Current status: "${match.status}".`,
      });
    }

    // ── Mark this match as declined ──────────────────────────────────────────
    await db.collection(COLLECTIONS.MATCHES).doc(matchId).update({
      status:        'declined',
      declinedAt:    FieldValue.serverTimestamp(),
      declineReason: declineReason,
      updatedAt:     FieldValue.serverTimestamp(),
    });

    writeAuditLog({
      action:   'match_declined',
      actorId:  userId,
      targetId: matchId,
      meta:     { needId: match.needId, reason: declineReason || null },
    }).catch(() => {});

    // ── Build the excluded-helper list (all helpers who have declined this need) ─
    const declinedSnap = await db.collection(COLLECTIONS.MATCHES)
      .where('needId', '==', match.needId)
      .where('status', '==', 'declined')
      .get();

    const excludeIds = declinedSnap.docs.map(d => d.data().helperId).filter(Boolean);

    // ── Notify person in need: searching for a new helper ─────────────────────
    const needSnap = await db.collection(COLLECTIONS.NEEDS).doc(match.needId).get();
    const needLang = needSnap.exists ? (needSnap.data().language || 'en') : 'en';

    sendSMS(
      match.userPhone,
      buildDeclineRematchingSMS(needLang)
    ).catch(err =>
      console.error(`[Matching] Decline-rematching SMS failed to ***${String(match.userPhone).slice(-4)}:`, err.message)
    );

    // ── Trigger re-matching with all previously declined helpers excluded ──────
    const rematchResult = await runMatching(match.needId, `helper:${userId}`, excludeIds);

    if (!rematchResult.matched) {
      return res.json({
        declined:  true,
        rematched: false,
        reason:    rematchResult.reason,
        message:   rematchResult.reason === 'no_helpers_found'
          ? 'No further helpers were found. The person in need has been notified.'
          : 'Re-matching could not run. Please trigger matching manually.',
      });
    }

    return res.json({
      declined:   true,
      rematched:  true,
      newMatchId: rematchResult.matchId,
      newMatch:   rematchResult.match,
    });
  } catch (err) {
    console.error('[Matching] /decline error:', err.message);
    return res.status(500).json({ error: 'Could not process decline. Please try again.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 5 — GET /matches/:id
// Returns a single match with the need and helper documents joined.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Auth:     any authenticated user
 * IDOR:
 *   user      — match.userId === req.user.userId OR match.userPhone === req.user.phone
 *   helper    — match.helperUserId === req.user.userId
 *   admin/ngo — match.tenantId === req.user.tenantId
 *   superadmin — always allowed
 * Response: { match, need, helper }
 */
router.get('/matches/:id', requireAuth, async (req, res) => {
  const { id: rawId } = req.params;
  const { userId, phone: callerPhone, role, tenantId: callerTenantId } = req.user;

  if (!rawId || !DOC_ID_PATTERN.test(rawId)) {
    return res.status(400).json({ error: 'Invalid match ID.' });
  }
  const matchId = rawId;

  try {
    const matchSnap = await db.collection(COLLECTIONS.MATCHES).doc(matchId).get();
    if (!matchSnap.exists) {
      return res.status(404).json({ error: 'Match not found.' });
    }

    const match = docToObject(matchSnap);

    // ── IDOR access check ────────────────────────────────────────────────────
    let canAccess = false;
    if (role === 'superadmin') {
      canAccess = true;
    } else if (['admin', 'ngo'].includes(role)) {
      canAccess = match.tenantId === callerTenantId;
    } else if (role === 'helper') {
      canAccess = match.helperUserId === userId;
    } else {
      // Standard user: matched by their userId or by their phone (for anonymous needs)
      canAccess = match.userId === userId || match.userPhone === callerPhone;
    }

    if (!canAccess) {
      // Return 404 to avoid confirming the match exists to an unauthorized caller
      return res.status(404).json({ error: 'Match not found.' });
    }

    // ── Load joined documents in parallel ────────────────────────────────────
    const [needSnap, helperSnap] = await Promise.all([
      db.collection(COLLECTIONS.NEEDS).doc(match.needId).get(),
      db.collection(COLLECTIONS.HELPERS).doc(match.helperId).get(),
    ]);

    const need   = needSnap.exists   ? docToObject(needSnap)   : null;
    const helper = helperSnap.exists ? docToObject(helperSnap) : null;

    // ── Sanitize joined need (PII reduction) ─────────────────────────────────
    let safeNeed = null;
    if (need) {
      safeNeed = { ...need };

      // Convert Timestamps
      for (const f of ['createdAt', 'updatedAt', 'matchedAt', 'resolvedAt']) {
        if (safeNeed[f]?.toDate) safeNeed[f] = safeNeed[f].toDate().toISOString();
      }

      // Redact phone — only show last 4 digits to helpers and admins
      if (role === 'helper' || role === 'admin' || role === 'ngo') {
        if (safeNeed.phone) {
          safeNeed.phoneLast4 = `***${String(safeNeed.phone).slice(-4)}`;
          delete safeNeed.phone;
        }
      }

      // Never expose userId to helpers
      if (role === 'helper') delete safeNeed.userId;
    }

    // ── Sanitize joined helper (public profile only) ──────────────────────────
    let safeHelper = null;
    if (helper) {
      safeHelper = {
        id:           helper.id,
        name:         helper.name,
        organization: helper.organization || null,
        helpTypes:    helper.helpTypes    || [],
        city:         helper.city         || null,
        country:      helper.country      || null,
        rating:       helper.rating       || 0,
        totalResolved: helper.totalResolved || 0,
        bio:          helper.bio          || null,
        contactMethod: helper.contactMethod || null,
        isOnline:     helper.isOnline     || false,
      };

      // Convert any Timestamps on helper
      for (const f of ['createdAt', 'approvedAt']) {
        if (helper[f]?.toDate) safeHelper[f] = helper[f].toDate().toISOString();
      }
    }

    return res.json({
      match:  sanitizeMatch(match),
      need:   safeNeed,
      helper: safeHelper,
    });
  } catch (err) {
    console.error('[Matching] GET /matches/:id error:', err.message);
    return res.status(500).json({ error: 'Could not load match details. Please try again.' });
  }
});

module.exports = router;
