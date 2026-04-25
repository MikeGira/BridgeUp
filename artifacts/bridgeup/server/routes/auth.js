'use strict';

const express = require('express');
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const { supabase, TABLES, writeAuditLog } = require('../services/supabase');
const { sendOTP, verifyOTP, countryCodeFromPhone } = require('../services/twilio');

const router = express.Router();

function getJwtSecret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw Object.assign(new Error('SESSION_SECRET is not set in Vercel environment variables.'), { status: 503 });
  return s;
}

const JWT_SECRET      = process.env.SESSION_SECRET || 'pending-vercel-env-var';
const JWT_EXPIRY      = '7d';
const OTP_SEND_MAX    = 3;
const OTP_SEND_WINDOW = 60 * 60 * 1000;

function normalizePhone(raw) {
  if (!raw || typeof raw !== 'string') return { e164: null, error: 'Phone number is required.' };
  let cleaned = raw.replace(/[\s\-.()]/g, '');
  if (cleaned.startsWith('00')) cleaned = '+' + cleaned.slice(2);
  if (!cleaned.startsWith('+')) {
    if (/^[1-9]\d{6,14}$/.test(cleaned)) {
      cleaned = '+' + cleaned;
    } else if (cleaned.startsWith('0')) {
      return { e164: null, error: 'Please include your country code (e.g. +250 for Rwanda, +1 for Canada/USA).' };
    } else {
      return { e164: null, error: 'Phone number format not recognised. Use E.164, e.g. +250788123456.' };
    }
  }
  if (!/^\+[1-9]\d{6,14}$/.test(cleaned)) {
    return { e164: null, error: 'Phone number must be in international format (e.g. +250788123456).' };
  }
  return { e164: cleaned, error: null };
}

function signToken(payload) {
  return jwt.sign(
    { jti: crypto.randomUUID(), userId: payload.userId, phone: payload.phone, role: payload.role, tenantId: payload.tenantId || null },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY, issuer: 'bridgeup', audience: 'bridgeup-app' }
  );
}

function verifyToken(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    const err = new Error('Authorization header missing or malformed.');
    err.status = 401;
    throw err;
  }
  try {
    return jwt.verify(authHeader.slice(7), JWT_SECRET, { issuer: 'bridgeup', audience: 'bridgeup-app' });
  } catch (jwtErr) {
    const err = new Error(jwtErr.name === 'TokenExpiredError' ? 'Your session has expired. Please sign in again.' : 'Invalid token. Please sign in again.');
    err.status = 401;
    throw err;
  }
}

async function requireAuth(req, res, next) {
  try {
    const decoded = verifyToken(req.headers.authorization);
    if (decoded.jti) {
      const { data } = await supabase.from(TABLES.REVOKED_TOKENS).select('jti').eq('jti', decoded.jti).maybeSingle();
      if (data) return res.status(401).json({ error: 'Session invalidated. Please sign in again.' });
    }
    req.user = decoded;
    next();
  } catch (err) {
    res.status(err.status || 401).json({ error: 'Authentication required. Please sign in.' });
  }
}

async function checkOTPSendRateLimit(phone) {
  const now = Date.now();
  const { data } = await supabase.from(TABLES.OTP_RATE_LIMIT).select('*').eq('phone', phone).maybeSingle();
  if (!data || (now - data.window_start) >= OTP_SEND_WINDOW) {
    await supabase.from(TABLES.OTP_RATE_LIMIT).upsert({ phone, count: 1, window_start: now, updated_at: new Date().toISOString() });
    return { allowed: true, attemptsLeft: OTP_SEND_MAX - 1, resetAt: null };
  }
  if (data.count >= OTP_SEND_MAX) {
    return { allowed: false, attemptsLeft: 0, resetAt: new Date(data.window_start + OTP_SEND_WINDOW) };
  }
  await supabase.from(TABLES.OTP_RATE_LIMIT).update({ count: data.count + 1, updated_at: new Date().toISOString() }).eq('phone', phone);
  return { allowed: true, attemptsLeft: OTP_SEND_MAX - (data.count + 1), resetAt: null };
}

async function findOrCreateUser(phone) {
  const { data: existing } = await supabase.from(TABLES.USERS).select('*').eq('phone', phone).maybeSingle();
  if (existing) {
    await supabase.from(TABLES.USERS).update({ last_login_at: new Date().toISOString() }).eq('id', existing.id);
    return { user: existing, isNew: false };
  }
  const country = countryCodeFromPhone(phone);
  const { data: created, error } = await supabase.from(TABLES.USERS).insert({
    phone, role: 'user', tenant_id: null, country, language: 'en', active: true, verified: true,
  }).select().single();
  if (error) throw new Error('Failed to create user: ' + error.message);
  return { user: created, isNew: true };
}

