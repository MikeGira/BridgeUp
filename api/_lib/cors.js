'use strict';

const ORIGINS = [
  process.env.FRONTEND_URL,
  'http://localhost:5173',
  'http://localhost:3000',
  /\.vercel\.app$/,
  /\.vercel\.sh$/,
].filter(Boolean);

function setCors(req, res) {
  const origin = req.headers.origin || '';
  const allowed = ORIGINS.some(o => o instanceof RegExp ? o.test(origin) : o === origin);
  if (allowed) res.setHeader('Access-Control-Allow-Origin', origin);
  else res.setHeader('Access-Control-Allow-Origin', process.env.FRONTEND_URL || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Requested-With');
  res.setHeader('Access-Control-Max-Age', '86400');
}

// Wraps a handler: sets CORS, handles OPTIONS preflight, catches errors
function handler(fn) {
  return async (req, res) => {
    setCors(req, res);
    if (req.method === 'OPTIONS') return res.status(200).end();

    // Security headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');

    try {
      await fn(req, res);
    } catch (err) {
      const status = err.status || err.statusCode || 500;
      const isProd = process.env.NODE_ENV === 'production';
      console.error(`[BridgeUp] ${req.method} ${req.url} → ${status}:`, err.message);
      if (!res.headersSent) {
        res.status(status).json({
          error: isProd && status >= 500 ? 'Something went wrong. Please try again.' : err.message,
        });
      }
    }
  };
}

module.exports = { setCors, handler };
