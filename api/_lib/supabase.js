'use strict';
const { createClient } = require('@supabase/supabase-js');

let _client = null;

function getClient() {
  if (_client) return _client;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    throw Object.assign(
      new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in Vercel Environment Variables.'),
      { status: 503 }
    );
  }
  _client = createClient(
    process.env.SUPABASE_URL.trim(),
    process.env.SUPABASE_SERVICE_KEY.trim(),
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
  return _client;
}

// Proxy: lazily initialises on first method call — never throws at module load time
module.exports = new Proxy({}, {
  get(_, prop) { return getClient()[prop]; },
});
