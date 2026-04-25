'use strict';
const { createClient } = require('@supabase/supabase-js');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in Vercel environment variables.');
}

module.exports = createClient(
  process.env.SUPABASE_URL.trim(),
  process.env.SUPABASE_SERVICE_KEY.trim(),
  { auth: { autoRefreshToken: false, persistSession: false } }
);
