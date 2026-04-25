'use strict';
const { handler }           = require('../_lib/cors');
const { normalizePhone, countryFromPhone } = require('../_lib/phone');
const { verifyOTP }         = require('../_lib/otp');
const { signToken }         = require('../_lib/auth');
const { log }               = require('../_lib/audit');
const supabase              = require('../_lib/supabase');

async function findOrCreate(phone) {
  const { data: existing } = await supabase.from('users').select('*').eq('phone', phone).maybeSingle();
  if (existing) {
    await supabase.from('users').update({ last_login_at: new Date().toISOString() }).eq('id', existing.id);
    return { user: existing, isNew: false };
  }
  const { data: created, error } = await supabase.from('users').insert({
    phone, role: 'user', country: countryFromPhone(phone), language: 'en', active: true, verified: true,
  }).select().single();
  if (error) throw new Error('Failed to create account: ' + error.message);
  return { user: created, isNew: true };
}

module.exports = handler(async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { phone: rawPhone, code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'Verification code is required.' });

  const { e164, error: phoneError } = normalizePhone(rawPhone);
  if (phoneError) return res.status(400).json({ error: phoneError });

  const cleanCode = String(code).replace(/\s/g, '');
  if (!/^\d{4,8}$/.test(cleanCode)) return res.status(400).json({ error: 'Code must be 4–8 digits.' });

  const verification = await verifyOTP(e164, cleanCode);
  if (!verification.valid) return res.status(401).json({ error: verification.reason });

  const { user, isNew } = await findOrCreate(e164);
  const token = signToken({ userId: user.id, phone: e164, role: user.role, tenantId: user.tenant_id || null });

  log({ action: 'user_login', actorId: user.id, meta: { phoneLast4: e164.slice(-4), isNew, role: user.role } }).catch(() => {});

  res.status(isNew ? 201 : 200).json({
    success: true, token, isNew,
    user: { id: user.id, phone: e164, role: user.role, tenantId: user.tenant_id, country: user.country,
            language: user.language, displayName: user.display_name, avatarUrl: user.avatar_url, verified: true, active: user.active },
  });
});
