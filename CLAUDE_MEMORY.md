# BridgeUp — Claude Session Memory
> Last updated: 2026-04-26  |  Branch: `main`  |  Last commit: `1857c6c`

---

## Current Task
Full UI/UX overhaul to match Uber/Google Maps quality + Bridge AI agent integration.
The app is deployed at **https://bridge-up-api-server.vercel.app** on Vercel Hobby plan.

---

## Architecture Snapshot

| Layer | Tech |
|-------|------|
| Frontend | React 18 + TypeScript + Vite + Tailwind v4 + shadcn/ui |
| Routing | Wouter |
| State | Zustand (auth) + TanStack React Query (server data) |
| Map | Leaflet (CDN, no API key) — CartoDB Positron (standard) + ESRI World Imagery (satellite) |
| Backend | Vercel serverless functions (`api/**/*.js`) — CommonJS |
| Auth | Twilio OTP + JWT (7-day) stored in **localStorage** |
| Database | Supabase PostgreSQL with RLS |
| AI | Anthropic SDK `@anthropic-ai/sdk ^0.36.3` — agent at `/api/agent/chat` |
| PWA | Web App Manifest + Service Worker (cache `bridgeup-v2`) |

---

## Vercel Serverless Functions (12 — Hobby plan limit, must not exceed)

```
api/health.js          ← also handles ?ai=1 AI diagnostic
api/ping.js
api/auth/send-otp.js
api/auth/verify-otp.js
api/auth/me.js
api/auth/logout.js
api/needs/index.js
api/needs/my.js
api/needs/intake.js    ← legacy intake (simple, no tool use)
api/matching/matches.js
api/admin/dashboard.js
api/agent/chat.js      ← Bridge AI agent (Claude tool use)
```
> ⚠️  Adding any new `.js` file under `api/` (outside `_lib/`) will break deployment.
> To add functionality: enhance an existing file OR consolidate two routes into one.

---

## What Is Done (this session)

### Auth
- [x] Token stored in `localStorage` (was `sessionStorage` — broke mobile refresh)
- [x] User object cached in `localStorage` as `bridgeup_user` — hydrated instantly on startup, no loading flash
- [x] `isInitialized: true` from the very first render — no `PageLoader` on page refresh
- [x] `refresh()` is background-only: 401/403 signs out, 5xx/network keeps cached user
- [x] One-time `sessionStorage → localStorage` migration for existing logged-in users
- [x] API client (`api.ts`) reads token from `localStorage`

### Auth UI
- [x] Auth screen unified: same clean white card on mobile AND desktop (no more dark hero split)
- [x] Desktop auth: single "phone or email" input (no country picker), heading "What's your phone number or email?"
- [x] Mobile auth: country code picker + phone input unchanged
- [x] OTP page: centered white card matching auth page (logo, OTP boxes, black Verify button, resend)
- [x] Auth CTA button: black `#000000` when active (Uber style)

### Home / Map
- [x] Leaflet z-index fix: map container has `zIndex: 0` creating isolated stacking context — all overlays (search, pills, FABs, bottom sheet) now appear above the map tiles
- [x] Google Maps-style search pill: full width, profile avatar inside right side
- [x] Category filter pills: Food, Housing, Jobs, Medical, Training, Funding (no "All") — toggle to filter map markers
- [x] AI FAB: 52px circular gradient button (`bottom: 90px left: 16px`) — fixed position, never overlaps pills
- [x] Location button: fixed `bottom: 90px right: 16px`
- [x] Satellite/Map toggle: `bottom: 148px right: 16px` — switches between CartoDB Positron and ESRI World Imagery
- [x] Bottom sheet: `zIndex: 60`, peek 220px, half 52vh, full 88vh — drag handle, greeting, 4 categories, match card, needs list
- [x] Zoom controls moved to bottom-right (Google Maps convention), styled to match

### Bridge AI Agent
- [x] `api/agent/chat.js`: Claude tool-use agent with 3-round agentic loop
  - `search_helpers`: queries Supabase helpers table by category/location
  - `create_need`: registers need in DB (channel=ai_agent)
  - `contact_helper`: sends SMS via Twilio on behalf of user, creates match record
  - `complete_task`: marks need resolved with summary written to match notes
