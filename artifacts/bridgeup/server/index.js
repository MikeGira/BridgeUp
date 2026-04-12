'use strict';

// ─── Load environment variables first, before anything else ───────────────────
require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');

// ─── App initialisation ────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 3000;

// ─── Trust Replit / Railway proxy so req.ip is the real client IP ─────────────
app.set('trust proxy', 1);

// ─── Security headers (Helmet) ─────────────────────────────────────────────────
// Content-Security-Policy is relaxed just enough for Leaflet CDN, Google Fonts,
// CartoDB tiles, Chart.js CDN, and Firebase SDK to load from the browser.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'",          // inline event handlers in plain HTML
          'https://unpkg.com',        // Leaflet, Leaflet plugins
          'https://cdn.jsdelivr.net', // Chart.js, Leaflet Routing Machine
          'https://cdnjs.cloudflare.com',
          'https://www.gstatic.com',  // Firebase SDK
          'https://www.googleapis.com',
        ],
        styleSrc: [
          "'self'",
          "'unsafe-inline'",
          'https://fonts.googleapis.com',
          'https://unpkg.com',
          'https://cdn.jsdelivr.net',
          'https://cdnjs.cloudflare.com',
        ],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: [
          "'self'",
          'data:',
          'blob:',
          'https://*.basemaps.cartocdn.com', // CartoDB Positron map tiles
          'https://*.openstreetmap.org',
          'https://nominatim.openstreetmap.org',
        ],
        connectSrc: [
          "'self'",
          'https://nominatim.openstreetmap.org', // Nominatim geocoding
          'https://*.firebaseio.com',
          'https://firestore.googleapis.com',
          'https://identitytoolkit.googleapis.com',
          'https://securetoken.googleapis.com',
          'wss://*.firebaseio.com',
        ],
        mediaSrc: ["'self'", 'blob:'], // voice recordings
        workerSrc: ["'self'", 'blob:'], // service worker
        frameSrc: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false, // required for Leaflet CDN resources
  })
);

// ─── CORS ──────────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  process.env.FRONTEND_URL,
  'http://localhost:3000',
  'http://localhost:5000',
  // Replit preview domains
  /\.replit\.dev$/,
  /\.repl\.co$/,
  /\.worf\.replit\.dev$/,
].filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, Postman, curl)
      if (!origin) return callback(null, true);
      const allowed = ALLOWED_ORIGINS.some((o) =>
        o instanceof RegExp ? o.test(origin) : o === origin
      );
      if (allowed) return callback(null, true);
      callback(new Error(`CORS: origin "${origin}" not allowed`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  })
);

// ─── Body parsers + raw body capture ─────────────────────────────────────────
// The `verify` callback runs inside express.json() / express.urlencoded() before
// the body is parsed. This is the correct way to capture req.rawBody for webhook
// signature verification without consuming the readable stream twice (which causes
// "stream is not readable" errors when a second middleware tries to re-read it).
//
// Webhook paths that need raw body access:
//   /stripe/webhook        — Stripe HMAC-SHA256 via stripe.webhooks.constructEvent
//   /africastalking/webhook — Africa's Talking pre-shared token
//   /flutterwave/webhook   — Flutterwave verif-hash header

function captureRawBody(req, res, buf) {
  const webhookPaths = ['/stripe/webhook', '/africastalking/webhook', '/flutterwave/webhook'];
  if (webhookPaths.some((p) => req.path.startsWith(p))) {
    req.rawBody = buf; // Buffer — used by payments.js webhook handlers
  }
}

app.use(express.json({ limit: '1mb', verify: captureRawBody }));
app.use(express.urlencoded({ extended: true, limit: '1mb', verify: captureRawBody }));

// ─── Global rate limiters ─────────────────────────────────────────────────────

// General API limiter — 100 requests per minute per IP
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down and try again shortly.' },
});

// Need submission limiter — max 3 per phone number per 24 hours
// (enforced in the route handler using Firestore, this covers anonymous bursts)
const needSubmissionLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 10,
  keyGenerator: (req) => req.body?.phone || req.ip,
  message: { error: 'You have reached the daily limit for need submissions. Please try again tomorrow.' },
});

// Auth / OTP limiter — prevent OTP abuse
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: { error: 'Too many authentication attempts. Please wait 15 minutes.' },
});

// Voice webhook limiter — generous for Twilio callbacks
const voiceLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  message: { error: 'Voice webhook rate limit exceeded.' },
});

// SMS webhook limiter — matches voiceLimiter; limits spoofed-signature flood
// attacks even though they will all be rejected at the HMAC check
const smsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  message: { error: 'SMS webhook rate limit exceeded.' },
});

app.use('/api/', generalLimiter);

// ─── Serve static public folder (the PWA frontend) ────────────────────────────
app.use(
  express.static(path.join(__dirname, '..', 'public'), {
    maxAge: '1d',
    etag: true,
    index: 'index.html',
  })
);

// ─── Health check (no auth required) ─────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'BridgeUp API',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
  });
});

