'use strict';

const admin = require('firebase-admin');

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error('[Firebase] FATAL: FIREBASE_SERVICE_ACCOUNT secret is not set.');
  process.exit(1);
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch (err) {
  console.error('[Firebase] FATAL: FIREBASE_SERVICE_ACCOUNT is not valid JSON:', err.message);
  process.exit(1);
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: serviceAccount.project_id,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  });
  console.log('[Firebase] Admin SDK initialised. Project:', serviceAccount.project_id);
}

const auth = admin.auth();
const bucket = process.env.FIREBASE_STORAGE_BUCKET ? admin.storage().bucket() : null;
const FieldValue = admin.firestore.FieldValue;
const Timestamp = admin.firestore.Timestamp;

// ─── Lightweight Firestore REST client ────────────────────────────────────────
// firebase-admin v13 + @google-cloud/firestore v7 has a routing bug on Replit.
// We bypass the SDK Firestore client entirely and call the REST API directly,
// which we confirmed returns HTTP 200 and full database details.

const https = require('https');
const PROJECT = serviceAccount.project_id;
const BASE = '/v1/projects/' + PROJECT + '/databases/default/documents';

async function getToken() {
  const token = await admin.app().options.credential.getAccessToken();
  return token.access_token;
}

function restRequest(method, path, body) {
  return new Promise(async (resolve, reject) => {
    const token = await getToken();
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'firestore.googleapis.com',
      path: BASE + path,
      method,
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        ...(bodyStr && { 'Content-Length': Buffer.byteLength(bodyStr) }),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            const err = new Error(parsed.error?.message || 'Firestore REST error');
            err.code = parsed.error?.code || res.statusCode;
            return reject(err);
          }
          resolve(parsed);
        } catch (e) {
          reject(new Error('Failed to parse Firestore response: ' + data));
        }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// Convert a Firestore REST document to a plain JS object
function fromFirestore(doc) {
  if (!doc || !doc.fields) return null;
  const obj = { id: doc.name.split('/').pop() };
  for (const [key, val] of Object.entries(doc.fields)) {
    obj[key] = fromValue(val);
  }
  return obj;
}

function fromValue(val) {
  if (val.stringValue !== undefined) return val.stringValue;
  if (val.integerValue !== undefined) return parseInt(val.integerValue);
  if (val.doubleValue !== undefined) return val.doubleValue;
  if (val.booleanValue !== undefined) return val.booleanValue;
  if (val.timestampValue !== undefined) return new Date(val.timestampValue);
  if (val.nullValue !== undefined) return null;
  if (val.arrayValue !== undefined) return (val.arrayValue.values || []).map(fromValue);
  if (val.mapValue !== undefined) {
    const obj = {};
    for (const [k, v] of Object.entries(val.mapValue.fields || {})) obj[k] = fromValue(v);
    return obj;
  }
  return null;
}

// Convert a plain JS object to Firestore REST fields
function toFirestore(obj) {
  const fields = {};
  for (const [key, val] of Object.entries(obj)) {
    if (val === undefined) continue;
    fields[key] = toValue(val);
  }
  return { fields };
}

function toValue(val) {
  if (val === null) return { nullValue: null };
  if (typeof val === 'string') return { stringValue: val };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'number') {
    return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
  }
  if (val instanceof Date) return { timestampValue: val.toISOString() };
  if (val && val._methodName === 'serverTimestamp') return { timestampValue: new Date().toISOString() };
  if (Array.isArray(val)) return { arrayValue: { values: val.map(toValue) } };
  if (typeof val === 'object') {
    const fields = {};
    for (const [k, v] of Object.entries(val)) { if (v !== undefined) fields[k] = toValue(v); }
    return { mapValue: { fields } };
  }
  return { nullValue: null };
}

// Generate a random document ID (same length as Firestore auto-IDs)
function autoId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 20; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

