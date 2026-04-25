'use strict';

const jwt  = require('jsonwebtoken');
const supabase = require('./supabase');

function getSecret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw Object.assign(new Error('SESSION_SECRET not configured'), { status: 503 });
  return s;
}

// Verify Bearer JWT and check revocation list. Returns decoded claims.
async function requireAuth(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    throw Object.assign(new Error('Authorization required. Please sign in.'), { status: 401 });
  }
  const token = header.slice(7);
  let decoded;
  try {
    decoded = jwt.verify(token, getSecret(), { issuer: 'bridgeup', audience: 'bridgeup-app' });
  } catch (err) {
    const msg = err.name === 'TokenExpiredError'
      ? 'Your session has expired. Please sign in again.'
      : 'Invalid token. Please sign in again.';
    throw Object.assign(new Error(msg), { status: 401 });
  }

  if (decoded.jti) {
    const { data } = await supabase
      .from('revoked_tokens').select('jti').eq('jti', decoded.jti).maybeSingle();
    if (data) throw Object.assign(new Error('Session invalidated. Please sign in again.'), { status: 401 });
  }

  return decoded;
}

// Optional auth — returns null if no token instead of throwing
async function optionalAuth(req) {
  if (!req.headers.authorization) return null;
  try { return await requireAuth(req); } catch { return null; }
}

function signToken(payload) {
  const { randomUUID } = require('crypto');
  return jwt.sign(
    { jti: randomUUID(), ...payload },
    getSecret(),
    { expiresIn: '7d', issuer: 'bridgeup', audience: 'bridgeup-app' }
  );
}

module.exports = { requireAuth, optionalAuth, signToken };