- [x] Model: tries `claude-3-5-haiku-20241022` first (confirmed working), falls back to `claude-haiku-4-5-20251001`
- [x] AI call wrapped in try/catch — errors return friendly messages, not 500s
- [x] Frontend: Phoenix-style chat UI with inline helper cards, SMS confirmation, completion summary
- [x] Helper cards: name, category icon, rating, online status, "Contact on my behalf" + Google Maps link
- [x] AI diagnostic: `GET /api/health?ai=1` runs a live test of the Anthropic API key

### UI Pages (all use `#f4f4f6` background + white cards + 16-20px radius + subtle shadows)
- [x] Profile: large 80px avatar, info rows with icon chips, black Save / red-outline Sign-out
- [x] MyNeeds: bold header, Active/Past sections with badge counts, skeleton loader, empty state with AI CTA
- [x] PostNeed: 4-step form — category grid (inline-styled white cards), details form, urgency, review; black CTA button
- [x] NeedCard: full variant with coloured top-band + status pill; compact variant for Home sheet
- [x] MatchDetail: Google Maps directions link, Uber deep link, WhatsApp, Call — all action buttons
- [x] AppShell nav: 68px, backdrop blur, active indicator line, near-black active colour

### PWA
- [x] `public/manifest.json`: name, display=standalone, SVG icons, 3 app shortcuts
- [x] `public/icons/icon.svg` + `icon-maskable.svg`: blue gradient + white bolt
- [x] `public/service-worker.js` (cache `bridgeup-v2`): cache-first shell, network-only API/tiles
- [x] `index.html`: manifest link, apple-touch-icon, OG tags
- [x] `src/main.tsx`: service worker registration with auto-update on each load

---

## What Is NOT Done / Open Items

### 🔴 Blocking — AI Agent not confirmed working
- The ANTHROPIC_API_KEY is set in Vercel but has never been confirmed to work
- **Action**: After each deploy, visit `https://bridge-up-api-server.vercel.app/api/health?ai=1`
- Expected response when working: `{ "ai_test": { "status": "ok", "model": "claude-3-5-haiku-20241022", "reply": "ready" } }`
- If `no_key`: env var not set or Vercel needs a redeploy
- If `HTTP 401`: wrong API key value — re-enter it at platform.anthropic.com

### 🟡 Feature Gaps
- **Google Maps API**: User wants to use actual Google Maps. Requires:
  1. Google Cloud Console project
  2. Enable "Maps JavaScript API"
  3. Get API key (free tier: $200/month credit)
  4. Add `GOOGLE_MAPS_API_KEY` to Vercel env vars
  5. Then: replace Leaflet with `@googlemaps/js-api-loader` or use the Google Maps embed
- **Helpers in Supabase**: No real helpers registered yet — AI search returns empty. Need to insert test helpers via Supabase SQL editor (see CLAUDE.md testing guide)
- **Matching algorithm**: Route exists but logic is basic — no geolocation-based sorting
- **In-app messaging**: Matched users cannot message each other in-app yet
- **Admin dashboard**: KPIs exist but helper approval workflow UI is incomplete
- **PostNeed AI pre-fill**: When coming from AI intake, the form could be pre-filled with intake data

### 🟡 Design Remaining
- **Matches page**: Cards are functional but could match the NeedCard polish level
- **NeedDetail status tracker**: Progress bar works but visual is basic
- **IntakeChat on mobile**: Bottom sheet pattern would fit better than full-page on mobile

### 🟠 Technical Debt
- `api/needs/intake.js` (legacy) still exists — should eventually be removed in favour of `api/agent/chat.js`
- `public/index.html` (in `public/`) is a legacy artefact — only `index.html` at root is used
- Tailwind v4 CSS variables don't resolve correctly in some contexts → all new components use explicit inline styles as workaround
- `@anthropic-ai/sdk ^0.36.3` is older — upgrading to 1.x would enable streaming responses for the AI chat

---

## Open Decisions

