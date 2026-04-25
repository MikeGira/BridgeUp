'use strict';

const { randomInt } = require('crypto');
const supabase = require('./supabase');

const OTP_TTL_MS   = 5 * 60 * 1000;
const OTP_MAX_TRIES = 3;
const RATE_WINDOW   = 60 * 60 * 1000;
const RATE_MAX      = 3;

async function checkRateLimit(phone) {
  const now = Date.now();
  const { data } = await supabase.from('otp_rate_limit').select('*').eq('phone', phone).maybeSingle();
  if (!data || (now - data.window_start) >= RATE_WINDOW) {
    await supabase.from('otp_rate_limit').upsert({ phone, count: 1, window_start: now, updated_at: new Date().toISOString() });
    return { allowed: true, attemptsLeft: RATE_MAX - 1, resetAt: null };
  }
  if (data.count >= RATE_MAX) return { allowed: false, attemptsLeft: 0, resetAt: new Date(data.window_start + RATE_WINDOW) };
  await supabase.from('otp_rate_limit').update({ count: data.count + 1, updated_at: new Date().toISOString() }).eq('phone', phone);
  return { allowed: true, attemptsLeft: RATE_MAX - (data.count + 1), resetAt: null };
}

async function sendOTP(phone, countryCode) {
  const code = String(randomInt(100000, 999999));
  const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();

  await supabase.from('otp_codes').upsert({
    phone, code, expires_at: expiresAt, attempts: 0, verified: false, created_at: new Date().toISOString(),
  });

  const client = require('./twilio-client');
  const messages = {
    RW: `Kode yanyu ya BridgeUp ni: ${code}. Igihe irinda: iminota 5.`,
    KE: `Nambari yako ya BridgeUp: ${code}. Inaisha dakika 5.`,
    DEFAULT: `Your BridgeUp verification code is ${code}. Expires in 5 min. Do not share.`,
  };
  const body = messages[countryCode] || messages.DEFAULT;
  await client.messages.create({ to: phone, from: pickNumber(phone), body });

  return expiresAt;
}

function pickNumber(phone) {
  if (phone.startsWith('+250') && process.env.TWILIO_RWANDA_NUMBER) return process.env.TWILIO_RWANDA_NUMBER;
  if (phone.startsWith('+254') && process.env.TWILIO_KENYA_NUMBER)  return process.env.TWILIO_KENYA_NUMBER;
  if (phone.startsWith('+1')   && process.env.TWILIO_CANADA_NUMBER) return process.env.TWILIO_CANADA_NUMBER;
  return process.env.TWILIO_PHONE_NUMBER;
}

async function verifyOTP(phone, code) {
  const { data } = await supabase.from('otp_codes').select('*').eq('phone', phone).maybeSingle();
  if (!data)          return { valid: false, reason: 'No code found for this number. Please request a new one.' };
  if (data.verified)  return { valid: false, reason: 'Code already used. Please request a new one.' };
  if (data.attempts >= OTP_MAX_TRIES) return { valid: false, reason: 'Too many attempts. Please request a new code.' };

  const expires = new Date(data.expires_at);
  if (new Date() > expires) return { valid: false, reason: 'Code expired. Please request a new one.' };

  if (data.code !== String(code).trim()) {
    const remaining = OTP_MAX_TRIES - (data.attempts + 1);
    await supabase.from('otp_codes').update({ attempts: data.attempts + 1 }).eq('phone', phone);
    return { valid: false, reason: `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.` };
  }

  await supabase.from('otp_codes').update({ verified: true }).eq('phone', phone);
  return { valid: true };
}

module.exports = { checkRateLimit, sendOTP, verifyOTP };
