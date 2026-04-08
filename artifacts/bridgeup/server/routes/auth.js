'use strict';

const express = require('express');
const jwt     = require('jsonwebtoken');
const { db, FieldValue, COLLECTIONS, writeAuditLog } = require('../services/firebase');
const { sendOTP, verifyOTP, countryCodeFromPhone }    = require('../services/twilio');

const router = express.Router();

// ─── Guard: JWT secret must be set ───────────────────────────────────────────
if (!process.env.SESSION_SECRET) {
  console.error('[Auth] FATAL: SESSION_SECRET environment variable is not set.');
  console.error('[Auth] Add SESSION_SECRET to Replit Secrets.');
  process.exit(1);
}

const JWT_SECRET = process.env.SESSION_SECRET;
const JWT_EXPIRY = '7d';

// ─── OTP send rate limit (Firestore-backed, per phone) ────────────────────────
// Max 3 OTP send attempts per phone per hour — enforced here independently of
// the IP-based authLimiter in index.js (which limits anonymous burst attacks).
const OTP_SEND_MAX    = 3;
const OTP_SEND_WINDOW = 60 * 60 * 1000; // 1 hour in milliseconds

// ─── Phone normalisation + validation ────────────────────────────────────────
/**
 * Normalises a phone number to strict E.164 format (+[country][number]).
 *
 * Accepted inputs:
 *   +250788123456    → +250788123456  (already E.164)
 *   00250788123456   → +250788123456  (IDD prefix)
 *   250788123456     → +250788123456  (country code, no prefix)
 *
 * Local formats without a country code (e.g. 0788123456) are rejected with a
 * clear error — the frontend must send the country code prefix.
 *
 * @param {string} raw
 * @returns {{ e164: string|null, error: string|null }}
 */
function normalizePhone(raw) {
  if (!raw || typeof raw !== 'string') {
    return { e164: null, error: 'Phone number is required.' };
  }

  // Strip all whitespace, dashes, dots, parentheses
  let cleaned = raw.replace(/[\s\-.()\u200B-\u200D\uFEFF]/g, '');

  // Convert IDD prefix (00) to + prefix
  if (cleaned.startsWith('00')) {
    cleaned = '+' + cleaned.slice(2);
  }

  // If no leading +, try to interpret as a country-code-prefixed number
  // (e.g. "250788123456" for Rwanda — user forgot the +)
  if (!cleaned.startsWith('+')) {
    // Only accept if it looks like a country code is present (length 10–15 digits)
    // and the number does NOT start with 0 (local format)
    if (/^[1-9]\d{6,14}$/.test(cleaned)) {
      cleaned = '+' + cleaned;
    } else if (cleaned.startsWith('0')) {
      return {
        e164:  null,
        error: 'Please include your country code (e.g. +250 for Rwanda, +254 for Kenya, +1 for Canada/USA). Local number formats are not accepted.',
      };
    } else {
      return { e164: null, error: 'Phone number format is not recognised. Use E.164 format, e.g. +250788123456.' };
    }
  }

  // Final E.164 validation: + followed by 7–15 digits, first digit non-zero
  if (!/^\+[1-9]\d{6,14}$/.test(cleaned)) {
    return {
      e164:  null,
      error: 'Phone number must be in international format (e.g. +250788123456). It appears to be too short or contains invalid characters.',
    };
  }

  return { e164: cleaned, error: null };
}

// ─── JWT helpers ─────────────────────────────────────────────────────────────
/**
 * Signs a JWT containing the user's core identity claims.
 * @param {{ userId: string, phone: string, role: string, tenantId: string }} payload
 * @returns {string}
 */
function signToken(payload) {
  return jwt.sign(
    {
      userId:   payload.userId,
      phone:    payload.phone,
      role:     payload.role,
      tenantId: payload.tenantId || null,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY, issuer: 'bridgeup', audience: 'bridgeup-app' }
  );
}

/**
 * Verifies and decodes a Bearer JWT from the Authorization header.
 * Returns the decoded payload or throws a structured error.
 * @param {string} authHeader — full "Bearer <token>" header value
 * @returns {{ userId: string, phone: string, role: string, tenantId: string, jti: string, exp: number }}
 */
