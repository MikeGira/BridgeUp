'use strict';
const { handler }           = require('../_lib/cors');
const { normalizePhone, countryFromPhone } = require('../_lib/phone');
const { checkRateLimit, sendOTP }          = require('../_lib/otp');
const { log }               = require('../_lib/audit');

module.exports = handler(async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { phone: rawPhone } = req.body || {};
  const { e164, error: phoneError } = normalizePhone(rawPhone);
  if (phoneError) return res.status(400).json({ error: phoneError });

  const rate = await checkRateLimit(e164).catch(() => ({ allowed: true, attemptsLeft: 1 }));
  if (!rate.allowed) {
    const mins = rate.resetAt ? Math.ceil((rate.resetAt - Date.now()) / 60000) : 60;
    return res.status(429).json({ error: `Too many codes requested. Wait ${mins} minute${mins === 1 ? '' : 's'}.` });
  }

  try {
    const country = countryFromPhone(e164);
    await sendOTP(e164, country);
  } catch (err) {
    console.error('[send-otp] SMS failed for ***' + e164.slice(-4) + ':', err.message);
    return res.status(502).json({ error: 'Could not send verification code. Please try again.' });
  }

  log({ action: 'otp_sent', meta: { phoneLast4: e164.slice(-4) } }).catch(() => {});
  res.json({ success: true, expiresInMinutes: 5, attemptsLeft: rate.attemptsLeft });
});
