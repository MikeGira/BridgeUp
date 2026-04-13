# Workspace

## Overview

pnpm workspace monorepo. BridgeUp is the primary product — a PWA "Human Needs OS" built with plain HTML5/CSS3/JS (no React/Vue/Svelte) and a Node.js/CommonJS Express backend.

## Project: BridgeUp

A full-stack PWA connecting people in crisis with verified helpers. Targets Rwanda, East/Central Africa, Canada/North America. Supports 90+ languages, Claude AI intake, Twilio SMS/IVR, Leaflet.js maps, multi-currency payments, Firebase Firestore, 8 role-based dashboards.

### Key design tokens
- `--color-primary: #16A34A` (green), `--color-primary-dark: #15803D`
- `--color-accent: #F59E0B`
- `--radius-md: 12px`, `--radius-lg: 16px`, `--radius-xl: 20px`

### CSS z-index stack
map=1, left-panel=50, floating panels=100, bottom-sheet=150, bottom-nav/search=200, search-dropdown=201, voice-btn=300, modal=500, toast=900, offline-banner=999, onboarding=1000

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **Frontend**: Plain HTML5/CSS3/JS (NOT React), Leaflet.js (served locally at `/lib/`)
- **Backend**: Node.js CommonJS + Express (server/index.js at port 3000)
- **Database**: Firebase Firestore (Admin SDK)
- **AI**: Claude (`claude-sonnet-4-20250514`)
- **SMS/IVR**: Twilio
- **Voice**: Web Speech API (voice.js)
- **PWA**: Service worker (v2), Web App Manifest

## Artifacts

- **bridgeup** — Main PWA app, served at `/` on port 3000
- **api-server** — Template Express API (unused by BridgeUp), served at `/api-server` on port 8080

## Important architecture notes

### Port routing (Replit proxy)
- BridgeUp runs on port 3000, exposed at path `/`
- api-server runs on port 8080, exposed at `/api-server` (was changed from `/api` to avoid conflicting with BridgeUp's own `/api` routes)

### Static files
- In development: `Cache-Control: no-store` (so code changes are visible instantly)
- In production: `Cache-Control: public, max-age=86400`
- Third-party libraries (Leaflet, MarkerCluster) are bundled locally in `public/lib/` — not loaded from CDN — so they work offline and can be cached by the service worker

### Service worker
- Disabled on `localhost` (dev preview) to avoid stale-cache 503 issues in the Replit proxy environment
- Only active in production (HTTPS, non-localhost) where caching is safe
- Cache version: `v2` — increment to bust all caches
- Uses `skipWaiting()` + `clients.claim()` for immediate activation on update

### Security headers (Helmet)
- `frame-ancestors` includes `*.worf.replit.dev` (two-level subdomain needed for canvas iframes)
- `upgrade-insecure-requests`: removed (breaks HTTP→HTTPS upgrades in dev localhost)
- `crossOriginOpenerPolicy`: `unsafe-none` (allows Replit canvas iframe postMessage)
- `crossOriginEmbedderPolicy`: `false`
- `X-Frame-Options` (frameguard): disabled (CSP frame-ancestors takes precedence)

### Firebase
- Admin SDK gRPC error code 5 = NOT_FOUND; handle with `if (fsErr.code === 5) return res.status(404)`
- `writeAuditLog` signature: `{ action, actorId, targetId, meta, tenantId }`

### Google Fonts
- Loaded asynchronously (non-blocking preload) so a blocked CDN never delays first paint

## File structure

```
artifacts/bridgeup/
  public/
    index.html          # Main HTML — plain HTML5, no framework
    css/styles.css      # All CSS (design system + components)
    js/
      app.js            # Main app logic + SW registration (disabled on localhost)
      map.js            # Leaflet map
      chat.js           # Claude AI chat
      voice.js          # Web Speech API (window.VoiceInterface)
    lib/                # Locally bundled third-party libs (no CDN)
      leaflet.min.js
      leaflet.min.css
      leaflet.markercluster.min.js
      MarkerCluster.min.css
      MarkerCluster.Default.min.css
      images/           # Leaflet marker/layer images
    images/             # App icons (icon-192.png, icon-512.png)
    manifest.json
    service-worker.js   # SW v2 — skipWaiting, offline queue, tile cache
  server/
    index.js            # Express server (CommonJS, port 3000)
    routes/             # API route handlers
    services/
      firebase.js       # Firestore Admin SDK
      claude.js         # Claude AI
      twilio.js         # SMS/IVR
```

## Key Commands

- `pnpm --filter @workspace/bridgeup run dev` — run BridgeUp locally
- `pnpm --filter @workspace/api-server run dev` — run template API server (separate from BridgeUp)
