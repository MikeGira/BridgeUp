'use strict';

// Vercel serverless function entrypoint — wraps the Express app
// All requests to /api/*, /voice/*, /sms/*, /stripe/*, etc. are routed here
// by vercel.json rewrites.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

module.exports = require('../artifacts/bridgeup/server/index.js');
