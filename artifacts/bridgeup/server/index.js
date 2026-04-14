"use strict";

require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.set("trust proxy", 1);

// ─── Security headers ──────────────────────────────────────────────────────────
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'",
          "https://unpkg.com",
          "https://cdn.jsdelivr.net",
          "https://cdnjs.cloudflare.com",
          "https://www.gstatic.com",
          "https://www.googleapis.com",
        ],
        styleSrc: [
          "'self'",
          "'unsafe-inline'",
          "https://fonts.googleapis.com",
          "https://unpkg.com",
          "https://cdn.jsdelivr.net",
          "https://cdnjs.cloudflare.com",
        ],
        fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
        imgSrc: [
          "'self'",
          "data:",
          "blob:",
          "https://*.basemaps.cartocdn.com",
          "https://*.openstreetmap.org",
          "https://nominatim.openstreetmap.org",
          "https://*.tile.openstreetmap.org",
        ],
        connectSrc: [
          "'self'",
          "https://fonts.googleapis.com",
          "https://fonts.gstatic.com",
          "https://nominatim.openstreetmap.org",
          "https://*.firebaseio.com",
          "https://firestore.googleapis.com",
          "https://identitytoolkit.googleapis.com",
          "https://securetoken.googleapis.com",
          "wss://*.firebaseio.com",
          "https://*.replit.dev",
          "wss://*.replit.dev",
          "https://*.repl.co",
          "https://*.worf.replit.dev",
          "wss://*.worf.replit.dev",
        ],
        mediaSrc: ["'self'", "blob:"],
        workerSrc: ["'self'", "blob:"],
        scriptSrcAttr: ["'unsafe-inline'"],

        // Allow framing from Replit preview and same origin.
        // *.worf.replit.dev must be listed explicitly — CSP wildcards only
        // match one subdomain level, so *.replit.dev does NOT cover
        // <hash>.worf.replit.dev (two levels under replit.dev).
        frameAncestors: [
          "'self'",
          "https://*.replit.com",
          "https://*.replit.dev",
          "https://*.worf.replit.dev",
          "https://*.repl.co",
        ],
        // Remove upgrade-insecure-requests: when the Replit preview loads the
        // app over HTTP (http://localhost:80), this directive upgrades every
        // sub-resource fetch to HTTPS — including http://localhost/js/app.js →
        // https://localhost/js/app.js which has no TLS listener and causes 503.
        upgradeInsecureRequests: null,
      },
    },
    crossOriginEmbedderPolicy: false,
    // unsafe-none allows the Replit canvas iframe to share a browsing context
    // so postMessage and window references work for the preview pane.
    crossOriginOpenerPolicy: { policy: "unsafe-none" },
    // Disable X-Frame-Options so frameAncestors CSP takes control
    frameguard: false,
  }),
);

// ─── CORS ──────────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  process.env.FRONTEND_URL,
  "http://localhost:3000",
  "http://localhost:5000",
  /\.replit\.dev$/,
  /\.repl\.co$/,
  /\.worf\.replit\.dev$/,
  /\.replit\.com$/,
].filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      const allowed = ALLOWED_ORIGINS.some((o) =>
        o instanceof RegExp ? o.test(origin) : o === origin,
      );
      if (allowed) return callback(null, true);
      callback(new Error(`CORS: origin "${origin}" not allowed`));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  }),
);

// ─── Body parsers + raw body capture ──────────────────────────────────────────
function captureRawBody(req, res, buf) {
  const webhookPaths = [
    "/stripe/webhook",
    "/africastalking/webhook",
    "/flutterwave/webhook",
  ];
  if (webhookPaths.some((p) => req.path.startsWith(p))) {
    req.rawBody = buf;
  }
}

app.use(express.json({ limit: "1mb", verify: captureRawBody }));
app.use(
  express.urlencoded({ extended: true, limit: "1mb", verify: captureRawBody }),
);

// ─── Rate limiters ─────────────────────────────────────────────────────────────
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many requests. Please slow down and try again shortly.",
  },
});

const needSubmissionLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => req.body?.phone || req.ip,
  message: {
    error:
      "You have reached the daily limit for need submissions. Please try again tomorrow.",
  },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: {
    error: "Too many authentication attempts. Please wait 15 minutes.",
  },
});

const voiceLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  message: { error: "Voice webhook rate limit exceeded." },
});

const smsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  message: { error: "SMS webhook rate limit exceeded." },
});

app.use("/api/", generalLimiter);