// ─── Route modules ─────────────────────────────────────────────────────────────
// Each route file is loaded with error handling so a broken module does not
// take down the entire server during development.

function loadRoute(routePath, label) {
  try {
    return require(routePath);
  } catch (err) {
    console.warn(`[BridgeUp] Route "${label}" not yet available: ${err.message}`);
    // Return a placeholder router that explains the route is pending
    const placeholder = express.Router();
    placeholder.all('*', (req, res) => {
      res.status(503).json({ error: `${label} route module not yet loaded. Check server logs.` });
    });
    return placeholder;
  }
}

// Authentication — phone OTP + JWT (rate-limited)
app.use('/api/auth', authLimiter, loadRoute('./routes/auth', 'auth'));

// Need submission — rate-limited per phone
app.use('/api/needs', needSubmissionLimiter, loadRoute('./routes/needs', 'needs'));

// Helpers — registration, approval, availability
app.use('/api/helpers', loadRoute('./routes/helpers', 'helpers'));

// AI-powered matching engine
app.use('/api/matching', loadRoute('./routes/matching', 'matching'));

// SMS webhook — Twilio inbound SMS from feature phones
app.use('/sms', smsLimiter, loadRoute('./routes/sms', 'sms'));

// SMS admin API — same router, different mount path for /api/sms/conversations
// (the /api/ generalLimiter already covers this path; smsLimiter added for defence-in-depth)
app.use('/api/sms', smsLimiter, loadRoute('./routes/sms', 'sms'));

// Voice IVR webhook — Twilio Voice (Kinyarwanda / Swahili / English / French)
app.use('/voice', voiceLimiter, loadRoute('./routes/voice', 'voice'));

// Voice admin API — same router, different mount path for /api/voice/calls
// (the /api/ generalLimiter already covers this path; voiceLimiter for defence-in-depth)
app.use('/api/voice', voiceLimiter, loadRoute('./routes/voice', 'voice'));

// Payments — Stripe (North America / Europe) + Africa's Talking mobile money
app.use('/api/payments', loadRoute('./routes/payments', 'payments'));
app.use('/stripe', loadRoute('./routes/payments', 'stripe-webhooks'));
app.use('/africastalking', loadRoute('./routes/payments', 'at-webhooks'));
app.use('/flutterwave', loadRoute('./routes/payments', 'flw-webhooks'));

// Admin — dashboard data, helper approvals, audit log, white-label settings
app.use('/api/admin', loadRoute('./routes/admin', 'admin'));

// Reports — all 7 report types with PDF and Excel export
app.use('/api/reports', loadRoute('./routes/reports', 'reports'));

// Reviews — two-way rating after need resolution
app.use('/api/reviews', loadRoute('./routes/reviews', 'reviews'));

// ─── PWA fallback — serve index.html for any unmatched path ──────────────────
// This enables client-side routing without hash-based URLs.
app.get('*', (req, res) => {
  // Do not fall back to index.html for API routes — surface the 404 as JSON
  if (req.path.startsWith('/api/') || req.path.startsWith('/sms') || req.path.startsWith('/voice')) {
    return res.status(404).json({ error: `API endpoint "${req.path}" not found.` });
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'), (err) => {
    if (err) {
      res.status(404).json({ error: 'Frontend not yet built. Create public/index.html.' });
    }
  });
});

// ─── Global error handler ─────────────────────────────────────────────────────
// Must have 4 parameters for Express to treat it as an error handler.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;

  // Log stack trace server-side but never expose it to the client
  console.error(`[BridgeUp] ERROR ${status} ${req.method} ${req.path}:`, err.message);
  if (process.env.NODE_ENV !== 'production') {
    console.error(err.stack);
  }

  // Human-readable error messages — never raw error codes per spec
  const userMessage =
    status === 400 ? 'The information you sent is incomplete or incorrect. Please check and try again.'
    : status === 401 ? 'You need to sign in to access this. Please log in and try again.'
    : status === 403 ? 'You do not have permission to do that.'
    : status === 404 ? 'We could not find what you were looking for.'
    : status === 409 ? 'There is a conflict with existing data. Please refresh and try again.'
    : status === 429 ? 'You are sending too many requests. Please slow down.'
    : 'Something went wrong on our end. We have been notified and are looking into it.';

  res.status(status).json({
    error: userMessage,
    // Only expose details in development
    ...(process.env.NODE_ENV !== 'production' && { detail: err.message }),
  });
});

// ─── Start server ─────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║          BridgeUp — Human Needs OS              ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  Server running on port ${PORT.toString().padEnd(24)}║`);
  console.log(`║  Environment: ${(process.env.NODE_ENV || 'development').padEnd(34)}║`);
  console.log(`║  Static files: ./public                          ║`);
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');

  // Start report scheduler (node-cron) — after all routes are mounted so
  // DATA_FETCHERS in reports.js are fully initialised before first job fires.
  try {
    const { startScheduler } = require('./services/scheduler');
    startScheduler();
  } catch (err) {
    console.error('[BridgeUp] Scheduler failed to start:', err.message);
  }
});

module.exports = app;
