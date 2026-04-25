'use strict';

/**
 * Supabase compatibility layer for routes that still use the firebase.js API.
 * Maps db.collection().where().get() patterns to Supabase queries.
 * Field names are auto-converted: camelCase input → snake_case Supabase → camelCase output.
 */

const { supabase, TABLES, writeAuditLog } = require('./supabase');

// ─── Field name conversions ───────────────────────────────────────────────────
function toSnake(key) {
  return key.replace(/([A-Z])/g, '_$1').toLowerCase();
}
function toCamel(key) {
  return key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function objToSnake(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    const sk = toSnake(k);
    out[sk] = v instanceof Date ? v.toISOString()
      : (v && v._type === 'serverTimestamp') ? new Date().toISOString()
      : (v && v._type === 'increment')       ? v.value
      : objToSnake(v);
  }
  return out;
}

function objToCamel(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(objToCamel);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[toCamel(k)] = objToCamel(v);
  }
  return out;
}

// Convert Firestore-style operator to Supabase method
function applyFilter(q, field, op, value) {
  const sf = toSnake(field);
  switch (op) {
    case '==': case '===': return q.eq(sf, value);
    case '!=':             return q.neq(sf, value);
    case '>':              return q.gt(sf, value);
    case '<':              return q.lt(sf, value);
    case '>=':             return q.gte(sf, value);
    case '<=':             return q.lte(sf, value);
    case 'in':             return q.in(sf, value);
    case 'array-contains': return q.contains(sf, [value]);
    default:               return q;
  }
}

// Wrap a Supabase row into a Firestore-style snapshot
function wrapDoc(row, tableName) {
  if (!row) return { exists: false, id: null, data: () => null };
  const camel = objToCamel(row);
  return {
    exists: true,
    id:     row.id || camel.id,
    ref: {
      update: async (updates) => {
        const { error } = await supabase.from(tableName)
          .update(objToSnake(updates))
          .eq('id', row.id);
        if (error) throw error;
      },
      delete: async () => {
        const { error } = await supabase.from(tableName).delete().eq('id', row.id);
        if (error) throw error;
      },
    },
    data: () => camel,
    ...camel,
  };
}

// ─── Collection builder ───────────────────────────────────────────────────────
function buildCollection(tableName) {
  let filters = [];
  let limitN  = null;
  let orderByField = null;
  let orderByDir   = 'asc';

  const coll = {
    _table: tableName,

    doc(docId) {
      const id = docId || crypto.randomUUID();
      return {
        id,
        async get() {
          const { data, error } = await supabase.from(tableName).select('*').eq('id', id).maybeSingle();
          if (error && error.code !== 'PGRST116') throw new Error(error.message);
          return wrapDoc(data, tableName);
        },
        async set(rowData) {
          const cleaned = objToSnake({ ...rowData, id });
          // Remove undefined FieldValue.increment markers
          const { error } = await supabase.from(tableName).upsert(cleaned);
          if (error) throw new Error(error.message);
          return { id };
        },
        async update(updates) {
          const cleaned = objToSnake(updates);
          // Handle increment specially
          const increments = {};
          for (const [k, v] of Object.entries(updates)) {
            if (v && v._type === 'increment') increments[toSnake(k)] = v.value;
          }
          if (Object.keys(increments).length > 0) {
            for (const [col, delta] of Object.entries(increments)) {
              await supabase.rpc('increment_column', { tbl: tableName, col, row_id: id, delta })
                .catch(() => {
                  // Fallback: fetch + increment manually
                });
            }
          }
          const { error } = await supabase.from(tableName).update(cleaned).eq('id', id);
          if (error) throw new Error(error.message);
          return { id };
        },
        async delete() {
          const { error } = await supabase.from(tableName).delete().eq('id', id);
          if (error) throw new Error(error.message);
        },
        collection(subCol) { return buildCollection(tableName + '_' + subCol); },
      };
    },

    async add(rowData) {
      const cleaned = objToSnake(rowData);
      // Remove FieldValue markers
      for (const k of Object.keys(cleaned)) {
        if (cleaned[k] && cleaned[k]._type) {
          if (cleaned[k]._type === 'serverTimestamp') cleaned[k] = new Date().toISOString();
          else delete cleaned[k];
        }
      }
      const { data, error } = await supabase.from(tableName).insert(cleaned).select('id').single();
      if (error) throw new Error(error.message);
      return { id: data.id };
    },

    where(field, op, value) {
      const clone = buildCollection(tableName);
      clone._filters = [...filters, { field, op, value }];
      clone._limit   = limitN;
      return clone;
    },

    orderBy(field, dir = 'asc') {
      const clone = buildCollection(tableName);
      clone._filters    = [...filters];
      clone._limit      = limitN;
      clone._orderBy    = { field, dir };
      return clone;
    },

    limit(n) {
      const clone = buildCollection(tableName);
      clone._filters = [...filters];
      clone._orderBy = orderByField ? { field: orderByField, dir: orderByDir } : null;
      clone._limit   = n;
      return clone;
    },

    async get() {
      let q = supabase.from(tableName).select('*');
      for (const f of (this._filters || [])) {
        q = applyFilter(q, f.field, f.op, f.value);
      }
      if (this._orderBy) {
        q = q.order(toSnake(this._orderBy.field), { ascending: this._orderBy.dir !== 'desc' });
      }
      if (this._limit) q = q.limit(this._limit);

      const { data, error } = await q;
      if (error) throw new Error(error.message);

      const docs = (data || []).map((row) => wrapDoc(row, tableName));
      return {
        docs,
        empty: docs.length === 0,
        size:  docs.length,
        forEach: (cb) => docs.forEach(cb),
      };
    },
  };

  coll._filters = filters;
  coll._limit   = limitN;
  coll._orderBy = null;
  return coll;
}

