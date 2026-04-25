'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

// Lazy-load the Express app on first request (not at module load time).
// This matches the pattern that works in api/debug.js and avoids a crash
// during Vercel's cold-start module evaluation phase.
let _app = null;

function getApp() {
  if (_app) return _app;
  _app = require('../artifacts/bridgeup/server/index.js');
  return _app;
}

module.exports = (req, res) => {
  let app;
  try {
    app = getApp();
  } catch (err) {
    console.error('[BridgeUp] Express app failed to load:', err.message, err.stack);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(500).end(JSON.stringify({
      error:  'Server startup failed',
      detail: err.message,
      type:   err.constructor?.name,
    }));
  }

  app(req, res);
};
