'use strict';

const admin = require('firebase-admin');

// ─── Guard: fail fast with a clear message if credentials are missing ──────────
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error('[Firebase] FATAL: FIREBASE_SERVICE_ACCOUNT environment variable is not set.');
  console.error('[Firebase] Go to Firebase Console → Project Settings → Service Accounts');
  console.error('[Firebase] → Generate new private key → copy the JSON → paste into Replit Secrets');
  console.error('[Firebase] The entire key JSON should be stored as a single-line string in the secret.');
  process.exit(1);
}

if (!process.env.FIREBASE_STORAGE_BUCKET) {
  console.error('[Firebase] FATAL: FIREBASE_STORAGE_BUCKET environment variable is not set.');
  console.error('[Firebase] Format: your-project-id.appspot.com');
  process.exit(1);
}

// ─── Parse service account credentials ────────────────────────────────────────
let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch (err) {
  console.error('[Firebase] FATAL: FIREBASE_SERVICE_ACCOUNT is not valid JSON.');
  console.error('[Firebase] Ensure the entire service account key JSON is stored as a single string.');
  console.error('[Firebase] Parse error:', err.message);
  process.exit(1);
}

// ─── Initialise Firebase Admin SDK (only once) ────────────────────────────────
// Calling initializeApp() twice throws. This guard makes the module safe to
// require from multiple files without duplicating the initialisation.
if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    });
    console.log('[Firebase] Admin SDK initialised successfully.');
    console.log(`[Firebase] Project ID : ${serviceAccount.project_id}`);
    console.log(`[Firebase] Storage    : ${process.env.FIREBASE_STORAGE_BUCKET}`);
  } catch (err) {
    console.error('[Firebase] FATAL: Failed to initialise Admin SDK:', err.message);
    process.exit(1);
  }
} else {
  console.log('[Firebase] Admin SDK already initialised — reusing existing app.');
}

// ─── Exported services ────────────────────────────────────────────────────────

/**
 * db — Firestore database instance.
 * Usage: const { db } = require('../services/firebase');
 *        const snap = await db.collection('needs').doc(id).get();
 */
const db = admin.firestore();

// Firestore settings: use timestamps as native Date objects everywhere
db.settings({ ignoreUndefinedProperties: true });

/**
 * auth — Firebase Authentication Admin instance.
 * Usage: const { auth } = require('../services/firebase');
 *        const user = await auth.verifyIdToken(idToken);
 */
const auth = admin.auth();

/**
 * bucket — Firebase Storage default bucket.
 * Usage: const { bucket } = require('../services/firebase');
 *        await bucket.upload(localFilePath, { destination: 'reports/report.pdf' });
 */
const bucket = admin.storage().bucket();

/**
 * FieldValue — Firestore server-side field transforms.
 * Usage: const { FieldValue } = require('../services/firebase');
 *        await db.collection('users').doc(id).update({ updatedAt: FieldValue.serverTimestamp() });
 */
const FieldValue = admin.firestore.FieldValue;

/**
 * Timestamp — Firestore Timestamp constructor.
 * Usage: const { Timestamp } = require('../services/firebase');
 *        const ts = Timestamp.fromDate(new Date());
 */
const Timestamp = admin.firestore.Timestamp;

// ─── Collection name constants ────────────────────────────────────────────────
// Centralised here so typos in collection names are caught in one place.
// All 12 collections from the spec are listed.
const COLLECTIONS = {
  USERS:          'users',
  NEEDS:          'needs',
  HELPERS:        'helpers',
  MATCHES:        'matches',
  REVIEWS:        'reviews',
  SMS_QUEUE:      'sms_queue',
  VOICE_MESSAGES: 'voice_messages',
  PAYMENTS:       'payments',
  TENANTS:        'tenants',
  AUDIT_LOG:      'audit_log',
  REPORTS:        'reports',
  NOTIFICATIONS:  'notifications',
};

// ─── Firestore helpers ────────────────────────────────────────────────────────

/**
 * Converts a Firestore DocumentSnapshot to a plain JS object,
 * including the document id field.
 * @param {FirebaseFirestore.DocumentSnapshot} snap
 * @returns {Object|null}
 */
function docToObject(snap) {
  if (!snap.exists) return null;
  return { id: snap.id, ...snap.data() };
}

/**
 * Converts a Firestore QuerySnapshot to an array of plain JS objects.
 * @param {FirebaseFirestore.QuerySnapshot} snap
 * @returns {Object[]}
 */
function queryToArray(snap) {
  return snap.docs.map(docToObject);
}

/**
 * Writes a structured entry to the audit_log collection.
 * Called from route handlers when admin actions occur.
 *
 * @param {Object} params
 * @param {string} params.action    — e.g. 'helper_approved', 'user_suspended'
 * @param {string} params.actorId   — UID of the user who performed the action
 * @param {string} params.targetId  — UID or document ID being acted upon
 * @param {Object} [params.meta]    — Additional context (IP, device, old/new values)
 * @param {string} [params.tenantId] — Tenant ID of the actor. Stored as a top-level
 *   field so admin users can query only their own tenant's audit entries using
 *   `.where('tenantId', '==', adminTenantId)`. Superadmins query without this filter
 *   and see all entries. Existing callers that omit this param receive null — those
 *   older entries only appear in superadmin views (backwards-compatible).
 */
async function writeAuditLog({ action, actorId, targetId, meta = {}, tenantId = null }) {
  try {
    await db.collection(COLLECTIONS.AUDIT_LOG).add({
      action,
      actorId,
      targetId,
      tenantId,   // top-level for efficient .where('tenantId', '==', ...) queries
      meta,
      timestamp: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    // Audit log failures must never crash the main request
    console.error('[Firebase] Audit log write failed:', err.message);
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
  db,
  auth,
  bucket,
  FieldValue,
  Timestamp,
  COLLECTIONS,
  docToObject,
  queryToArray,
  writeAuditLog,
};
