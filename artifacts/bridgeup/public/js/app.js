/* =============================================================
   BridgeUp — app.js
   Main application coordinator
   Initialises all modules and handles navigation
   ============================================================= */
(function () {
  "use strict";

  // ── Constants ────────────────────────────────────────────────
  const TOKEN_KEY = "bridgeup_token";
  const USER_KEY = "bridgeup_user";
  const LANG_KEY = "bridgeup_language";
  const OTP_TIMEOUT = 300000; // 5 minutes

  // ── State ────────────────────────────────────────────────────
  let currentUser = null;
  let currentTab = "map";
  let otpPhone = null;
  let otpTimer = null;

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
  function lsRemove(key) {
    try {
      localStorage.removeItem(key);
    } catch (e) {
      /* ignore */
    }
  }

  // ── Sanitize for DOM ─────────────────────────────────────────
  function sanitize(val) {
    if (val === null || val === undefined) return "";
    return String(val).slice(0, 500);
  }

  // ── Validate E.164 phone format ──────────────────────────────
  function validPhone(phone) {
    return typeof phone === "string" && /^\+[1-9]\d{6,14}$/.test(phone.trim());
  }

  // ── Show / hide elements safely ──────────────────────────────
  function show(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = "";
  }
  function hide(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  }
  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = sanitize(text);
  }

  // ── Toast notifications ──────────────────────────────────────
  function showToast(message, type) {
    type = ["success", "error", "warning", "info"].includes(type)
      ? type
      : "info";
    const container = document.getElementById("toast-container");
    if (!container) return;

    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;
    toast.textContent = sanitize(message); // textContent — XSS safe
    container.appendChild(toast);

    // Trigger animation
    requestAnimationFrame(() => toast.classList.add("visible"));

    setTimeout(() => {
      toast.classList.remove("visible");
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  }

  // ── Offline banner ───────────────────────────────────────────
  function updateOnlineStatus() {
    const banner = document.getElementById("offline-banner");
    if (!banner) return;
    if (navigator.onLine) {
      banner.style.display = "none";
    } else {
      banner.style.display = "block";
      banner.textContent =
        "You are offline. Your requests will be sent when connection returns.";
    }
  }

  // ── Auth helpers ─────────────────────────────────────────────
  function getToken() {
    return lsGet(TOKEN_KEY, null);
  }

  function isLoggedIn() {
    const token = getToken();
    if (!token) return false;
    // Basic JWT expiry check — decode payload without verification
    try {
      const parts = token.split(".");
      if (parts.length !== 3) return false;
      const payload = JSON.parse(
        atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")),
      );
      if (payload.exp && Date.now() / 1000 > payload.exp) {
        lsRemove(TOKEN_KEY);
        lsRemove(USER_KEY);
        return false;
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  function saveAuth(token, user) {
    lsSet(TOKEN_KEY, sanitize(token));
    lsSet(USER_KEY, JSON.stringify(user));
    currentUser = user;
  }

  function clearAuth() {
    lsRemove(TOKEN_KEY);
    lsRemove(USER_KEY);
    currentUser = null;
  }

  function loadUser() {
    try {
      const raw = lsGet(USER_KEY, null);
      if (raw) currentUser = JSON.parse(raw);
    } catch (e) {
      currentUser = null;
    }
  }

  // ── API helper ───────────────────────────────────────────────
  async function apiPost(path, body) {
    const headers = { "Content-Type": "application/json" };
    const token = getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const resp = await fetch(path, {
        method: "POST",
        headers: headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const data = await resp.json().catch(() => ({}));
      return { ok: resp.ok, status: resp.status, data };
    } catch (e) {
      clearTimeout(timeout);
      if (e.name === "AbortError") {
        return { ok: false, status: 0, data: { error: "Request timed out" } };
      }
      return { ok: false, status: 0, data: { error: "Network error" } };
    }
  }

  // ── OTP Flow ─────────────────────────────────────────────────
  function showOTPScreen() {
    hide("onboarding-screen");
    hide("main-app");
    show("auth-screen");
    show("phone-step");
    hide("otp-step");
  }

  async function requestOTP() {
    const input = document.getElementById("phone-input");
    if (!input) return;

    const phone = input.value.trim();
    if (!validPhone(phone)) {
      showToast(
        "Please enter a valid phone number with country code e.g. +15551234567",
        "error",
      );
      return;
    }

    const btn = document.getElementById("send-otp-btn");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Sending...";
    }

    const result = await apiPost("/api/auth/send-otp", { phone });

    if (btn) {
      btn.disabled = false;
      btn.textContent = "Send Code";
    }

    if (result.ok) {
      otpPhone = phone;
      hide("phone-step");
      show("otp-step");
      setText("otp-phone-display", phone);
      showToast("Verification code sent to " + phone, "success");
      startOTPTimer();
      const otpInput = document.getElementById("otp-input");
      if (otpInput) otpInput.focus();
    } else {
      showToast(
        sanitize(result.data.error) || "Failed to send code. Please try again.",
        "error",
      );
    }
  }

  function startOTPTimer() {
    clearOTPTimer();
    let remaining = 300; // 5 minutes
    const timerEl = document.getElementById("otp-timer");

    otpTimer = setInterval(() => {
      remaining--;
      if (timerEl) {
        const mins = Math.floor(remaining / 60);
        const secs = remaining % 60;
        timerEl.textContent = `Code expires in ${mins}:${secs.toString().padStart(2, "0")}`;
      }
      if (remaining <= 0) {
        clearOTPTimer();
        showToast(
          "Verification code expired. Please request a new one.",
          "warning",
        );
        hide("otp-step");
        show("phone-step");
      }
    }, 1000);
  }

  function clearOTPTimer() {
    if (otpTimer) {
      clearInterval(otpTimer);
      otpTimer = null;
    }
  }

  async function verifyOTP() {
    const input = document.getElementById("otp-input");
    if (!input) return;

    const code = input.value.trim().replace(/\D/g, "").slice(0, 8);
    if (!code || code.length < 4) {
      showToast("Please enter the verification code", "error");
      return;
    }

    if (!otpPhone || !validPhone(otpPhone)) {
      showToast("Session expired. Please start again.", "error");
      showOTPScreen();
      return;
    }

    const btn = document.getElementById("verify-otp-btn");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Verifying...";
    }

    const result = await apiPost("/api/auth/verify-otp", {
      phone: otpPhone,
      code: code,
    });

    if (btn) {
      btn.disabled = false;
      btn.textContent = "Verify";
    }

    if (result.ok && result.data.token) {
      clearOTPTimer();
      saveAuth(result.data.token, result.data.user || {});
      showToast("Welcome to BridgeUp!", "success");
      launchApp();
    } else {
      showToast(
        sanitize(result.data.error) || "Invalid code. Please try again.",
        "error",
      );
      input.value = "";
      input.focus();
    }
  }

  // ── Onboarding ───────────────────────────────────────────────
  let onboardingStep = 0;
  const ONBOARDING_STEPS = 3;

  function showOnboarding() {
    hide("auth-screen");
    hide("main-app");
    show("onboarding-screen");
    updateOnboardingStep(0);
  }

  function updateOnboardingStep(step) {
    onboardingStep = step;
    const slides = document.querySelectorAll(".onboarding-slide");
    const dots = document.querySelectorAll(".onboarding-dot");

    slides.forEach((s, i) => {
      s.classList.toggle("active", i === step);
    });
    dots.forEach((d, i) => {
      d.classList.toggle("active", i === step);
    });
  }

  function nextOnboardingStep() {
    if (onboardingStep < ONBOARDING_STEPS - 1) {
      updateOnboardingStep(onboardingStep + 1);
    } else {
      // Last step — go to auth
      lsSet("bridgeup_onboarded", "1");
      showOTPScreen();
    }
  }

  // ── Tab navigation ───────────────────────────────────────────
  function switchTab(tab) {
    const validTabs = ["map", "needs", "helpers", "profile"];
    if (!validTabs.includes(tab)) return;
    currentTab = tab;

    // Update nav tabs
    document.querySelectorAll(".nav-tab").forEach(function (el) {
      el.classList.toggle("active", el.getAttribute("data-tab") === tab);
    });

    // Show/hide panels
    document.querySelectorAll(".tab-panel").forEach(function (el) {
      el.classList.toggle("active", el.getAttribute("data-panel") === tab);
    });
  }

  // ── Language selector ────────────────────────────────────────
  function setLanguage(code) {
    const allowed = ["en", "fr", "rw", "sw", "es", "ar"];
    const safe = allowed.includes(code) ? code : "en";
    lsSet(LANG_KEY, safe);

    if (window.VoiceInterface) {
      const langMap = {
        en: "en-US",
        fr: "fr-FR",
        rw: "rw-RW",
        sw: "sw-KE",
        es: "es-ES",
        ar: "ar-SA",
      };
      window.VoiceInterface.setLanguage(langMap[safe] || "en-US");
    }

    // Update active state on language buttons
    document.querySelectorAll("[data-lang]").forEach(function (btn) {
      btn.classList.toggle("active", btn.getAttribute("data-lang") === safe);
    });
  }

  // ── Load nearby helpers ──────────────────────────────────────
  async function loadNearbyHelpers(lat, lng, category) {
    if (typeof lat !== "number" || typeof lng !== "number") return;
    if (!isFinite(lat) || !isFinite(lng)) return;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return;

    const params = new URLSearchParams({
      lat: lat.toFixed(6),
      lng: lng.toFixed(6),
      radius: "50",
    });
    if (category && category !== "all") {
      params.set("category", sanitize(category).slice(0, 50));
    }

    try {
      const resp = await fetch(`/api/helpers/nearby?${params.toString()}`);
      if (!resp.ok) return;
      const data = await resp.json();
      if (Array.isArray(data.helpers) && window.MapInterface) {
        window.MapInterface.updateHelperMarkers(data.helpers);
        updateHelperCount(data.helpers.length);
      }
    } catch (e) {
      // Silent fail — helpers not critical to app load
    }
  }

  function updateHelperCount(count) {
    const el = document.getElementById("helper-count");
    if (el)
      el.textContent =
        count + " helper" + (count !== 1 ? "s" : "") + " near you";
  }

  // ── Profile panel ────────────────────────────────────────────
  function renderProfile() {
    if (!currentUser) return;
    setText("profile-phone", currentUser.phone || "");
    setText("profile-role", currentUser.role || "user");
  }

  async function logout() {
    const token = getToken();
    if (token) {
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      };
      await fetch("/api/auth/logout", { method: "POST", headers }).catch(
        () => null,
      );
    }
    clearAuth();
    if (window.ChatInterface) window.ChatInterface.reset();
    if (window.MapInterface) window.MapInterface.clearHelperMarkers();
    showOTPScreen();
    showToast("You have been logged out", "info");
  }

  // ── Launch main app ──────────────────────────────────────────
  function launchApp() {
    hide("onboarding-screen");
    hide("auth-screen");
    show("main-app");

    loadUser();
    renderProfile();

    // Initialise map
    if (window.MapInterface) {
      window.MapInterface.init();
      window.MapInterface.initBottomSheetDrag();
    }

    // Initialise chat
    if (window.ChatInterface) window.ChatInterface.init();

    // Initialise voice
    if (window.VoiceInterface) window.VoiceInterface.init();

    // Load language preference
    const lang = lsGet(LANG_KEY, "en");
    setLanguage(lang);

    switchTab("map");

    // Load nearby helpers after short delay to let map settle
    setTimeout(function () {
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          function (pos) {
            loadNearbyHelpers(pos.coords.latitude, pos.coords.longitude, null);
          },
          null,
          { timeout: 10000 },
        );
      }
    }, 2000);
  }

  // ── Service worker registration ──────────────────────────────
  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    // Skip SW on localhost: the dev preview proxy serves resources over plain
    // HTTP and a previously installed SW can return stale 503 responses that
    // shadow the live server.  SW is only registered in production (HTTPS).
    if (
      location.hostname === "localhost" ||
      location.hostname === "127.0.0.1"
    )
      return;
    if (location.protocol !== "https:") return;

    navigator.serviceWorker
      .register("/service-worker.js", { scope: "/" })
      .then(function (reg) {
        console.info("SW registered, scope:", reg.scope);
      })
      .catch(function (err) {
        console.warn("SW registration failed:", err.message);
      });
  }

  // ── Wire up all event listeners ──────────────────────────────
  function wireEvents() {
    // OTP flow
    const sendOtpBtn = document.getElementById("send-otp-btn");
    const verifyOtpBtn = document.getElementById("verify-otp-btn");
    const phoneInput = document.getElementById("phone-input");
    const otpInput = document.getElementById("otp-input");

    if (sendOtpBtn) sendOtpBtn.addEventListener("click", requestOTP);
    if (verifyOtpBtn) verifyOtpBtn.addEventListener("click", verifyOTP);

    if (phoneInput) {
      phoneInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") requestOTP();
      });
    }
    if (otpInput) {
      otpInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") verifyOTP();
      });
      // Auto-submit when 6 digits entered
      otpInput.addEventListener("input", function () {
        const digits = otpInput.value.replace(/\D/g, "");
        if (digits.length >= 6) verifyOTP();
      });
    }

    // Resend OTP
    const resendBtn = document.getElementById("resend-otp-btn");
    if (resendBtn) {
      resendBtn.addEventListener("click", function () {
        hide("otp-step");
        show("phone-step");
        clearOTPTimer();
      });
    }

    // Onboarding navigation
    const nextBtns = document.querySelectorAll(".onboarding-next");
    nextBtns.forEach((btn) =>
      btn.addEventListener("click", nextOnboardingStep),
    );

    const skipBtn = document.getElementById("onboarding-skip");
    if (skipBtn) {
      skipBtn.addEventListener("click", function () {
        lsSet("bridgeup_onboarded", "1");
        showOTPScreen();
      });
    }

    // Bottom navigation tabs
    document.querySelectorAll(".nav-tab").forEach(function (tab) {
      tab.addEventListener("click", function () {
        const t = tab.getAttribute("data-tab");
        if (t) switchTab(t);
      });
    });

    // Language buttons
    document.querySelectorAll("[data-lang]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        const code = btn.getAttribute("data-lang");
        if (code) setLanguage(code);
      });
    });

    // Logout button
    const logoutBtn = document.getElementById("logout-btn");
    if (logoutBtn) logoutBtn.addEventListener("click", logout);

    // Online / offline events
    window.addEventListener("online", updateOnlineStatus);
    window.addEventListener("offline", updateOnlineStatus);

    // Voice button
    const voiceBtn = document.getElementById("voice-btn");
    if (voiceBtn) {
      voiceBtn.addEventListener("click", function () {
        if (window.VoiceInterface) window.VoiceInterface.startListening();
      });
    }

    // I Need Help button — opens chat
    const needHelpBtn = document.getElementById("need-help-btn");
    if (needHelpBtn) {
      needHelpBtn.addEventListener("click", function () {
        if (window.ChatInterface) window.ChatInterface.openChat();
      });
    }

    // I Can Help button
    const canHelpBtn = document.getElementById("can-help-btn");
    if (canHelpBtn) {
      canHelpBtn.addEventListener("click", function () {
        switchTab("helpers");
      });
    }
  }

  // ── Bootstrap ────────────────────────────────────────────────
  function bootstrap() {
    registerServiceWorker();
    updateOnlineStatus();
    wireEvents();

    // Decide which screen to show
    const onboarded = lsGet("bridgeup_onboarded", null);

    if (!onboarded) {
      showOnboarding();
      return;
    }

    if (isLoggedIn()) {
      launchApp();
    } else {
      showOTPScreen();
    }
  }

  // ── DOM ready ────────────────────────────────────────────────
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap);
  } else {
    bootstrap();
  }

  // ── Public API ───────────────────────────────────────────────
  window.AppInterface = {
    showToast: showToast,
    switchTab: switchTab,
    setLanguage: setLanguage,
    loadNearbyHelpers: loadNearbyHelpers,
    isLoggedIn: isLoggedIn,
    logout: logout,
  };
})();