| Decision | Options | Status |
|----------|---------|--------|
| Google Maps vs Leaflet | Keep Leaflet (free, works) OR migrate to Google Maps JS API (requires billing) | Pending Mike's input |
| Vercel Hobby vs Pro | Hobby: 12 function limit (currently maxed) — any new API feature requires consolidating existing ones | Pending — monitor as features grow |
| AI model | `claude-3-5-haiku-20241022` (primary, confirmed) vs `claude-haiku-4-5-20251001` (newer, untested on this key) | Keep current until /health?ai=1 confirms which works |
| Uber/Google Maps integration | Deep links (current — free) vs real-time Uber API (requires business partnership) | Deep links in production; real API is aspirational |
| Helper onboarding flow | Manual SQL inserts (testing) vs in-app helper registration form | Registration route exists but UI flow not built |

---

## Key File Map

```
src/
  store/auth.ts              ← localStorage auth, background refresh, user cache
  lib/api.ts                 ← all API types + agentApi, authApi, needsApi etc.
  pages/
    auth/AuthPhone.tsx        ← unified auth (desktop: email/phone, mobile: country+phone)
    auth/AuthOtp.tsx          ← centered OTP card
    home/Home.tsx             ← map + search + filter pills + AI FAB + satellite toggle
    intake/IntakeChat.tsx     ← Bridge AI chat UI (Phoenix-style)
    post-need/PostNeed.tsx    ← 4-step form
    needs/MyNeeds.tsx         ← request list
    needs/NeedDetail.tsx      ← status tracker
    matches/Matches.tsx       ← match list
    matches/MatchDetail.tsx   ← Google Maps + Uber + Call + WhatsApp actions
    profile/Profile.tsx       ← account page
  components/
    map/MapView.tsx           ← Leaflet + satellite tile switching
    layout/AppShell.tsx       ← bottom nav (68px, backdrop blur)
    needs/NeedCard.tsx        ← compact + full variants

api/
  agent/chat.js              ← Bridge AI (Claude tool use + SMS + Supabase)
  health.js                  ← system health + ?ai=1 AI diagnostic
  auth/me.js                 ← GET/PATCH current user
  needs/intake.js            ← legacy simple intake (no tool use)
  _lib/                      ← shared helpers (NOT serverless functions)
    cors.js, auth.js, supabase.js, twilio-client.js

public/
  manifest.json              ← PWA manifest
  service-worker.js          ← cache bridgeup-v2
  icons/icon.svg             ← app icon
```

---

## Environment Variables (all in Vercel dashboard)

| Variable | Purpose | Required |
|----------|---------|----------|
| `SUPABASE_URL` | Database connection | YES |
| `SUPABASE_SERVICE_KEY` | DB service role key | YES |
| `SESSION_SECRET` | JWT signing (min 32 chars) | YES |
| `ANTHROPIC_API_KEY` | Claude AI — Bridge AI agent | YES (for AI) |
| `TWILIO_ACCOUNT_SID` | SMS/OTP | YES |
| `TWILIO_AUTH_TOKEN` | SMS/OTP | YES |
| `TWILIO_PHONE_NUMBER` | Outbound SMS sender | YES |
| `FRONTEND_URL` | CORS whitelist | YES |

---

## Testing Checklist (before next session)

- [ ] `/api/health?ai=1` returns `"status": "ok"` — confirms AI works
- [ ] Insert test helpers in Supabase (see CLAUDE.md testing guide)
- [ ] Login, post a need, use Bridge AI to find a helper
- [ ] Verify "Contact on my behalf" sends SMS and creates match
- [ ] Test satellite map toggle
- [ ] Install as PWA on Android and iPhone
- [ ] Test all 4 PostNeed steps end-to-end
- [ ] Verify profile edit/save/logout

---

## Design System (quick reference)

```
Background:    #f4f4f6  (all inner pages)
Cards:         #ffffff, border-radius: 16-20px, box-shadow: 0 2px 12px rgba(0,0,0,0.07)
Primary CTA:   #000000 (black, Uber style)
Brand blue:    #2563eb
AI gradient:   linear-gradient(135deg, #2563eb, #7c3aed)
Body font:     Inter, system-ui, sans-serif
Nav height:    68px
```
