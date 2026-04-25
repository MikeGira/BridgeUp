'use strict';

// Vercel serverless entrypoint.
// dotenv is a no-op in production (no .env file) — env vars come from Vercel dashboard.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

let app;
try {
  app = require('../artifacts/bridgeup/server/index.js');
} catch (err) {
  // If the Express app fails to load (e.g. syntax error, bad require),
  // return a JSON error instead of Vercel's raw HTML crash page.
  console.error('[BridgeUp] STARTUP ERROR:', err.message, err.stack);
  app = (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.status(500).json({
      error: 'Server failed to start',
      detail: err.message,
      type:   err.constructor.name,
    });
  };
}

module.exports = app;
