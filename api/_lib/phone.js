'use strict';

function normalizePhone(raw) {
  if (!raw || typeof raw !== 'string') return { e164: null, error: 'Phone number is required.' };
  let cleaned = raw.replace(/[\s\-.()]/g, '');
  if (cleaned.startsWith('00')) cleaned = '+' + cleaned.slice(2);
  if (!cleaned.startsWith('+')) {
    if (/^[1-9]\d{6,14}$/.test(cleaned)) cleaned = '+' + cleaned;
    else if (cleaned.startsWith('0')) return { e164: null, error: 'Include your country code (e.g. +250 for Rwanda, +1 for Canada).' };
    else return { e164: null, error: 'Phone number not recognised. Use format: +250788123456' };
  }
  if (!/^\+[1-9]\d{6,14}$/.test(cleaned)) return { e164: null, error: 'Invalid phone number format.' };
  return { e164: cleaned, error: null };
}

function countryFromPhone(phone) {
  const map = {
    '+250': 'RW', '+254': 'KE', '+255': 'TZ', '+256': 'UG',
    '+234': 'NG', '+233': 'GH', '+237': 'CM', '+221': 'SN',
    '+27':  'ZA', '+251': 'ET', '+212': 'MA', '+20':  'EG',
    '+1':   'CA', '+44':  'GB', '+33':  'FR', '+49':  'DE',
  };
  for (const [prefix, code] of Object.entries(map)) {
    if (phone.startsWith(prefix)) return code;
  }
  return 'US';
}

module.exports = { normalizePhone, countryFromPhone };
