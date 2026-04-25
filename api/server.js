'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

let appHandler = null;
let startupError = null;

// Catch unhandled rejections that happen during module loading
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  console.error('[BridgeUp] Unhandled rejection at startup:', err.message);
  if (!startupError) startupError = err;
});

try {
  appHandler = require('../artifacts/bridgeup/server/index.js');
  console.log('[BridgeUp] Server loaded successfully');
} catch (err) {
  console.error('[BridgeUp] STARTUP ERROR:', err.message, '\n', err.stack);
  startupError = err;
}

module.exports = (req, res) => {
  if (startupError || !appHandler) {
    const err = startupError || new Error('App not initialized');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(500).end(JSON.stringify({
      error:  'Server startup failed — check Vercel function logs',
      detail: err.message,
      type:   err.constructor?.name || 'Error',
    }));
  }
  return appHandler(req, res);
};
