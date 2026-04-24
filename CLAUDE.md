# BridgeUp — Project CLAUDE.md
# File location: /path/to/BridgeUp2.1/CLAUDE.md
# Check this into git so it travels with the project

## PROJECT OVERVIEW
BridgeUp is a human needs matching platform. People post needs (food, shelter, skills, services)
and the platform matches them with people/organizations that can help.

See @README.md for full project overview.
See @package.json for available npm commands.

## CURRENT STATUS (update this as features complete)
- ✅ Express server on Replit port 3000
- ✅ Onboarding screens (3 slides)
- ✅ Twilio SMS OTP working
- ✅ JWT authentication
- ✅ localStorage onboarding flag (bridgeup_onboarded)
- ⚠️  Firestore — intermittently working, preferRest: true required
- 🔲 User profile completion
- 🔲 Need posting feature
- 🔲 Matching algorithm
- 🔲 Chat/messaging between matched users

## TECH STACK
- **Runtime**: Node.js (Replit)
- **Backend**: Express.js
- **Auth**: JWT (jsonwebtoken), Twilio SMS OTP
- **Database**: Firebase Firestore (project: bridgeup-production, region: us-central1)
- **Frontend**: Vanilla HTML/CSS/JS (no framework)
- **Hosting**: Replit (external URL via exposeLocalhost)
- **Version Control**: GitHub (https://github.com/MikeGira/BridgeUp2.1)

## KEY FILE LOCATIONS
- Server entry: `artifacts/bridgeup/server/index.js`
- Firebase config: `artifacts/bridgeup/server/services/firebase.js`
- Twilio config: `artifacts/bridgeup/server/services/twilio.js`
- Frontend app: `artifacts/bridgeup/public/js/app.js`
- Analytics: `artifacts/bridgeup/analytics.html`

## ENVIRONMENT VARIABLES REQUIRED
(Set in Replit Secrets — never commit these)
- FIREBASE_PROJECT_ID
- FIREBASE_CLIENT_EMAIL
- FIREBASE_PRIVATE_KEY
- TWILIO_ACCOUNT_SID
- TWILIO_AUTH_TOKEN
- TWILIO_PHONE_NUMBER
- JWT_SECRET

## KNOWN ISSUES & SOLUTIONS
1. **Firestore NOT_FOUND**: Use `preferRest: true` in db.settings. Project ID must be 'bridgeup-production'.
2. **exposeLocalhost**: Must be in .replit or external URL stops serving JS/CSS. Replit support may remove it — always restore.
3. **OTP flow bug**: After OTP verify, must set `localStorage.setItem('bridgeup_onboarded', '1')` or app loops to onboarding.
4. **Analytics refresh button**: Use `addEventListener('click', () => loadData())` not `addEventListener('click', loadData)` — the latter passes MouseEvent as the token argument.

## API ENDPOINTS
- POST /api/auth/send-otp — Send SMS OTP
- POST /api/auth/verify-otp — Verify OTP, returns JWT
- GET /api/auth/me — Get current user (requires JWT)
- POST /api/leads — Public lead capture

## REPLIT CRITICAL CONFIG
```
[[ports]]
localPort = 3000
externalPort = 80
exposeLocalhost = true
```
External URL: https://68a98579-e15d-4c7f-8607-639f8c819139-00-3unl4nd6gzjnr.worf.replit.dev

## SECURITY — BRIDGEUP SPECIFIC
Always load the security skill. BridgeUp-specific requirements:

### Critical Because BridgeUp Handles Vulnerable People
BridgeUp users may be in crisis (food insecurity, housing instability). A security breach
could expose them to predators, scammers, or retaliation. Security here is a human safety issue.

### Phone Number Protection
- Phone numbers are PII — never log them in full (`maskPhone()` before any log)
- Store phone numbers hashed in Firestore for lookup, not plaintext
- OTP codes: use `crypto.randomInt()`, hash before storing, delete immediately after verification
- Never expose one user's phone number to another user

### Firestore Rules Must Be Deployed (not in test mode)
```
users/{userId} — owner read/write only
posts/{postId} — authenticated read, owner write/delete
matches/{matchId} — both matched parties read, server write only
otps/{phone} — server only (allow read, write: if false)
```

### JWT Configuration for BridgeUp
- Access token: 15 minutes expiry
- Refresh token: 7 days, stored in HttpOnly cookie (not localStorage)
- Rotate refresh tokens on each use

### Rate Limits for BridgeUp
- OTP send: 3 per phone number per hour
- OTP verify: 5 attempts per code, then invalidate
- API general: 100 requests per 15 minutes per IP
- Post creation: 10 new posts per day per user

## BEFORE STARTING ANY SESSION
1. Check the status section above for current progress
2. Run `tail -20 /tmp/bridgeup.log` to see recent server logs
3. Run `git log --oneline -5` to see recent commits
