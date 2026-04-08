require("dotenv").config();
const express = require("express");
const router = express.Router();
const twilio = require("twilio");
const {
  getGreetingByCountryCode,
  buildVoiceResponse,
} = require("../services/voice-service");
const { processNeed } = require("../services/claude");
const { db } = require("../services/firebase");

router.post("/answer", (req, res) => {
  const callerNumber = req.body.From || "+1000000000";
  const { greeting, voice, language } = getGreetingByCountryCode(callerNumber);
  const twiml = buildVoiceResponse(greeting, voice, "/voice/process");
  res.type("text/xml");
  res.send(twiml);
});

router.post("/process", async (req, res) => {
  const speechResult = req.body.SpeechResult || "";
  const callerNumber = req.body.From || "+1000000000";
  const { voice, language } = getGreetingByCountryCode(callerNumber);

  try {
    const conversationHistory = [{ role: "user", content: speechResult }];
    const aiResponse = await processNeed(
      speechResult,
      conversationHistory,
      "unknown location",
      language,
    );

    await db.collection("voice_messages").add({
      callerNumber,
      transcription: speechResult,
      claudeResponse: aiResponse,
      language,
      timestamp: new Date(),
      status: "processed",
    });

    const twiml = buildVoiceResponse(aiResponse, voice, "/voice/complete");
    res.type("text/xml");
    res.send(twiml);
  } catch (error) {
    console.error("Voice process error:", error);
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();
    response.say("We are sorry, there was a problem. Please try again later.");
    res.type("text/xml");
    res.send(response.toString());
  }
});

router.post("/complete", (req, res) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const response = new VoiceResponse();
  response.say(
    "Thank you for using BridgeUp. We will send you a text message with your match shortly. Goodbye.",
  );
  response.hangup();
  res.type("text/xml");
  res.send(response.toString());
});

module.exports = router;
