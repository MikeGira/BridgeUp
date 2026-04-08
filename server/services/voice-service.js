require("dotenv").config();
const twilio = require("twilio");
const { processNeed } = require("./claude");

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN,
);

function getGreetingByCountryCode(phoneNumber) {
  if (phoneNumber.startsWith("+250")) {
    return {
      language: "Kinyarwanda",
      greeting: "Murakaza neza kuri BridgeUp. Vuga ikibazo cyawe.",
      voice: "Polly.Celine",
    };
  } else if (phoneNumber.startsWith("+254")) {
    return {
      language: "Swahili",
      greeting: "Karibu BridgeUp. Sema unahitaji nini.",
      voice: "Polly.Vitoria",
    };
  } else {
    return {
      language: "English",
      greeting:
        "Welcome to BridgeUp. Tell me what you need and we will find help for you.",
      voice: "Polly.Joanna",
    };
  }
}

function buildVoiceResponse(textToSpeak, voiceName, gatherAction) {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const response = new VoiceResponse();
  const gather = response.gather({
    input: "speech",
    action: gatherAction,
    method: "POST",
    speechTimeout: "auto",
    language: "en-US",
  });
  gather.say({ voice: voiceName }, textToSpeak);
  return response.toString();
}

module.exports = { getGreetingByCountryCode, buildVoiceResponse, client };
