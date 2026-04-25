'use strict';
const twilio = require('twilio');

let _client = null;

module.exports = {
  get messages() {
    if (!_client) {
      if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
        throw Object.assign(new Error('Twilio credentials not configured. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.'), { status: 503 });
      }
      _client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    }
    return _client.messages;
  },
};
