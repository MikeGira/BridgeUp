'use strict';

// Diagnostic: loads server modules one by one, returns status of each.
// Call /api/debug to see exactly which module is crashing.
module.exports = (req, res) => {
  const results = {};

  function tryLoad(name, fn) {
    try {
      fn();
      results[name] = 'ok';
    } catch (err) {
      results[name] = `ERROR: ${err.message}`;
    }
  }

  tryLoad('express',           () => require('express'));
  tryLoad('helmet',            () => require('helmet'));
  tryLoad('cors',              () => require('cors'));
  tryLoad('express-rate-limit',() => require('express-rate-limit'));
  tryLoad('dotenv',            () => require('dotenv'));
  tryLoad('@supabase/supabase-js', () => require('@supabase/supabase-js'));
  tryLoad('services/supabase', () => require('../artifacts/bridgeup/server/services/supabase'));
  tryLoad('services/claude',   () => require('../artifacts/bridgeup/server/services/claude'));
  tryLoad('services/twilio',   () => require('../artifacts/bridgeup/server/services/twilio'));
  tryLoad('services/firebase', () => require('../artifacts/bridgeup/server/services/firebase'));
  tryLoad('routes/auth',       () => require('../artifacts/bridgeup/server/routes/auth'));
  tryLoad('routes/needs',      () => require('../artifacts/bridgeup/server/routes/needs'));
  tryLoad('routes/helpers',    () => require('../artifacts/bridgeup/server/routes/helpers'));
  tryLoad('routes/matching',   () => require('../artifacts/bridgeup/server/routes/matching'));
  tryLoad('routes/payments',   () => require('../artifacts/bridgeup/server/routes/payments'));
  tryLoad('routes/admin',      () => require('../artifacts/bridgeup/server/routes/admin'));
  tryLoad('routes/reports',    () => require('../artifacts/bridgeup/server/routes/reports'));
  tryLoad('routes/sms',        () => require('../artifacts/bridgeup/server/routes/sms'));
  tryLoad('routes/voice',      () => require('../artifacts/bridgeup/server/routes/voice'));
  tryLoad('routes/reviews',    () => require('../artifacts/bridgeup/server/routes/reviews'));
  tryLoad('server/index',      () => require('../artifacts/bridgeup/server/index'));

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(JSON.stringify(results, null, 2));
};