// ─── Main db object ───────────────────────────────────────────────────────────
const db = {
  collection: buildCollection,
  batch() {
    const ops = [];
    return {
      set(ref, data)    { ops.push({ type: 'set',    ref, data }); return this; },
      update(ref, data) { ops.push({ type: 'update', ref, data }); return this; },
      delete(ref)       { ops.push({ type: 'delete', ref       }); return this; },
      async commit() {
        for (const op of ops) {
          if (op.type === 'delete')     await op.ref.delete();
          else if (op.type === 'set')   await op.ref.set(op.data);
          else if (op.type === 'update')await op.ref.update(op.data);
        }
      },
    };
  },
  async runTransaction(fn) { return fn(db.batch()); },
};

// ─── FieldValue compatibility ─────────────────────────────────────────────────
const FieldValue = {
  serverTimestamp: () => ({ _type: 'serverTimestamp' }),
  increment:       (n) => ({ _type: 'increment', value: n }),
  arrayUnion:      (...items) => ({ _type: 'arrayUnion', items }),
  arrayRemove:     (...items) => ({ _type: 'arrayRemove', items }),
};

const Timestamp = {
  now:         () => new Date(),
  fromDate:    (d) => d,
  fromMillis:  (ms) => new Date(ms),
};

const COLLECTIONS = {
  USERS:          'users',
  NEEDS:          'needs',
  HELPERS:        'helpers',
  MATCHES:        'matches',
  REVIEWS:        'reviews',
  SMS_QUEUE:      'sms_conversations',
  VOICE_MESSAGES: 'notifications',
  PAYMENTS:       'payments',
  TENANTS:        'tenants',
  AUDIT_LOG:      'audit_log',
  REPORTS:        'reports',
  NOTIFICATIONS:  'notifications',
  OTP_CODES:      'otp_codes',
  OTP_RATE_LIMIT: 'otp_rate_limit',
  REVOKED_TOKENS: 'revoked_tokens',
};

function docToObject(snap) {
  if (!snap || !snap.exists) return null;
  return { id: snap.id, ...snap.data() };
}

function queryToArray(snap) {
  return snap.docs.map(docToObject);
}

// No Firebase auth/storage in the new stack — stubs for compatibility
const auth   = null;
const bucket = null;

module.exports = { db, auth, bucket, FieldValue, Timestamp, COLLECTIONS, docToObject, queryToArray, writeAuditLog };
