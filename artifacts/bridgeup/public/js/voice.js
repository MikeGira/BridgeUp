/* ─────────────────────────────────────────────────────────────────────────────
   BridgeUp — voice.js
   Web Speech API voice interface (recognition + synthesis + audio chime)
   Exposed as window.VoiceInterface — no import/export syntax.
   ───────────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  // ─── Supported language codes ─────────────────────────────────────────────
  // rw-RW has no dedicated TTS voice on most platforms — falls back to fr-FR.
  const SUPPORTED_LANGS = ['en-US', 'fr-FR', 'rw-RW', 'sw-KE', 'es-ES', 'ar-SA'];
  const LANG_FALLBACKS  = { 'rw-RW': 'fr-FR' };

  const DEFAULT_LANG = LANG_FALLBACKS[navigator.language] ||
                       (SUPPORTED_LANGS.includes(navigator.language)
                         ? navigator.language
                         : 'en-US');

  // ─── Error messages (human-readable, per spec) ────────────────────────────
  const ERROR_MESSAGES = {
    'not-allowed':    'Please allow microphone access to use voice input.',
    'no-speech':      'I did not hear anything — please try again.',
    'audio-capture':  'No microphone was found. Please check your device settings.',
    'network':        'A network error occurred during voice recognition. Please check your connection.',
    'aborted':        null,   // intentional abort — show nothing
    'service-not-allowed': 'Please allow microphone access to use voice input.',
    'bad-grammar':    'Voice recognition error — please try again.',
    'language-not-supported': 'Your selected language is not supported for voice input.',
    '_default':       'Voice recognition error — please try again.',
  };

  // ─── Safe localStorage wrapper ────────────────────────────────────────────
  // Safari Private Browsing throws SecurityError on any localStorage access.
  function lsGet(key, fallback) {
    try { return localStorage.getItem(key) || fallback; } catch (_) { return fallback; }
  }
  function lsSet(key, value) {
    try { localStorage.setItem(key, value); } catch (_) {}
  }

  // ─── State ────────────────────────────────────────────────────────────────
  let recognition     = null;
  let currentLang     = lsGet('bridgeup_language', DEFAULT_LANG);
  let isListening     = false;
  let hasSpeechResult = false;   // true when at least one final result was received
  let isSpeaking      = false;

  // ─── Safe DOM helpers ─────────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }

  function setVoiceBtnState(state) {
    const btn = $('voice-btn');
    if (!btn) return;
    btn.classList.remove('state-idle', 'state-listening', 'state-speaking');
    btn.classList.add('state-' + state);
    announceStatus(state === 'idle'      ? 'Tap to speak'
                 : state === 'listening' ? 'Listening…'
                 : 'Speaking…');
  }

  function showTranscript(text) {
    const el = $('voice-transcript');
    if (el) el.textContent = text || '';
  }

  function showError(msg) {
    const el = $('voice-error');
    if (!el) return;
    if (msg) {
      el.textContent = msg;
      el.hidden = false;
    } else {
      el.textContent = '';
      el.hidden = true;
    }
  }

  function clearError() { showError(null); }

  function announceStatus(msg) {
    const el = $('voice-status');
    if (el) el.textContent = msg;
  }

  // ─── HTTPS check ──────────────────────────────────────────────────────────
  // Speech API requires a secure context on all browsers except localhost.
  function checkHTTPS() {
    if (location.protocol === 'http:' && location.hostname !== 'localhost' &&
        location.hostname !== '127.0.0.1') {
      announceStatus('Voice features require HTTPS. Please use a secure connection.');
      console.warn('[VoiceInterface] Non-HTTPS context — Speech API may be blocked.');
    }
  }

  // ─── Audio chime (440 Hz sine, 150 ms) ───────────────────────────────────
  // Pure Web Audio API — no audio file required.
  function playListenChime() {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;

      const ctx  = new AudioContext();
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type      = 'sine';
      osc.frequency.setValueAtTime(440, ctx.currentTime);

      // Fade in quickly then fade out — avoids the audible click on cut-off
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.18, ctx.currentTime + 0.02);
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.15);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.15);

      // Release AudioContext after chime completes
      osc.onended = function () {
        try { ctx.close(); } catch (_) {}
      };
    } catch (err) {
      console.warn('[VoiceInterface] Audio chime error:', err.message);
    }
  }

  // ─── Best TTS voice selection ─────────────────────────────────────────────
  // Prefers local (on-device) voices; falls back to remote; falls back to any
  // voice matching the lang prefix (e.g. 'en' matches 'en-GB').
  function selectVoice(langCode) {
    const voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
    if (!voices.length) return null;

    // rw-RW has no dedicated voice — fall back to fr-FR for selection
    const target = LANG_FALLBACKS[langCode] || langCode;
    const prefix = target.split('-')[0];

    // 1. Exact match, local
    let voice = voices.find(v => v.lang === target && v.localService);
    if (voice) return voice;

    // 2. Exact match, any (remote OK)
    voice = voices.find(v => v.lang === target);
    if (voice) return voice;

    // 3. Language prefix match, local
    voice = voices.find(v => v.lang.startsWith(prefix) && v.localService);
    if (voice) return voice;

    // 4. Language prefix match, any
    voice = voices.find(v => v.lang.startsWith(prefix));
    if (voice) return voice;

    return null;  // let the browser choose its default
  }

  // ─── Text-to-speech ───────────────────────────────────────────────────────
  function speakResponse(text, langCode) {
    if (!window.speechSynthesis) return;
    if (!text || !text.trim()) return;

    try {
      // Cancel anything currently playing
      window.speechSynthesis.cancel();

      const utter   = new SpeechSynthesisUtterance(text);
      utter.lang    = langCode || currentLang;
      utter.rate    = 0.9;
      utter.pitch   = 1.0;

      // Voice selection may require voices to be loaded; try now and also
      // after voiceschanged fires (needed on Chrome where voices load async).
      function applyVoice() {
        const voice = selectVoice(utter.lang);
        if (voice) utter.voice = voice;
      }
      applyVoice();

      utter.onstart = function () {
        isSpeaking = true;
        setVoiceBtnState('speaking');
      };

      utter.onend = function () {
        isSpeaking = false;
        setVoiceBtnState('idle');
      };

      utter.onerror = function (e) {
        isSpeaking = false;
        setVoiceBtnState('idle');
        // 'interrupted' is expected when cancel() is called — not an error
        if (e.error !== 'interrupted' && e.error !== 'canceled') {
          console.warn('[VoiceInterface] TTS error:', e.error);
        }
      };

      window.speechSynthesis.speak(utter);
      isSpeaking = true;
      setVoiceBtnState('speaking');
    } catch (err) {
      isSpeaking = false;
      setVoiceBtnState('idle');
      console.error('[VoiceInterface] speakResponse error:', err.message);
    }
  }

  // ─── Language management ──────────────────────────────────────────────────
  function setLanguage(code) {
    if (!SUPPORTED_LANGS.includes(code)) {
      console.warn('[VoiceInterface] setLanguage: unsupported code', code);
      return;
    }
    currentLang = code;
    lsSet('bridgeup_language', code);
    if (recognition) {
      recognition.lang = code;
    }
  }

  // ─── Recognition setup ────────────────────────────────────────────────────
  function buildRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return null;

    let rec;
    try {
      rec = new SpeechRecognition();
    } catch (err) {
      console.error('[VoiceInterface] SpeechRecognition constructor failed:', err.message);
      return null;
    }

    rec.continuous      = false;
    rec.interimResults  = true;
    rec.maxAlternatives = 1;
    rec.lang            = currentLang;

    // ── onresult — stream interim transcript; capture final ────────────────
    rec.onresult = function (event) {
      let interimText = '';
      let finalText   = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          finalText   += result[0].transcript;
          hasSpeechResult = true;
        } else {
          interimText += result[0].transcript;
        }
      }

      showTranscript(finalText || interimText);

      if (finalText.trim()) {
        clearError();
        try {
          if (window.ChatInterface && typeof window.ChatInterface.submitVoiceMessage === 'function') {
            window.ChatInterface.submitVoiceMessage(finalText.trim());
          }
        } catch (err) {
          console.error('[VoiceInterface] ChatInterface.submitVoiceMessage error:', err.message);
        }
      }
    };

    // ── onspeechend — auto-stop when user stops speaking ───────────────────
    rec.onspeechend = function () {
      try { rec.stop(); } catch (_) {}
    };

    // ── onend — clean up state; handle Safari immediate-end edge case ───────
    rec.onend = function () {
      isListening = false;
      if (!isSpeaking) {
        setVoiceBtnState('idle');
      }

      // Safari iOS sometimes fires onend immediately with no results.
      // hasSpeechResult is only true when at least one final result came through.
      if (!hasSpeechResult && !isSpeaking) {
        showError('Please tap and speak again — I didn\'t catch that.');
      }
    };

    // ── onerror ────────────────────────────────────────────────────────────
    rec.onerror = function (event) {
      isListening = false;
      hasSpeechResult = false;

      const msg = ERROR_MESSAGES[event.error] !== undefined
        ? ERROR_MESSAGES[event.error]
        : ERROR_MESSAGES['_default'];

      if (msg) showError(msg);  // null = intentional abort, show nothing

      if (!isSpeaking) {
        setVoiceBtnState('idle');
      }
    };

    // ── onsoundstart / onsoundend — visual feedback only ───────────────────
    rec.onsoundstart = function () {
      clearError();
    };

    return rec;
  }

  // ─── Start / stop listening ───────────────────────────────────────────────
  function startListening() {
    if (isListening) return;
    if (!recognition) {
      showError(ERROR_MESSAGES['_default']);
      return;
    }

    // Cancel any TTS playing so the mic can hear the user
    if (window.speechSynthesis) {
      try { window.speechSynthesis.cancel(); } catch (_) {}
      isSpeaking = false;
    }

    clearError();
    showTranscript('');
    hasSpeechResult = false;

    try {
      recognition.lang = currentLang;
      recognition.start();
      isListening = true;
      playListenChime();
      setVoiceBtnState('listening');
    } catch (err) {
      isListening = false;
      setVoiceBtnState('idle');
      // 'InvalidStateError' fires if start() is called while already running
      if (err.name !== 'InvalidStateError') {
        showError(ERROR_MESSAGES['_default']);
        console.error('[VoiceInterface] recognition.start() error:', err.message);
      }
    }
  }

  function stopListening() {
    if (!isListening || !recognition) return;
    try {
      recognition.stop();
    } catch (err) {
      console.warn('[VoiceInterface] recognition.stop() error:', err.message);
    }
  }

  // ─── Fallback UI for browsers without Speech API ──────────────────────────
  function activateFallbackUI() {
    const btn      = $('voice-btn');
    const fallback = $('voice-fallback-input');

    if (btn) {
      btn.hidden           = true;
      btn.setAttribute('aria-hidden', 'true');
    }

    if (fallback) {
      fallback.hidden = false;
      fallback.setAttribute('aria-label', 'Type your message here (voice input is not supported in this browser)');

      fallback.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          const text = fallback.value.trim();
          if (!text) return;
          try {
            if (window.ChatInterface && typeof window.ChatInterface.submitVoiceMessage === 'function') {
              window.ChatInterface.submitVoiceMessage(text);
            }
          } catch (err) {
            console.error('[VoiceInterface] fallback submit error:', err.message);
          }
          fallback.value = '';
        }
      });
    }

    announceStatus('Voice input is not supported in this browser. Type your message instead.');
  }

  // ─── Accessibility setup ──────────────────────────────────────────────────
  function setupAccessibility() {
    const btn = $('voice-btn');
    if (btn) {
      if (!btn.getAttribute('aria-label')) {
        btn.setAttribute('aria-label', 'Tap to speak');
      }
    }

    // Ensure #voice-status is an aria-live polite region
    const status = $('voice-status');
    if (status) {
      status.setAttribute('aria-live', 'polite');
      status.setAttribute('aria-atomic', 'true');
    }

    // Ensure #voice-error is visible to screen readers
    const error = $('voice-error');
    if (error) {
      error.setAttribute('role', 'alert');
      error.setAttribute('aria-live', 'assertive');
      error.hidden = true;
    }
  }

  // ─── init ─────────────────────────────────────────────────────────────────
  function init() {
    checkHTTPS();
    setupAccessibility();

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      console.warn('[VoiceInterface] SpeechRecognition not supported — activating fallback UI.');
      activateFallbackUI();
      return;
    }

    recognition = buildRecognition();

    if (!recognition) {
      activateFallbackUI();
      return;
    }

    // Wire up the voice button
    const btn = $('voice-btn');
    if (btn) {
      btn.addEventListener('click', function () {
        if (isListening) {
          stopListening();
        } else {
          startListening();
        }
      });

      // Keyboard: Space / Enter activate the button (for assistive devices)
      btn.addEventListener('keydown', function (e) {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          btn.click();
        }
      });

      // Ensure the button is keyboard-focusable
      if (!btn.getAttribute('tabindex')) {
        btn.setAttribute('tabindex', '0');
      }

      setVoiceBtnState('idle');
    }

    // Pre-load TTS voices — Chrome populates the list asynchronously
    if (window.speechSynthesis && window.speechSynthesis.onvoiceschanged !== undefined) {
      window.speechSynthesis.onvoiceschanged = function () {
        // Voices are now available for selectVoice(); no action needed here.
      };
    }
  }

  // ─── Public API ───────────────────────────────────────────────────────────
  window.VoiceInterface = {
    init:          init,
    startListening: startListening,
    stopListening:  stopListening,
    speakResponse:  speakResponse,
    setLanguage:    setLanguage,
    isListening:    function () { return isListening; },
    isSpeaking:     function () { return isSpeaking; },
    getCurrentLang: function () { return currentLang; },
  };

}());