// db object with the same API surface your routes already use
const db = {
  collection(colName) {
    return {
      doc(docId) {
        const id = docId || autoId();
        return {
          id,
          async get() {
            try {
              const doc = await restRequest('GET', '/' + colName + '/' + id);
              return { exists: true, id, data: () => fromFirestore(doc), ...fromFirestore(doc) };
            } catch (e) {
              if (e.code === 404) return { exists: false, id, data: () => null };
              throw e;
            }
          },
          async set(data, opts) {
            const existing = opts && opts.merge;
            const method = existing ? 'PATCH' : 'PATCH';
            await restRequest(method, '/' + colName + '/' + id, toFirestore(data));
            return { id };
          },
          async update(data) {
            await restRequest('PATCH', '/' + colName + '/' + id, toFirestore(data));
            return { id };
          },
          async delete() {
            await restRequest('DELETE', '/' + colName + '/' + id);
            return {};
          },
          collection(subCol) { return db.collection(colName + '/' + id + '/' + subCol); },
        };
      },
      async add(data) {
        const id = autoId();
        await restRequest('PATCH', '/' + colName + '/' + id, toFirestore(data));
        return { id };
      },
      _filters: [],
      _limit: null,
      _orderBy: null,
      where(field, op, value) {
        const clone = db.collection(colName);
        clone._filters = [...(this._filters || []), { field, op, value }];
        clone._limit = this._limit;
        return clone;
      },
      orderBy(field, dir) {
        const clone = db.collection(colName);
        clone._filters = this._filters || [];
        clone._limit = this._limit;
        clone._orderBy = { field, dir };
        return clone;
      },
      limit(n) {
        const clone = db.collection(colName);
        clone._filters = this._filters || [];
        clone._orderBy = this._orderBy;
        clone._limit = n;
        return clone;
      },
      async get() {
        const res = await restRequest('GET', '/' + colName + '?pageSize=1000');
        const allDocs = (res.documents || []).map(d => {
          const id = d.name.split('/').pop();
          const data = fromFirestore(d);
          return {
            exists: true,
            id,
            ref: db.collection(colName).doc(id),
            data: () => data,
            ...data,
          };
        });
        // Apply where filters client-side
        let filtered = allDocs;
        for (const f of (this._filters || [])) {
          filtered = filtered.filter(doc => {
            const val = doc[f.field];
            if (f.op === '==' || f.op === '===') return val == f.value;
            if (f.op === '!=') return val != f.value;
            if (f.op === '>') return val > f.value;
            if (f.op === '<') return val < f.value;
            if (f.op === '>=') return val >= f.value;
            if (f.op === '<=') return val <= f.value;
            if (f.op === 'in') return Array.isArray(f.value) && f.value.includes(val);
            if (f.op === 'array-contains') return Array.isArray(val) && val.includes(f.value);
            return true;
          });
        }
        if (this._limit) filtered = filtered.slice(0, this._limit);
        return { docs: filtered, empty: filtered.length === 0, size: filtered.length };
      },
    };
  },
  batch() {
    const ops = [];
    return {
      set(ref, data) { ops.push({ ref, data, op: 'set' }); return this; },
      update(ref, data) { ops.push({ ref, data, op: 'update' }); return this; },
      delete(ref) { ops.push({ ref, op: 'delete' }); return this; },
      async commit() { for (const op of ops) { if (op.op === 'delete') await op.ref.delete(); else await op.ref.set(op.data); } },
    };
  },
  async runTransaction(fn) { return fn(db.batch()); },
};

const COLLECTIONS = {
  USERS: 'users', NEEDS: 'needs', HELPERS: 'helpers', MATCHES: 'matches',
  REVIEWS: 'reviews', SMS_QUEUE: 'sms_queue', VOICE_MESSAGES: 'voice_messages',
  PAYMENTS: 'payments', TENANTS: 'tenants', AUDIT_LOG: 'audit_log',
  REPORTS: 'reports', NOTIFICATIONS: 'notifications',
};

function docToObject(snap) {
  if (!snap.exists) return null;
  return { id: snap.id, ...snap.data() };
}

function queryToArray(snap) { return snap.docs.map(docToObject); }

async function writeAuditLog({ action, actorId, targetId, meta = {}, tenantId = null }) {
  try {
    await db.collection(COLLECTIONS.AUDIT_LOG).add({
      action, actorId, targetId, tenantId, meta,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[Firebase] Audit log write failed:', err.message);
  }
}

module.exports = { db, auth, bucket, FieldValue, Timestamp, COLLECTIONS, docToObject, queryToArray, writeAuditLog };
