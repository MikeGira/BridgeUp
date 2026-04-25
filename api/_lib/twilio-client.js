'use strict';

const twilio = require('twilio');
if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
  throw Object.assign(new Error('Twilio credentials not configured.'), { status: 503 });
}
module.exports = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
