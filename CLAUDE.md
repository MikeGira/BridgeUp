# BridgeUp — Project CLAUDE.md

## WHAT IS BRIDGEUP
An AI-powered human needs operating system. People post needs (food, shelter, skills, jobs, services, training) and get matched with verified helpers and organizations. Target communities: underserved populations in Canada and Rwanda/Africa.

## CURRENT STATUS (update as features complete)
- ✅ Express server (port 3000) with Helmet + CORS + rate limiting
- ✅ Firebase Admin + Firestore (preferRest: true required)
- ✅ AfricasTalking SMS + Voice OTP auth
- ✅ JWT authentication
- ✅ React frontend (Vite + shadcn/ui)
- ✅ Anthropic Claude SDK integrated (services/claude.js)
- ✅ Stripe + Flutterwave payment routes wired
- ✅ node-cron scheduler
- ✅ PDF generation (pdfkit), file uploads (multer)
- 🔲 Matching algorithm (route exists, logic TBD)
- 🔲 In-app messaging between matched users
- 🔲 Admin dashboard fully functional

## TECH STACK
| Layer | Technology |
|-------|-----------|
| Workspace | pnpm monorepo |
| Frontend | React + TypeScript + Vite + shadcn/ui |
| Backend | Node.js + Express 4.x (CommonJS) |
| AI | Anthropic Claude SDK (`@anthropic-ai/sdk`) |
| SMS/Voice | AfricasTalking (OTP + voice calls) |
| Auth | JWT (`jsonwebtoken`) + AfricasTalking OTP |
| Database | Firebase Admin + Firestore |
| Payments | Stripe + Flutterwave |
| Other | node-cron, nodemailer, pdfkit, multer |
| Hosting | Replit (exposeLocalhost required) |

## PROJECT STRUCTURE
```
BridgeUp2.1/
├── package.json                  # pnpm workspace root
├── pnpm-workspace.yaml
├── tsconfig.json
├── artifacts/
│   ├── bridgeup/
│   │   ├── server/
│   │   │   ├── index.js          # Express entry point
│   │   │   ├── routes/           # auth, needs, helpers, matching,
│   │   │   │                     # payments, reports, reviews, sms,
│   │   │   │                     # voice, admin
│   │   │   └── services/         # claude.js, firebase.js,
│   │   │                         # scheduler.js, voice-service.js
│   │   ├── src/                  # React frontend
│   │   │   ├── App.tsx
│   │   │   ├── pages/
│   │   │   ├── components/
│   │   │   └── hooks/
│   │   └── vite.config.ts
│   └── api-server/               # Secondary API server
└── CLAUDE.md
```

## COMMANDS
```bash
pnpm install          # install all workspace deps
pnpm start            # start backend server
pnpm run typecheck    # TypeScript type check
pnpm run build        # build all packages

# Frontend dev server
cd artifacts/bridgeup && npx vite
```

## ENVIRONMENT VARIABLES
(Set in Replit Secrets — never commit)

| Variable | Purpose |
|----------|---------|
| `FIREBASE_SERVICE_ACCOUNT` | Full service account JSON (stringified) |
| `FIREBASE_STORAGE_BUCKET` | Firebase Storage bucket name |
| `AFRICASTALKING_API_KEY` | AfricasTalking API key |
| `AFRICASTALKING_USERNAME` | AfricasTalking username |
| `AFRICASTALKING_SENDER_ID` | SMS sender ID |
| `ANTHROPIC_API_KEY` | Claude AI API key |
| `JWT_SECRET` | JWT signing secret (min 32 chars) |
| `STRIPE_SECRET_KEY` | Stripe secret key |
| `FLUTTERWAVE_SECRET_KEY` | Flutterwave secret key |
| `FRONTEND_URL` | Frontend URL for CORS whitelist |
| `NODE_ENV` | `production` or `development` |

## KNOWN ISSUES & SOLUTIONS

### Firestore NOT_FOUND
```javascript
// services/firebase.js — must always have this
db.settings({ preferRest: true });
```

### Frontend not loading CSS/JS from external URL
`.replit` must always contain — do not remove, Replit support sometimes strips it:
```toml
[[ports]]
localPort = 3000
externalPort = 80
exposeLocalhost = true
```

### AfricasTalking OTP not sending
- Verify `AFRICASTALKING_USERNAME` and `AFRICASTALKING_API_KEY` are in Replit Secrets
- Sandbox mode only delivers to verified numbers — use live credentials for production
- Check AfricasTalking dashboard delivery reports for the exact error

### JWT not sent in requests
Always use `sessionStorage.getItem('bridgeup_token')` — not localStorage.

### Event listener passing MouseEvent as argument
Wrap all event handlers: `addEventListener('click', () => fn())` not `addEventListener('click', fn)`.

## API ROUTES
| Method | Route | Auth | Purpose |
|--------|-------|------|---------|
| POST | `/api/auth/send-otp` | None | Send OTP via AfricasTalking |
| POST | `/api/auth/verify-otp` | None | Verify OTP, return JWT |
| GET | `/api/auth/me` | JWT | Get current user |
| POST | `/api/needs` | JWT | Post a need |
| GET | `/api/needs` | JWT | Browse needs |
| POST | `/api/matching` | JWT | Run matching |
| GET | `/api/helpers` | JWT | Browse helpers |
| POST | `/api/payments` | JWT | Create payment |
| GET | `/api/reports` | Admin | Generate reports |
| POST | `/api/sms` | Admin | Send SMS notification |
| POST | `/api/voice` | Admin | Initiate voice call |

## SECURITY — BRIDGEUP SPECIFIC

BridgeUp users may be in crisis. A breach could expose someone's location to an abuser or a vulnerable person to a scammer. Security is a human safety issue here, not just technical.

### Phone Number Protection
- Phone numbers are PII — always use `maskPhone()` before any log output
- OTP codes: `crypto.randomInt()` only, hash with bcrypt before storing, delete after verification
- Never expose one user's phone number to another user

### Firestore Rules (deploy these — never leave in test/open mode)
```
users/{userId}     — owner read/write only
needs/{needId}     — authenticated read, owner write/delete
matches/{matchId}  — both matched parties read, server write only
otps/{phone}       — server only (allow read, write: if false)
payments/{payId}   — server only
```

### JWT Config
- Access token: 15 min expiry
- Refresh token: 7 days, HttpOnly cookie (not localStorage)

### Rate Limits
- OTP send: 3 per phone per hour
- OTP verify: 5 attempts then invalidate
- General API: 100 requests / 15 min / IP

## BEFORE STARTING ANY SESSION
1. Check STATUS section above
2. `git log --oneline -5` — see what was last completed
3. `tail -20 /tmp/bridgeup.log` — check server logs
4. Verify `.replit` still has `exposeLocalhost = true`
