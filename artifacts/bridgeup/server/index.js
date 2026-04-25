"use strict";

require("dotenv").config();

const express    = require("express");
const helmet     = require("helmet");
const cors       = require("cors");
const rateLimit  = require("express-rate-limit");
const path       = require("path");

const app  = express();
const PORT = process.env.PORT || 3000;

app.set("trust proxy", 1);

// ─── Security headers ──────────────────────────────────────────────────────────
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc:  ["'self'", "'unsafe-inline'", "https://unpkg.com", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"],
        styleSrc:   ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://unpkg.com", "https://cdn.jsdelivr.net"],
        fontSrc:    ["'self'", "https://fonts.gstatic.com", "data:"],
        imgSrc:     ["'self'", "data:", "blob:", "https://*.basemaps.cartocdn.com", "https://*.openstreetmap.org", "https://nominatim.openstreetmap.org", "https://*.tile.openstreetmap.org"],
        connectSrc: ["'self'", "https://fonts.googleapis.com", "https://fonts.gstatic.com", "https://nominatim.openstreetmap.org", process.env.SUPABASE_URL || "", "https://*.supabase.co", "https://*.vercel.app", process.env.FRONTEND_URL || ""].filter(Boolean),
        mediaSrc:   ["'self'", "blob:"],
        workerSrc:  ["'self'", "blob:"],
        frameAncestors: ["'self'"],
        upgradeInsecureRequests: [],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

// ─── CORS ──────────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  process.env.FRONTEND_URL,
  "http://localhost:3000",
  "http://localhost:5173",
  /\.vercel\.app$/,
  /\.vercel\.sh$/,
].filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      const allowed = ALLOWED_ORIGINS.some((o) => (o instanceof RegExp ? o.test(origin) : o === origin));
      if (allowed) return callback(null, true);
      callback(new Error(`CORS: origin "${origin}" not allowed`));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  })
);

// ─── Body parsers + raw body capture ──────────────────────────────────────────
function captureRawBody(req, _res, buf) {
  const webhookPaths = ["/stripe/webhook", "/africastalking/webhook", "/flutterwave/webhook"];
  if (webhookPaths.some((p) => req.path.startsWith(p))) req.rawBody = buf;
}
app.use(express.json({ limit: "1mb", verify: captureRawBody }));
app.use(express.urlencoded({ extended: true, limit: "1mb", verify: captureRawBody }));

// ─── Rate limiters ─────────────────────────────────────────────────────────────
const generalLimiter = rateLimit({
  windowMs: 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false,
  message: { error: "Too many requests. Please slow down and try again shortly." },
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  message: { error: "Too many authentication attempts. Please wait 15 minutes." },
});
const needSubmissionLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, max: 10,
  keyGenerator: (req) => req.body?.phone || req.ip,
  message: { error: "You have reached the daily limit for need submissions." },
});
const voiceLimiter = rateLimit({ windowMs: 60 * 1000, max: 200, message: { error: "Voice webhook rate limit exceeded." } });
const smsLimiter   = rateLimit({ windowMs: 60 * 1000, max: 200, message: { error: "SMS webhook rate limit exceeded." } });

app.use("/api/", generalLimiter);

// ─── Static files (built React app) ───────────────────────────────────────────
const isDev = process.env.NODE_ENV !== "production";
const staticDir = path.join(__dirname, "..", "dist", "public");
app.use(
  express.static(staticDir, {
    maxAge: isDev ? 0 : "1d",
    etag: !isDev,
    lastModified: !isDev,
    index: "index.html",
    setHeaders: isDev ? (res) => res.set("Cache-Control", "no-store") : undefined,
  })
);

// ─── Health check ──────────────────────────────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", service: "BridgeUp API", version: "2.0.0", timestamp: new Date().toISOString(), environment: process.env.NODE_ENV || "development" });
});

// ─── Route loader ──────────────────────────────────────────────────────────────
function loadRoute(routePath, label) {
  try {
    return require(routePath);
  } catch (err) {
    console.warn(`[BridgeUp] Route "${label}" not available: ${err.message}`);
    const placeholder = express.Router();
    placeholder.all("*", (_req, res) => res.status(503).json({ error: `${label} route not yet loaded.` }));
    return placeholder;
  }
}

// ─── Routes ────────────────────────────────────────────────────────────────────
app.use("/api/auth",     authLimiter,          loadRoute("./routes/auth",     "auth"));
app.use("/api/needs",    needSubmissionLimiter, loadRoute("./routes/needs",    "needs"));
app.use("/api/helpers",                         loadRoute("./routes/helpers",  "helpers"));
app.use("/api/matching",                        loadRoute("./routes/matching", "matching"));
app.use("/sms",          smsLimiter,            loadRoute("./routes/sms",      "sms"));
app.use("/api/sms",      smsLimiter,            loadRoute("./routes/sms",      "sms"));
app.use("/voice",        voiceLimiter,          loadRoute("./routes/voice",    "voice"));
app.use("/api/voice",    voiceLimiter,          loadRoute("./routes/voice",    "voice"));
app.use("/api/payments",                        loadRoute("./routes/payments", "payments"));
app.use("/stripe",                              loadRoute("./routes/payments", "stripe-webhooks"));
app.use("/africastalking",                      loadRoute("./routes/payments", "at-webhooks"));
app.use("/flutterwave",                         loadRoute("./routes/payments", "flw-webhooks"));
app.use("/api/admin",                           loadRoute("./routes/admin",    "admin"));
app.use("/api/reports",                         loadRoute("./routes/reports",  "reports"));
app.use("/api/reviews",                         loadRoute("./routes/reviews",  "reviews"));

// ─── SPA fallback ──────────────────────────────────────────────────────────────
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/") || req.path.startsWith("/sms") || req.path.startsWith("/voice")) {
    return res.status(404).json({ error: `API endpoint "${req.path}" not found.` });
  }
  res.sendFile(path.join(staticDir, "index.html"), (err) => {
    if (err) res.status(404).json({ error: "Frontend not yet built." });
  });
});

// ─── Global error handler ──────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  console.error(`[BridgeUp] ERROR ${status} ${req.method} ${req.path}:`, err.message);
  if (process.env.NODE_ENV !== "production") console.error(err.stack);
  const userMessage = {
    400: "The information you sent is incomplete or incorrect.",
    401: "You need to sign in to access this.",
    403: "You do not have permission to do that.",
    404: "We could not find what you were looking for.",
    409: "There is a conflict with existing data.",
    429: "You are sending too many requests. Please slow down.",
  }[status] || "Something went wrong on our end.";
  res.status(status).json({ error: userMessage, ...(process.env.NODE_ENV !== "production" && { detail: err.message }) });
});

// ─── Start server ──────────────────────────────────────────────────────────────
if (require.main === module) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`\n[BridgeUp] Server running on port ${PORT} (${process.env.NODE_ENV || "development"})\n`);
    try {
      const { startScheduler } = require("./services/scheduler");
      startScheduler();
    } catch (err) {
      console.error("[BridgeUp] Scheduler failed to start:", err.message);
    }
  });
}

module.exports = app;
