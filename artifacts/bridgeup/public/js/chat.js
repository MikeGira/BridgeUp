/* =============================================================
   BridgeUp — chat.js
   Claude AI chat intake interface (text + voice)
   Exposes: window.ChatInterface
   ============================================================= */
(function () {
  "use strict";

  // ── Constants ────────────────────────────────────────────────
  const MAX_MESSAGE_LEN = 1000;
  const MAX_HISTORY_TURNS = 10;
  const API_TIMEOUT_MS = 30000;
  const SESSION_KEY = "bridgeup_session_id";

  // ── State ────────────────────────────────────────────────────
  let conversationHistory = [];
  let sessionId = null;
  let isSubmitting = false;
  let intakeComplete = false;
  let currentNeedId = null;
  let detectedLanguage = "en";

  // ── Safe localStorage helpers ────────────────────────────────
  function lsGet(key, fallback) {
    try {
      return localStorage.getItem(key) || fallback;
    } catch (e) {
      return fallback;
    }
  }
  function lsSet(key, val) {
    try {
      localStorage.setItem(key, val);
    } catch (e) {
      /* Safari Private — ignore */
    }
  }

  // ── Sanitize text for DOM ────────────────────────────────────
  function sanitize(val) {
    if (val === null || val === undefined) return "";
    return String(val).slice(0, 2000);
  }

  // ── Generate a session ID ────────────────────────────────────
  function getOrCreateSession() {
    let id = lsGet(SESSION_KEY, null);
    if (!id) {
      id = "sess_" + Date.now() + "_" + Math.random().toString(36).slice(2, 9);
      lsSet(SESSION_KEY, id);
    }
    return id;
  }

  // ── Get auth token from localStorage ────────────────────────
  function getAuthToken() {
    return lsGet("bridgeup_token", null);
  }

  // ── Add a message bubble to the chat UI ─────────────────────
  function appendMessage(role, text) {
    const container = document.getElementById("chat-messages");
    if (!container) return;

    const bubble = document.createElement("div");
    bubble.className = role === "user" ? "chat-bubble user" : "chat-bubble ai";

    const content = document.createElement("div");
    content.className = "bubble-content";
    content.textContent = sanitize(text); // textContent — XSS safe

    bubble.appendChild(content);
    container.appendChild(bubble);

    // Scroll to bottom
    container.scrollTop = container.scrollHeight;
  }

  // ── Show typing indicator ────────────────────────────────────
  function showTyping() {
    const container = document.getElementById("chat-messages");
    if (!container) return;
    const existing = container.querySelector(".typing-indicator");
    if (existing) return;

    const typing = document.createElement("div");
    typing.className = "chat-bubble ai typing-indicator";
    typing.innerHTML =
      '<div class="bubble-content"><span></span><span></span><span></span></div>';
    container.appendChild(typing);
    container.scrollTop = container.scrollHeight;
  }

  // ── Remove typing indicator ──────────────────────────────────
  function hideTyping() {
    const indicator = document.querySelector(".typing-indicator");
    if (indicator) indicator.remove();
  }

  // ── Show error in chat ───────────────────────────────────────
  function showChatError(msg) {
    hideTyping();
    appendMessage("ai", msg);
  }

  // ── Set submit button state ──────────────────────────────────
  function setSubmitBusy(busy) {
    isSubmitting = busy;
    const btn = document.getElementById("chat-submit-btn");
    if (!btn) return;
    btn.disabled = busy;
    btn.textContent = busy ? "..." : "Send";
  }

  // ── Send message to Claude via server ───────────────────────
  async function sendMessage(userText) {
    if (isSubmitting) return;
    if (intakeComplete) return;

    const trimmed = userText.trim().slice(0, MAX_MESSAGE_LEN);
    if (!trimmed) return;

    // Show user bubble
    appendMessage("user", trimmed);

    // Add to history — cap history length
    conversationHistory.push({ role: "user", content: trimmed });
    if (conversationHistory.length > MAX_HISTORY_TURNS * 2) {
      conversationHistory = conversationHistory.slice(-MAX_HISTORY_TURNS * 2);
    }

    setSubmitBusy(true);
    showTyping();

    const token = getAuthToken();
    const headers = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

    let data;
    try {
      const resp = await fetch("/api/needs/intake/message", {
        method: "POST",
        headers: headers,
        body: JSON.stringify({
          sessionId: getOrCreateSession(),
          message: trimmed,
          history: conversationHistory.slice(-MAX_HISTORY_TURNS * 2),
          mode: "text",
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        throw new Error(errData.error || "Server error");
      }

      data = await resp.json();
    } catch (e) {
      clearTimeout(timeout);
      hideTyping();
      setSubmitBusy(false);

      if (e.name === "AbortError") {
        showChatError(
          "The request timed out. Please check your connection and try again.",
        );
      } else {
        showChatError("Something went wrong. Please try again.");
      }
      return;
    }

    hideTyping();

    const reply = sanitize(data.reply || "");
    if (reply) {
      appendMessage("ai", reply);
      conversationHistory.push({ role: "assistant", content: reply });

      // Speak response aloud if voice interface is active
      if (
        window.VoiceInterface &&
        window.VoiceInterface.isSpeaking !== undefined
      ) {
        const lang = lsGet("bridgeup_language", "en-US");
        window.VoiceInterface.speakResponse(reply, lang);
      }
    }

    // Check if intake is complete
    if (data.isComplete && data.needId) {
      intakeComplete = true;
      currentNeedId = sanitize(data.needId);
      detectedLanguage = sanitize(data.detectedLanguage || "en");
      onIntakeComplete(currentNeedId);
    }

    setSubmitBusy(false);
  }

  // ── Handle completed intake ──────────────────────────────────
  function onIntakeComplete(needId) {
    // Show success state in chat
    appendMessage(
      "ai",
      "We are finding the best helper for you nearby. Please wait a moment...",
    );

    // Disable further input
    const input = document.getElementById("chat-input");
    if (input) {
      input.disabled = true;
      input.placeholder = "Finding your match...";
    }
    setSubmitBusy(true);

    // Trigger matching via server
    const token = getAuthToken();
    const headers = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    fetch("/api/matching/trigger", {
      method: "POST",
      headers: headers,
      body: JSON.stringify({ needId: needId }),
    })
      .then((r) => r.json())
      .catch(() => null)
      .then(function (matchData) {
        if (matchData && matchData.match) {
          appendMessage(
            "ai",
            "Great news! We found a helper near you. Check the map to see their location.",
          );
          // Update map with matched helper
          if (window.MapInterface && matchData.match.helper) {
            window.MapInterface.addHelperMarker(matchData.match.helper);
          }
        } else {
          appendMessage(
            "ai",
            "We have recorded your need. We will notify you by SMS as soon as a helper is available in your area.",
          );
        }
      });
  }

  // ── Voice message entry point ────────────────────────────────
  function submitVoiceMessage(transcript) {
    if (!transcript || typeof transcript !== "string") return;
    const clean = transcript.trim().slice(0, MAX_MESSAGE_LEN);
    if (!clean) return;

    // Fill input field to show what was heard
    const input = document.getElementById("chat-input");
    if (input) input.value = clean;

    sendMessage(clean);
  }

  // ── Open / close chat panel ──────────────────────────────────
  function openChat() {
    const panel = document.getElementById("chat-panel");
    if (!panel) return;
    panel.classList.add("open");

    // Show welcome message on first open
    const container = document.getElementById("chat-messages");
    if (container && container.children.length === 0) {
      appendMessage(
        "ai",
        "Hello! I am here to help you find the support you need. What can I help you with today?",
      );
    }

    // Focus input
    const input = document.getElementById("chat-input");
    if (input) input.focus();
  }

  function closeChat() {
    const panel = document.getElementById("chat-panel");
    if (panel) panel.classList.remove("open");
  }

  // ── Reset chat for new need ──────────────────────────────────
  function reset() {
    conversationHistory = [];
    intakeComplete = false;
    currentNeedId = null;
    isSubmitting = false;
    sessionId = null;
    lsSet(SESSION_KEY, null);

    const container = document.getElementById("chat-messages");
    if (container) container.innerHTML = "";

    const input = document.getElementById("chat-input");
    if (input) {
      input.disabled = false;
      input.value = "";
      input.placeholder = "Type your need or tap the mic...";
    }
    setSubmitBusy(false);
  }

  // ── Initialise chat UI ───────────────────────────────────────
  function init() {
    sessionId = getOrCreateSession();

    // Submit button
    const submitBtn = document.getElementById("chat-submit-btn");
    if (submitBtn) {
      submitBtn.addEventListener("click", function () {
        const input = document.getElementById("chat-input");
        if (!input) return;
        sendMessage(input.value);
        input.value = "";
      });
    }

    // Enter key in input
    const input = document.getElementById("chat-input");
    if (input) {
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          sendMessage(input.value);
          input.value = "";
        }
      });
    }

    // Close button
    const closeBtn = document.getElementById("chat-close-btn");
    if (closeBtn) {
      closeBtn.addEventListener("click", closeChat);
    }

    // I Need Help button
    const needHelpBtn = document.getElementById("need-help-btn");
    if (needHelpBtn) {
      needHelpBtn.addEventListener("click", openChat);
    }
  }

  // ── Public API ───────────────────────────────────────────────
  window.ChatInterface = {
    init: init,
    openChat: openChat,
    closeChat: closeChat,
    sendMessage: sendMessage,
    submitVoiceMessage: submitVoiceMessage,
    reset: reset,
  };
})();