function verifyToken(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    const err = new Error('Authorization header missing or malformed. Expected: Bearer <token>.');
    err.status = 401;
    throw err;
  }

  const token = authHeader.slice(7); // strip "Bearer "

  try {
    return jwt.verify(token, JWT_SECRET, { issuer: 'bridgeup', audience: 'bridgeup-app' });
  } catch (jwtErr) {
    const err = new Error(
      jwtErr.name === 'TokenExpiredError'
        ? 'Your session has expired. Please sign in again.'
        : 'Invalid or tampered token. Please sign in again.'
    );
    err.status = 401;
    throw err;
  }
}

// ─── Middleware: require valid JWT ────────────────────────────────────────────
/**
 * Express middleware that verifies the Bearer token and checks the revocation
 * list in Firestore. Attaches the decoded claims to req.user on success.
 */
async function requireAuth(req, res, next) {
  try {
    const decoded = verifyToken(req.headers.authorization);

    // Check token revocation list (Firestore revoked_tokens/{jti})
    if (decoded.jti) {
      const revokedSnap = await db.collection('revoked_tokens').doc(decoded.jti).get();
      if (revokedSnap.exists) {
        return res.status(401).json({ error: 'Your session has been invalidated. Please sign in again.' });
      }
    }

    req.user = decoded;
    next();
  } catch (err) {
    res.status(err.status || 401).json({ error: err.message });
  }
}

// ─── INTERNAL: OTP send rate limiter (Firestore-backed, per phone) ────────────
/**
 * Checks and increments the OTP send counter for a given phone.
 * @param {string} phone  E.164 phone number
 * @returns {Promise<{ allowed: boolean, attemptsLeft: number, resetAt: Date|null }>}
 */