router.post('/send-otp', async (req, res) => {
  const { phone: rawPhone } = req.body;
  const { e164, error: phoneError } = normalizePhone(rawPhone);
  if (phoneError) return res.status(400).json({ error: phoneError });
  const rateCheck = await checkOTPSendRateLimit(e164).catch(() => ({ allowed: true, attemptsLeft: 1 }));
  if (!rateCheck.allowed) {
    const mins = rateCheck.resetAt ? Math.ceil((rateCheck.resetAt.getTime() - Date.now()) / 60000) : 60;
    return res.status(429).json({ error: `Too many codes requested. Please wait ${mins} minute${mins === 1 ? '' : 's'}.` });
  }
  try {
    await sendOTP(e164);
  } catch (err) {
    console.error(`[Auth] sendOTP failed for ***${e164.slice(-4)}:`, err.message);
    return res.status(502).json({ error: 'Could not send verification code right now. Please try again.' });
  }
  writeAuditLog({ action: 'otp_sent', meta: { phoneLast4: e164.slice(-4) } }).catch(() => {});
  return res.json({ success: true, expiresInMinutes: 5, attemptsLeft: rateCheck.attemptsLeft });
});

router.post('/verify-otp', async (req, res) => {
  const { phone: rawPhone, code } = req.body;
  if (!code || !String(code).trim()) return res.status(400).json({ error: 'Verification code is required.' });
  const { e164, error: phoneError } = normalizePhone(rawPhone);
  if (phoneError) return res.status(400).json({ error: phoneError });
  const cleanCode = String(code).replace(/\s/g, '');
  if (!/^\d{4,8}$/.test(cleanCode)) return res.status(400).json({ error: 'Verification code must be 4-8 digits.' });
  let verification;
  try {
    verification = await verifyOTP(e164, cleanCode);
  } catch (err) {
    console.error(`[Auth] verifyOTP error for ***${e164.slice(-4)}:`, err.message);
    return res.status(500).json({ error: 'Something went wrong verifying your code. Please try again.' });
  }
  if (!verification.valid) return res.status(401).json({ error: verification.reason });
  let userData, isNewUser;
  try {
    const result = await findOrCreateUser(e164);
    userData = result.user;
    isNewUser = result.isNew;
  } catch (err) {
    console.error(`[Auth] findOrCreateUser error for ***${e164.slice(-4)}:`, err.message);
    return res.status(500).json({ error: 'Code verified but could not load account. Please try again.' });
  }
  const token = signToken({ userId: userData.id, phone: e164, role: userData.role, tenantId: userData.tenant_id });
  writeAuditLog({ action: 'user_login', actorId: userData.id, meta: { phoneLast4: e164.slice(-4), isNewUser, role: userData.role } }).catch(() => {});
  return res.status(isNewUser ? 201 : 200).json({
    success: true, token, isNewUser,
    user: { id: userData.id, phone: e164, role: userData.role, tenantId: userData.tenant_id, country: userData.country, language: userData.language, displayName: userData.display_name, avatarUrl: userData.avatar_url, verified: true, active: userData.active },
  });
});

router.get('/me', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from(TABLES.USERS).select('*').eq('phone', req.user.phone).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'User not found. Please sign in again.' });
    return res.json({ user: { id: data.id, phone: data.phone, role: data.role, tenantId: data.tenant_id, country: data.country, language: data.language, displayName: data.display_name, avatarUrl: data.avatar_url, bio: data.bio, verified: data.verified, active: data.active, memberSince: data.created_at, lastLoginAt: data.last_login_at } });
  } catch (err) {
    console.error('[Auth] /me error:', err.message);
    return res.status(500).json({ error: 'Could not load your profile right now.' });
  }
});

router.patch('/me', requireAuth, async (req, res) => {
  const allowed = ['display_name', 'language', 'bio', 'avatar_url'];
  const updates = {};
  for (const key of allowed) { if (req.body[key] !== undefined) updates[key] = req.body[key]; }
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields to update.' });
  if (updates.display_name && updates.display_name.length > 100) return res.status(400).json({ error: 'Display name max 100 chars.' });
  if (updates.bio && updates.bio.length > 500) return res.status(400).json({ error: 'Bio max 500 chars.' });
  const { data, error } = await supabase.from(TABLES.USERS).update(updates).eq('id', req.user.userId).select().single();
  if (error) return res.status(500).json({ error: 'Could not update profile.' });
  return res.json({ success: true, user: data });
});

router.post('/logout', requireAuth, async (req, res) => {
  try {
    const { jti, exp } = req.user;
    if (jti) {
      await supabase.from(TABLES.REVOKED_TOKENS).insert({ jti, user_id: req.user.userId, revoked_at: new Date().toISOString(), expires_at: exp ? new Date(exp * 1000).toISOString() : null });
    }
    writeAuditLog({ action: 'user_logout', actorId: req.user.userId }).catch(() => {});
  } catch { /* logout always succeeds on client */ }
  return res.json({ success: true });
});

module.exports = router;
module.exports.requireAuth = requireAuth;
