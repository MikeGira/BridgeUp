# BridgeUp — Project CLAUDE.md (v2.0)

## WHAT IS BRIDGEUP
An AI-powered human needs operating system. People post needs (food, shelter, skills, jobs, services, training) and get matched with verified helpers and organizations. Target communities: underserved populations in Canada and Rwanda/Africa. Vision: Uber meets Google Maps, but for humanitarian needs.

## CURRENT STATUS
- ✅ Express server (port 3000) with Helmet + CORS + rate limiting
- ✅ Supabase PostgreSQL database (replaces Firebase/Firestore)
- ✅ Twilio SMS + Voice OTP auth
- ✅ JWT authentication with revocation list
- ✅ React frontend (Vite + shadcn/ui + Tailwind + Leaflet maps)
- ✅ Zustand auth state + React Query data fetching
- ✅ Anthropic Claude SDK integrated (services/claude.js)
- ✅ Stripe + Flutterwave payment routes wired
- ✅ node-cron scheduler
- ✅ PDF generation (pdfkit), file uploads (multer)
- ✅ Vercel deployment configured (vercel.json + api/server.js)
- ✅ GitHub Actions CI/CD (Gitleaks + CodeQL + security checks + deploy)
- ✅ Health monitor + self-heal scripts
- 🔲 Matching algorithm (route exists, logic TBD for edge cases)
- 🔲 In-app messaging between matched users
- 🔲 Admin dashboard fully functional in UI
- 🔲 pnpm workspace updated for new deps (currently npm-based)

## TECH STACK
| Layer | Technology |
|-------|-----------|
| Workspace | npm (was pnpm, update if reverting to monorepo) |
| Frontend | React 18 + TypeScript + Vite + shadcn/ui + Tailwind v4 |
| State | Zustand (auth) + React Query (server state) |
| Maps | Leaflet (CDN-loaded, no API key needed) |
| Routing | wouter |
| Backend | Node.js + Express 4.x (CommonJS) |
| AI | Anthropic Claude SDK (`@anthropic-ai/sdk`) |
| SMS/Voice | Twilio (OTP + voice calls) |
| Auth | JWT (`jsonwebtoken`) + Twilio OTP |
| Database | Supabase PostgreSQL (via @supabase/supabase-js) |
| Payments | Stripe + Flutterwave + Africa's Talking |
| Hosting | Vercel (frontend CDN + API serverless function) |
| CI/CD | GitHub Actions (Gitleaks + CodeQL + security scan + Vercel deploy) |

## PROJECT STRUCTURE
```
BridgeUp2.1/
├── vercel.json                    # Vercel deployment config
├── api/server.js                  # Vercel serverless entrypoint
├── database/schema.sql            # Supabase PostgreSQL schema + RLS
├── .env.example                   # Env var template (no secrets)
├── .github/workflows/deploy.yml   # CI/CD pipeline
├── scripts/
│   ├── security-check.sh          # Pre-deploy security scan
│   ├── health-monitor.sh          # Runtime health + self-heal
│   └── pre-commit-hook.sh         # Git pre-commit hook
└── artifacts/bridgeup/
    ├── server/                    # Express backend (CommonJS)
    │   ├── index.js               # Entry point
    │   ├── routes/                # auth, needs, matching, helpers,
    │   │                          # payments, reports, sms, voice, admin
    │   └── services/
    │       ├── supabase.js        # ← NEW: replaces firebase.js
    │       ├── claude.js          # AI service (claude-sonnet)
    │       ├── twilio.js          # SMS/OTP (now uses Supabase)
    │       └── scheduler.js       # cron reports
    ├── src/                       # React frontend (TypeScript)
    │   ├── App.tsx                # Router + providers
    │   ├── lib/api.ts             # API client + type definitions
    │   ├── store/auth.ts          # Zustand auth store
    │   ├── pages/
    │   │   ├── auth/              # AuthPhone, AuthOtp
    │   │   ├── home/              # Home (map + bottom sheet)
    │   │   ├── post-need/         # PostNeed (4-step flow)
    │   │   ├── intake/            # IntakeChat (AI conversation)
    │   │   ├── needs/             # MyNeeds, NeedDetail
    │   │   ├── matches/           # Matches, MatchDetail
    │   │   ├── profile/           # Profile (edit + logout)
    │   │   └── admin/             # AdminDashboard
    │   └── components/
    │       ├── layout/            # AppShell (bottom nav)
    │       ├── map/               # MapView (Leaflet)
    │       ├── needs/             # NeedCard
    │       └── ui/                # 46 shadcn/ui components
    ├── index.html                 # App shell (Leaflet CDN loaded here)
    ├── vite.config.ts             # No Replit deps
    └── package.json               # All frontend + backend deps
```

## COMMANDS
```bash
# Install
cd artifacts/bridgeup && npm install

# Development (run both in separate terminals)
npm run dev:server    # Express API on port 3000
npm run dev:client    # Vite React on port 5173

# Production build
npm run build         # Builds React to dist/public/

# Type check
npm run typecheck

# Security check (run before every commit)
bash scripts/security-check.sh

# Install pre-commit hook
cp scripts/pre-commit-hook.sh .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit

# Health monitor
bash scripts/health-monitor.sh https://your-app.vercel.app
```