// ─── Static files ──────────────────────────────────────────────────────────────
// In development, disable all caching so code changes are visible instantly
// without a hard refresh.  In production, keep a 24-hour max-age for
// performance (CDN / browser cache hit rate).
const isDev = process.env.NODE_ENV !== "production";
app.use(
  express.static(path.join(__dirname, "..", "public"), {
    maxAge: isDev ? 0 : "1d",
    etag: !isDev,
    lastModified: !isDev,
    index: "index.html",
    setHeaders: isDev
      ? function (res) {
          res.set("Cache-Control", "no-store");
        }
      : undefined,
  }),
);

// ─── Health check ──────────────────────────────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    service: "BridgeUp API",
    version: "1.0.0",
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || "development",
  });
});

// ─── Route loader ──────────────────────────────────────────────────────────────
function loadRoute(routePath, label) {
  try {
    return require(routePath);
  } catch (err) {
    console.warn(
      `[BridgeUp] Route "${label}" not yet available: ${err.message}`,
    );
    const placeholder = express.Router();
    placeholder.all("*", (req, res) => {
      res.status(503).json({ error: `${label} route module not yet loaded.` });
    });
    return placeholder;
  }
}

// ─── Routes ────────────────────────────────────────────────────────────────────
app.use("/api/auth", authLimiter, loadRoute("./routes/auth", "auth"));
app.use(
  "/api/needs",
  needSubmissionLimiter,
  loadRoute("./routes/needs", "needs"),
);
app.use("/api/helpers", loadRoute("./routes/helpers", "helpers"));
app.use("/api/matching", loadRoute("./routes/matching", "matching"));
app.use("/sms", smsLimiter, loadRoute("./routes/sms", "sms"));
app.use("/api/sms", smsLimiter, loadRoute("./routes/sms", "sms"));
app.use("/voice", voiceLimiter, loadRoute("./routes/voice", "voice"));
app.use("/api/voice", voiceLimiter, loadRoute("./routes/voice", "voice"));
app.use("/api/payments", loadRoute("./routes/payments", "payments"));
app.use("/stripe", loadRoute("./routes/payments", "stripe-webhooks"));
app.use("/africastalking", loadRoute("./routes/payments", "at-webhooks"));
app.use("/flutterwave", loadRoute("./routes/payments", "flw-webhooks"));
app.use("/api/admin", loadRoute("./routes/admin", "admin"));
app.use("/api/reports", loadRoute("./routes/reports", "reports"));
app.use("/api/reviews", loadRoute("./routes/reviews", "reviews"));

// ─── PWA fallback ──────────────────────────────────────────────────────────────
app.get("*", (req, res) => {
  if (
    req.path.startsWith("/api/") ||
    req.path.startsWith("/sms") ||
    req.path.startsWith("/voice")
  ) {
    return res
      .status(404)
      .json({ error: `API endpoint "${req.path}" not found.` });
  }
  res.sendFile(path.join(__dirname, "..", "public", "index.html"), (err) => {
    if (err) {
      res.status(404).json({ error: "Frontend not yet built." });
    }
  });
});

// ─── Global error handler ──────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  console.error(
    `[BridgeUp] ERROR ${status} ${req.method} ${req.path}:`,
    err.message,
  );
  if (process.env.NODE_ENV !== "production") console.error(err.stack);

  const userMessage =
    status === 400
      ? "The information you sent is incomplete or incorrect."
      : status === 401
        ? "You need to sign in to access this."
        : status === 403
          ? "You do not have permission to do that."
          : status === 404
            ? "We could not find what you were looking for."
            : status === 409
              ? "There is a conflict with existing data."
              : status === 429
                ? "You are sending too many requests. Please slow down."
                : "Something went wrong on our end.";

  res.status(status).json({
    error: userMessage,
    ...(process.env.NODE_ENV !== "production" && { detail: err.message }),
  });
});

// ─── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║          BridgeUp — Human Needs OS              ║");
  console.log("╠══════════════════════════════════════════════════╣");
  console.log(`║  Server running on port ${PORT.toString().padEnd(24)}║`);
  console.log(
    `║  Environment: ${(process.env.NODE_ENV || "development").padEnd(34)}║`,
  );
  console.log(`║  Static files: ./public                          ║`);
  console.log("╚══════════════════════════════════════════════════╝");
  console.log("");

  try {
    const { startScheduler } = require("./services/scheduler");
    startScheduler();
  } catch (err) {
    console.error("[BridgeUp] Scheduler failed to start:", err.message);
  }
});

module.exports = app;
