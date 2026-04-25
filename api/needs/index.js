'use strict';
const { handler }      = require('../_lib/cors');
const { requireAuth, optionalAuth }  = require('../_lib/auth');
const supabase         = require('../_lib/supabase');
const { normalizePhone } = require('../_lib/phone');
const { log }          = require('../_lib/audit');

const CATEGORIES = ['food','housing','employment','medical','training','funding','other'];
const URGENCIES  = ['immediate','days','weeks'];

module.exports = handler(async (req, res) => {
  if (req.method === 'GET') {
    const claims = await requireAuth(req);
    const { status, category, limit = 50, cursor } = req.query;

    let q = supabase.from('needs').select('*').order('created_at', { ascending: false }).limit(Math.min(Number(limit), 200));
    if (status)   q = q.eq('status', status);
    if (category) q = q.eq('category', category);
    if (cursor)   q = q.lt('created_at', cursor);
    if (!['admin','superadmin','ngo'].includes(claims.role)) q = q.eq('user_id', claims.userId);

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: 'Could not load needs.' });
    return res.json({ needs: data || [], nextCursor: data?.at(-1)?.created_at });
  }

  if (req.method === 'POST') {
    const claims = await optionalAuth(req);
    const { category, description, location, locationLat, locationLng, urgency, phone: rawPhone } = req.body || {};

    if (!category || !CATEGORIES.includes(category)) return res.status(400).json({ error: 'Invalid category.' });
    if (!description || description.length < 5) return res.status(400).json({ error: 'Description too short (min 5 chars).' });
    if (!urgency || !URGENCIES.includes(urgency)) return res.status(400).json({ error: 'Invalid urgency.' });

    let phone = null;
    if (rawPhone) {
      const { e164, error: pe } = normalizePhone(rawPhone);
      if (pe) return res.status(400).json({ error: pe });
      phone = e164;
    }

    const { data, error } = await supabase.from('needs').insert({
      user_id: claims?.userId || null, tenant_id: claims?.tenantId || null,
      phone, category, description: description.slice(0, 2000), location: location?.slice(0, 255) || null,
      location_lat: locationLat || null, location_lng: locationLng || null,
      urgency, status: 'pending_match', channel: 'web', language: 'en',
    }).select().single();

    if (error) return res.status(500).json({ error: 'Could not submit need.' });
    log({ action: 'need_created', actorId: claims?.userId, targetId: data.id, meta: { category, urgency } }).catch(() => {});
    return res.status(201).json({ success: true, needId: data.id, need: data });
  }

  res.status(405).json({ error: 'Method not allowed' });
});