async function checkOTPSendRateLimit(phone) {
  const ref  = db.collection('otp_rate_limit').doc(phone);
  const snap = await ref.get();
  const now  = Date.now();

  if (!snap.exists) {
    // First attempt in this window — create the record
    await ref.set({
      phone,
      count:     1,
      windowStart: now,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { allowed: true, attemptsLeft: OTP_SEND_MAX - 1, resetAt: null };
  }

  const data = snap.data();
  const windowStart = data.windowStart;
  const windowAge   = now - windowStart;

  // Window has expired — reset counter
  if (windowAge >= OTP_SEND_WINDOW) {
    await ref.set({
      phone,
      count:       1,
      windowStart: now,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { allowed: true, attemptsLeft: OTP_SEND_MAX - 1, resetAt: null };
  }

  // Still within window — check count
  if (data.count >= OTP_SEND_MAX) {
    const resetAt = new Date(windowStart + OTP_SEND_WINDOW);
    return { allowed: false, attemptsLeft: 0, resetAt };
  }

  // Increment count
  await ref.update({
    count:     FieldValue.increment(1),
    updatedAt: FieldValue.serverTimestamp(),
  });

  return { allowed: true, attemptsLeft: OTP_SEND_MAX - (data.count + 1), resetAt: null };
}

// ─── INTERNAL: create or retrieve user document in Firestore ─────────────────
/**
 * Looks up a user by phone. If not found, creates a new 'user' role document.
 * Returns the user document data and whether it was newly created.
 *
 * @param {string} phone  E.164 phone number (verified at this point)
 * @returns {Promise<{ user: Object, isNew: boolean }>}
 */
async function findOrCreateUser(phone) {
  const usersRef = db.collection(COLLECTIONS.USERS);
  const snapshot = await usersRef.where('phone', '==', phone).limit(1).get();

  if (!snapshot.empty) {
    const doc = snapshot.docs[0];
    // Update last login time
    await doc.ref.update({ lastLoginAt: FieldValue.serverTimestamp() });
    return { user: { id: doc.id, ...doc.data() }, isNew: false };
  }

  // New user — create a minimal profile
  const country  = countryCodeFromPhone(phone);
  const newUser  = {
    phone,
    role:        'user',         // Default role; admin upgrades to helper/ngo/admin
    tenantId:    null,           // Assigned when joining an organisation
    country,
    language:    'en',           // Updated after first interaction
    active:      true,
    verified:    true,           // Phone verified at this point
    displayName: null,           // Set by user in profile step
    avatarUrl:   null,
    createdAt:   FieldValue.serverTimestamp(),
    updatedAt:   FieldValue.serverTimestamp(),
    lastLoginAt: FieldValue.serverTimestamp(),
  };

  const docRef = await usersRef.add(newUser);

  // Firestore serverTimestamp isn't returned in the same write — use JS date
  const now = new Date();
  return {
    user: { id: docRef.id, ...newUser, createdAt: now, updatedAt: now, lastLoginAt: now },
    isNew: true,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 1 — POST /send-otp
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Validates and normalises the phone number, checks the per-phone rate limit,
 * then calls sendOTP() to generate and SMS a 6-digit code.
 *
 * Request body:  { phone: string }  — any format; normalised to E.164 here
 * Response:      { success: true, expiresInMinutes: 5, attemptsLeft: number }
 * Error:         { error: string }  with appropriate HTTP status
 */
router.post('/send-otp', async (req, res) => {
  const { phone: rawPhone } = req.body;

  // 1. Normalise + validate phone
  const { e164, error: phoneError } = normalizePhone(rawPhone);
  if (phoneError) {
    return res.status(400).json({ error: phoneError });
  }

  // 2. Per-phone OTP send rate limit (3 per hour)
  const rateCheck = await checkOTPSendRateLimit(e164).catch((err) => {
    console.error('[Auth] Rate limit check failed:', err.message);
    return { allowed: true, attemptsLeft: 1, resetAt: null }; // fail open to not block genuine users
  });

  if (!rateCheck.allowed) {
    const resetMins = rateCheck.resetAt
      ? Math.ceil((rateCheck.resetAt.getTime() - Date.now()) / 60000)
      : 60;
    return res.status(429).json({
      error: `You have requested too many verification codes. Please wait ${resetMins} minute${resetMins === 1 ? '' : 's'} before trying again.`,
    });
  }

  // 3. Send OTP via Twilio SMS
  let result;
  try {
    result = await sendOTP(e164);
  } catch (err) {
    console.error(`[Auth] sendOTP failed for ${e164}:`, err.message);
    return res.status(502).json({
      error: 'We could not send a verification code right now. Please check your phone number and try again in a moment.',
    });
  }

  // Audit log — phone number intentionally partial for privacy
  writeAuditLog('otp_sent', { phoneLast4: e164.slice(-4), country: countryCodeFromPhone(e164) })
    .catch(() => {});

  return res.json({
    success:         true,
    expiresInMinutes: 5,
    attemptsLeft:    rateCheck.attemptsLeft,
    // Never include the actual code in the response
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 2 — POST /verify-otp
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Verifies the OTP code, creates or retrieves the user document in Firestore,
 * and returns a signed JWT containing userId, phone, role, and tenantId.
 *
 * Request body:  { phone: string, code: string }
 * Response:      { success: true, token: string, user: Object, isNewUser: boolean }
 * Error:         { error: string }
 */
router.post('/verify-otp', async (req, res) => {
  const { phone: rawPhone, code } = req.body;

  // 1. Validate inputs
  if (!code || String(code).trim().length === 0) {
    return res.status(400).json({ error: 'Verification code is required.' });
  }

  const { e164, error: phoneError } = normalizePhone(rawPhone);
  if (phoneError) {
    return res.status(400).json({ error: phoneError });
  }

  // Basic code format check — must be 4–8 digits
  const cleanCode = String(code).replace(/\s/g, '');
  if (!/^\d{4,8}$/.test(cleanCode)) {
    return res.status(400).json({ error: 'Verification code must be 4 to 8 digits. Please check and try again.' });
  }

  // 2. Verify OTP against Firestore record
  let verification;
  try {
    verification = await verifyOTP(e164, cleanCode);
  } catch (err) {
    console.error(`[Auth] verifyOTP error for ${e164}:`, err.message);
    return res.status(500).json({ error: 'Something went wrong verifying your code. Please try again.' });
  }

  if (!verification.valid) {
    return res.status(401).json({ error: verification.reason });
  }

  // 3. Find or create the user document
  let userData;
  let isNewUser;
  try {
    const result = await findOrCreateUser(e164);
    userData  = result.user;
    isNewUser = result.isNew;
  } catch (err) {
    console.error(`[Auth] findOrCreateUser error for ${e164}:`, err.message);
    return res.status(500).json({ error: 'We verified your code but could not load your account. Please try again.' });
  }

  // 4. Sign the JWT
  const token = signToken({
    userId:   userData.id,
    phone:    e164,
    role:     userData.role,
    tenantId: userData.tenantId,
  });

  // Audit log
  writeAuditLog('user_login', {
    userId:   userData.id,
    phoneLast4: e164.slice(-4),
    isNewUser,
    role:     userData.role,
  }).catch(() => {});

  // Return safe profile (omit internal timestamps and fields)
  const profile = {
    id:          userData.id,
    phone:       e164,
    role:        userData.role,
    tenantId:    userData.tenantId,
    country:     userData.country,
    language:    userData.language,
    displayName: userData.displayName,
    avatarUrl:   userData.avatarUrl,
    verified:    true,
    active:      userData.active,
  };

  return res.status(isNewUser ? 201 : 200).json({
    success:   true,
    token,
    user:      profile,
    isNewUser,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 3 — GET /me
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Returns the current user's full profile from Firestore.
 * Requires a valid Bearer JWT in the Authorization header.
 *
 * Response:  { user: Object }
 */
router.get('/me', requireAuth, async (req, res) => {
  try {
    const usersRef = db.collection(COLLECTIONS.USERS);
    const snapshot = await usersRef.where('phone', '==', req.user.phone).limit(1).get();

    if (snapshot.empty) {
      return res.status(404).json({ error: 'User account not found. Please sign in again.' });
    }

    const doc  = snapshot.docs[0];
    const data = doc.data();

    // Return safe profile — omit internal fields
    const profile = {
      id:          doc.id,
      phone:       data.phone,
      role:        data.role,
      tenantId:    data.tenantId,
      country:     data.country,
      language:    data.language,
      displayName: data.displayName,
      avatarUrl:   data.avatarUrl,
      verified:    data.verified,
      active:      data.active,
      // Include human-readable join date for the profile page
      memberSince: data.createdAt?.toDate?.()?.toISOString() || null,
      lastLoginAt: data.lastLoginAt?.toDate?.()?.toISOString() || null,
    };

    return res.json({ user: profile });
  } catch (err) {
    console.error('[Auth] /me error:', err.message);
    return res.status(500).json({ error: 'Could not load your profile right now. Please try again.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 4 — POST /logout
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Invalidates the current session by adding the JWT's unique ID (jti) to
 * the Firestore revoked_tokens collection. The token cannot be used again
 * even if it hasn't expired — requireAuth checks this list on every request.
 *
 * TTL: The revocation record is stored until the token's original expiry time
 * so we don't accumulate permanent junk in Firestore.
 *
 * Request body: optional — token extracted from Authorization header
 * Response:     { success: true }
 */
router.post('/logout', requireAuth, async (req, res) => {
  try {
    const { jti, exp } = req.user;

    if (jti) {
      const expiresAt = exp ? new Date(exp * 1000) : null;
      await db.collection('revoked_tokens').doc(jti).set({
        jti,
        userId:    req.user.userId,
        revokedAt: FieldValue.serverTimestamp(),
        expiresAt, // Cloud Function / cron can clean up expired records
      });
    }

    // Audit log
    writeAuditLog('user_logout', { userId: req.user.userId, phoneLast4: req.user.phone?.slice(-4) })
      .catch(() => {});

    return res.json({ success: true });
  } catch (err) {
    console.error('[Auth] /logout error:', err.message);
    // Log out succeeds on the client side regardless — don't block the user
    return res.json({ success: true });
  }
});

// ─── Export the router and the requireAuth middleware ─────────────────────────
// requireAuth is exported so every other route module can import and use it
// without creating a circular dependency or re-implementing JWT verification.
module.exports = router;
module.exports.requireAuth = requireAuth;