## ENVIRONMENT VARIABLES (set in Vercel dashboard — never commit)
| Variable | Purpose | Required |
|----------|---------|----------|
| `SUPABASE_URL` | Supabase project URL | YES |
| `SUPABASE_SERVICE_KEY` | Supabase service role key | YES |
| `SESSION_SECRET` | JWT signing secret (min 32 chars) | YES |
| `ANTHROPIC_API_KEY` | Claude AI API key | YES |
| `TWILIO_ACCOUNT_SID` | Twilio account ID | YES |
| `TWILIO_AUTH_TOKEN` | Twilio auth token | YES |
| `TWILIO_PHONE_NUMBER` | Default outbound SMS number | YES |
| `TWILIO_CANADA_NUMBER` | Canada/USA SMS number | No |
| `TWILIO_RWANDA_NUMBER` | Rwanda SMS number | No |
| `TWILIO_KENYA_NUMBER` | Kenya SMS number | No |
| `STRIPE_SECRET_KEY` | Stripe secret key | No |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret | No |
| `FLW_PUBLIC_KEY` | Flutterwave public key | No |
| `FLW_SECRET_KEY` | Flutterwave secret key | No |
| `AFRICASTALKING_USERNAME` | Africa's Talking username | No |
| `AFRICASTALKING_API_KEY` | Africa's Talking API key | No |
| `SMTP_HOST` | Email SMTP host (Resend) | No |
| `SMTP_PASS` | Email SMTP password | No |
| `FRONTEND_URL` | Frontend URL for CORS whitelist | YES |
| `NODE_ENV` | `production` | YES (Vercel auto-sets) |

## MIGRATION FROM FIREBASE TO SUPABASE
1. Create a Supabase project at supabase.com
2. Run `database/schema.sql` in the Supabase SQL editor
3. Get your project URL and service role key from Settings → API
4. Set SUPABASE_URL and SUPABASE_SERVICE_KEY in Vercel env vars
5. Deploy — the firebase.js service is no longer used

## KNOWN ISSUES & SOLUTIONS

### Supabase service key not set
```
[Supabase] FATAL: SUPABASE_URL and SUPABASE_SERVICE_KEY must be set.
```
Solution: Add to Vercel dashboard Environment Variables and redeploy.

### JWT not sent in requests
Always use `sessionStorage.getItem('bridgeup_token')` — not localStorage.
Frontend auth store (`store/auth.ts`) handles this automatically.

### Map not showing
Leaflet is loaded via CDN in `index.html`. The script tag must load before React mounts.
If map tiles aren't loading, verify the Leaflet CDN URLs are accessible.

### Vite dev proxy
Vite proxies /api, /voice, /sms to localhost:3000.
Run both `npm run dev:server` and `npm run dev:client` simultaneously.

## API ROUTES
| Method | Route | Auth | Purpose |
|--------|-------|------|---------|
| POST | `/api/auth/send-otp` | None | Send OTP via Twilio |
| POST | `/api/auth/verify-otp` | None | Verify OTP, return JWT |
| GET | `/api/auth/me` | JWT | Get current user |
| PATCH | `/api/auth/me` | JWT | Update profile |
| POST | `/api/auth/logout` | JWT | Invalidate JWT |
| POST | `/api/needs` | Optional | Post a need |
| POST | `/api/needs/intake/message` | None | AI intake conversation |
| GET | `/api/needs/my` | JWT | User's own needs |
| GET | `/api/needs` | JWT | Browse needs |
| GET | `/api/needs/:id` | JWT | Single need |
| PATCH | `/api/needs/:id/status` | JWT | Update status |
| POST | `/api/matching/trigger` | Admin | Run matching |
| GET | `/api/matching/matches` | JWT | List matches |
| PATCH | `/api/matching/matches/:id/accept` | JWT | Accept match |
| PATCH | `/api/matching/matches/:id/decline` | JWT | Decline match |
| GET | `/api/admin/dashboard` | Admin | KPI dashboard |
| GET | `/api/admin/system-health` | Superadmin | Service health |
| POST | `/api/admin/ai-assistant` | Admin | AI Q&A |

## SECURITY — BRIDGEUP SPECIFIC
- Phone numbers are PII — never log or expose full phone numbers
- JWT tokens stored in `sessionStorage` (cleared on tab close)
- Token revocation checked on every protected request via Supabase
- OTP codes generated with `crypto.randomInt()` (not Math.random)
- Rate limits: OTP 3/hour, needs 10/day, auth 10/15min, general 100/min
- CORS restricted to known Vercel origins
- Supabase RLS: all tables restricted to service_role only
- No client-side DB access — all queries via server-side Express API

## VERCEL DEPLOYMENT
1. Import GitHub repo to Vercel
2. Set all env vars in Vercel dashboard (not in .env!)
3. Set Build Command: `cd artifacts/bridgeup && npm run build`
4. Set Output Directory: `artifacts/bridgeup/dist/public`
5. Push to main → auto-deploys after security scan passes

## GITHUB SECRETS REQUIRED FOR CI/CD
Add in GitHub → Settings → Secrets → Actions:
- `VERCEL_TOKEN` — Vercel dashboard → Settings → Tokens
- `VERCEL_ORG_ID` — Vercel dashboard → Settings → General → Team ID
- `VERCEL_PROJECT_ID` — Vercel project → Settings → General
- `SITE_URL` — Production URL for smoke tests

## BEFORE STARTING ANY SESSION
1. Check STATUS section above
2. `git log --oneline -5` — see last completed work
3. Verify .env is not tracked: `git ls-files | grep ".env"`
4. Check health: `curl https://your-app.vercel.app/api/health`
