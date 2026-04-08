'use strict';

/**
 * Payments Route — BridgeUp multi-processor payment system
 *
 * Mounted at four paths in index.js:
 *   /api/payments         → GET  /subscription
 *                         → POST /stripe/create-session
 *                         → POST /mobilemoney/initiate
 *                         → POST /flutterwave/initiate
 *   /stripe               → POST /webhook  (Stripe)
 *   /africastalking       → POST /webhook  (Africa's Talking)
 *   /flutterwave          → POST /webhook  (Flutterwave)
 *
 * Processor routing (enforced server-side by country):
 *   Canada / USA          → Stripe (credit/debit card)
 *   Rwanda, KE, TZ, UG, NG, GH → Africa's Talking (MTN / Airtel mobile money)
 *   Other Africa          → Flutterwave (hosted checkout)
 *
 * Security posture:
 *   - Stripe webhook verified with stripe.webhooks.constructEvent (HMAC-SHA256, raw body)
 *   - Flutterwave webhook verified with crypto.timingSafeEqual on verif-hash header
 *   - Africa's Talking webhook verified with crypto.timingSafeEqual on pre-shared token
 *   - All plan amounts are set server-side — client-submitted prices are never read
 *   - Phone numbers are logged and stored as last-4 only (phoneLast4)
 *   - SDK clients are lazy-initialised: missing env vars return 503, not a server crash
 *   - Flutterwave payments are double-verified via Transaction.verify before Firestore write
 */

const express   = require('express');
const crypto    = require('crypto');
const rateLimit = require('express-rate-limit');

const {
  db, FieldValue, COLLECTIONS, writeAuditLog,
} = require('../services/firebase');
const { requireAuth } = require('./auth');
const { sendSMS }     = require('../services/twilio');

const router = express.Router();

// ─── Lazy SDK getters ──────────────────────────────────────────────────────────
// Initialised on first call so a missing env var returns 503 instead of
// crashing the entire server process at boot time.

let _stripe = null;
function getStripe() {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY is not configured.');
    _stripe = require('stripe')(key);
  }
  return _stripe;
}

let _atPayments = null;
function getATPayments() {
  if (!_atPayments) {
    const apiKey   = process.env.AFRICASTALKING_API_KEY;
    const username = process.env.AFRICASTALKING_USERNAME;
    if (!apiKey || !username) {
      throw new Error('AFRICASTALKING_API_KEY or AFRICASTALKING_USERNAME is not configured.');
    }
    const AfricasTalking = require('africastalking');
    _atPayments = AfricasTalking({ apiKey, username }).PAYMENTS;
  }
  return _atPayments;
}

let _flw = null;
function getFlw() {
  if (!_flw) {
    const pub = process.env.FLW_PUBLIC_KEY;
    const sec = process.env.FLW_SECRET_KEY;
    if (!pub || !sec) throw new Error('FLW_PUBLIC_KEY or FLW_SECRET_KEY is not configured.');
    const Flutterwave = require('flutterwave-node-v3');
    _flw = new Flutterwave(pub, sec);
  }
  return _flw;
}

// ─── Rate limiters ─────────────────────────────────────────────────────────────

// Webhook limiter — generous; covers bursts from payment processors.
// Note: webhook paths (/stripe, /africastalking, /flutterwave) are NOT under /api/,
// so the global generalLimiter does NOT apply. This is the only IP-level guard here.
const webhookLimiter = rateLimit({
  windowMs:        60 * 1000,
  max:             300,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'Webhook rate limit exceeded.' },
});

// Stripe session creation — prevents session-spam (each creates a Stripe resource)
const sessionLimiter = rateLimit({
  windowMs:        60 * 1000,
  max:             10,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'Too many payment session requests. Please slow down.' },
});

// Mobile-money initiation — tight limit: STK push is real-time and can charge the
// subscriber's balance on some networks before they approve.
const momoLimiter = rateLimit({
  windowMs:        60 * 1000,
  max:             5,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'Too many payment requests. Please wait before trying again.' },
});

// ─── Plan prices (server-side only) ───────────────────────────────────────────
// Client-submitted amounts are NEVER read. These values are the single source of
// truth for all three processors.

const PLAN_PRICES_USD = {
  pro:        { monthly: 29,  yearly: 290  },
  ngo:        { monthly: 99,  yearly: 990  },
  enterprise: { monthly: 299, yearly: 2990 },
};

const PAID_PLANS     = Object.keys(PLAN_PRICES_USD);
const VALID_INTERVALS = ['monthly', 'yearly'];

// Stripe Price IDs stored in env vars; never hardcoded.
// Format: STRIPE_PRICE_PRO_MONTHLY, STRIPE_PRICE_PRO_YEARLY, etc.
function getStripePriceId(plan, interval) {
  return process.env[`STRIPE_PRICE_${plan.toUpperCase()}_${interval.toUpperCase()}`] || null;
}

// ─── Country / currency helpers ────────────────────────────────────────────────

// Maps international dialling prefix → Africa's Talking country + currency info
const AT_PHONE_PREFIX_MAP = {
  '+250': { country: 'RW', currency: 'RWF' },
  '+254': { country: 'KE', currency: 'KES' },
  '+255': { country: 'TZ', currency: 'TZS' },
  '+256': { country: 'UG', currency: 'UGX' },
  '+234': { country: 'NG', currency: 'NGN' },
  '+233': { country: 'GH', currency: 'GHS' },
};

// Approximate USD → local FX rates.
// Update regularly in production (ideally via a live FX API).
const FX_RATES = {
  RWF: 1380, KES: 130,  TZS: 2700, UGX: 3700,
  NGN: 1600, GHS: 15,   ZAR: 19,   XOF: 620,
  GBP: 0.79, EUR: 0.92, CAD: 1.37,
};

// E.164 phone pattern
const PHONE_PATTERN = /^\+[1-9]\d{7,14}$/;

// Firestore document ID pattern (alphanumeric, 10–128 chars)
const DOC_ID_PATTERN = /^[a-zA-Z0-9]{10,128}$/;

// FLW numeric transaction ID (up to 20 digits)
const FLW_TX_ID_PATTERN = /^\d{1,20}$/;

/**
 * Returns the AT phone prefix entry for a given E.164 number,
 * or null if the number does not match any supported AT country.
 */
function getATCountryInfo(phone) {
  for (const [prefix, info] of Object.entries(AT_PHONE_PREFIX_MAP)) {
    if (String(phone).startsWith(prefix)) return info;
  }
  return null;
}

/**
 * Converts a USD amount to local currency using the FX_RATES table.
 * Throws if the currency has no configured rate.
 */
function usdToLocal(amountUSD, currency) {
  const rate = FX_RATES[currency];
  if (!rate) throw new Error(`No FX rate configured for currency: ${currency}`);
  return Math.round(amountUSD * rate);
}

// ─── Timing-safe comparison ────────────────────────────────────────────────────

/**
 * Compares two strings in constant time to prevent timing-based secret extraction.
 * Always executes the same number of operations regardless of where strings differ.
 */
function timingSafeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // Lengths must match for timingSafeEqual; we must still call it to avoid
  // leaking length information via timing, so compare against itself if unequal.
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA); // constant-time no-op
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// ─── Firestore lookup helpers ──────────────────────────────────────────────────

/**
 * Looks up a tenant document ID by its Stripe customer ID.
 * Fallback for events whose metadata doesn't carry tenantId directly.
 */
async function getTenantByStripeCustomer(customerId) {
  if (!customerId || typeof customerId !== 'string') return null;
  const snap = await db.collection(COLLECTIONS.TENANTS)
    .where('stripeCustomerId', '==', customerId)
    .limit(1)
    .get();
  return snap.empty ? null : snap.docs[0].id;
}

/**
 * Extracts tenantId from a structured transaction reference.
 * Convention: `bridgeup_{tenantId}_{plan}_{interval}_{timestamp}`
 * Validates the extracted tenantId looks like a Firestore document ID.
 */
function extractTenantFromTxRef(txRef) {
  if (!txRef || typeof txRef !== 'string') return null;
  const parts = txRef.split('_');
  if (parts[0] !== 'bridgeup' || !parts[1]) return null;
  if (!DOC_ID_PATTERN.test(parts[1])) return null;
  return parts[1];
}

/**
 * Builds a deterministic transaction reference string that encodes context
 * so the webhook handler can recover tenantId / plan / interval without a
 * separate database lookup.
 */
function buildTxRef(tenantId, plan, interval) {
  return `bridgeup_${tenantId}_${plan}_${interval}_${Date.now()}`;
}

/**
 * Finds the first admin user for a tenant.
 * Used to send payment-event SMS notifications to the right person.
 * Returns null silently on error — payment processing must not fail over this.
 */
async function findTenantAdmin(tenantId) {
  try {
    const snap = await db.collection(COLLECTIONS.USERS)
      .where('tenantId', '==', tenantId)
      .where('role',     '==', 'admin')
      .limit(1)
      .get();
    if (snap.empty) return null;
    const d = snap.docs[0].data();
    return {
      phone:    d.phone    || null,
      language: d.language || 'en',
      name:     d.name     || 'Admin',
    };
  } catch (err) {
    console.error('[Payments] findTenantAdmin error:', err.message);
    return null;
  }
}

// ─── SMS message builders ──────────────────────────────────────────────────────

function buildPaymentSuccessSMS(language, plan) {
  const p = String(plan || 'Pro').replace(/[\r\n\t]/g, ' ').slice(0, 30);
  const t = {
    en: `BridgeUp: Your ${p} plan is now active. Thank you for your payment.`,
    rw: `BridgeUp: Gahunda yawe ya ${p} ni iyambere ubu. Urakoze kwishyura.`,
    sw: `BridgeUp: Mpango wako wa ${p} sasa uko hai. Asante kwa malipo yako.`,
    fr: `BridgeUp: Votre plan ${p} est maintenant actif. Merci pour votre paiement.`,
    ar: `BridgeUp: خطتك ${p} نشطة الآن. شكراً على دفعك.`,
  };
  return t[language] || t.en;
}

function buildPaymentFailedSMS(language) {
  const t = {
    en: `BridgeUp: Your latest payment failed. Please update your payment method to keep your account active.`,
    rw: `BridgeUp: Kwishyura kwawe ntibyakunze. Vugurura uburyo bwo kwishyura kugirango konti ikomeze.`,
    sw: `BridgeUp: Malipo yako yameshindwa. Tafadhali sasisha njia yako ya malipo.`,
    fr: `BridgeUp: Votre dernier paiement a échoué. Veuillez mettre à jour votre moyen de paiement.`,
    ar: `BridgeUp: فشل آخر دفع. يرجى تحديث طريقة الدفع للحفاظ على نشاط حسابك.`,
  };
  return t[language] || t.en;
}

function buildCancellationSMS(language) {
  const t = {
    en: `BridgeUp: Your subscription has been cancelled. You have been moved to the free Community plan.`,
    rw: `BridgeUp: Kwiyandikisha kwawe guhagaritswe. Wagizwe ku gahunda ya Community buntu.`,
    sw: `BridgeUp: Usajili wako umefutwa. Umehamisishwa kwenye mpango wa Community bure.`,
    fr: `BridgeUp: Votre abonnement a été annulé. Vous êtes passé au plan Communauté (gratuit).`,
    ar: `BridgeUp: تم إلغاء اشتراكك. تم نقلك إلى الخطة المجتمعية المجانية.`,
  };
  return t[language] || t.en;
}

function buildMoMoSuccessSMS(language, plan) {
  const p = String(plan || 'Pro').replace(/[\r\n\t]/g, ' ').slice(0, 30);
  const t = {
    en: `BridgeUp: Mobile money payment received. Your ${p} plan is now active.`,
    rw: `BridgeUp: Amafaranga ya mobile money yabonywe. Gahunda yawe ya ${p} irabaho ubu.`,
    sw: `BridgeUp: Malipo ya pesa ya rununu yamepokelewa. Mpango wako wa ${p} uko hai.`,
    fr: `BridgeUp: Paiement mobile reçu. Votre plan ${p} est maintenant actif.`,
    ar: `BridgeUp: تم استلام دفعة المحمول. خطتك ${p} نشطة الآن.`,
  };
  return t[language] || t.en;
}

// ─── Stripe event processor ────────────────────────────────────────────────────

/**
 * Handles a verified Stripe event. Called fire-and-forget after the HTTP 200
 * response is already sent to Stripe.
 *
 * @param {import('stripe').Stripe.Event} event
 */
async function processStripeEvent(event) {
  switch (event.type) {

    // ── checkout.session.completed ────────────────────────────────────────────
    // Fired once when a new subscription is successfully purchased.
    case 'checkout.session.completed': {
      const session  = event.data.object;
      const tenantId = session.metadata?.tenantId;
      const plan     = session.metadata?.plan     || 'pro';
      const interval = session.metadata?.interval || 'monthly';

      if (!tenantId) {
        console.warn('[Payments/Stripe] checkout.session.completed: no tenantId in session metadata — skipping');
        return;
      }

      await db.collection(COLLECTIONS.TENANTS).doc(tenantId).update({
        plan,
        planInterval:         interval,
        subscriptionStatus:   'active',
        stripeCustomerId:     session.customer    || null,
        stripeSubscriptionId: session.subscription || null,
        cancelledAt:          null,
        updatedAt:            FieldValue.serverTimestamp(),
      });

      await db.collection(COLLECTIONS.PAYMENTS).add({
        tenantId,
        processor:        'stripe',
        amount:           session.amount_total || 0,
        currency:         (session.currency || 'usd').toUpperCase(),
        plan,
        interval,
        status:           'completed',
        stripeSessionId:  session.id,
        stripeCustomerId: session.customer || null,
        createdAt:        FieldValue.serverTimestamp(),
      });

      const admin = await findTenantAdmin(tenantId);
      if (admin?.phone) {
        sendSMS(admin.phone, buildPaymentSuccessSMS(admin.language, plan))
          .catch(err =>
            console.error(`[Payments/Stripe] Success SMS failed to ***${String(admin.phone).slice(-4)}:`, err.message)
          );
      }

      writeAuditLog({
        action:   'subscription_activated',
        actorId:  `stripe:${session.customer || 'unknown'}`,
        targetId: tenantId,
        meta:     { plan, interval, stripeSessionId: session.id },
      }).catch(() => {});

      break;
    }

    // ── invoice.payment_succeeded ─────────────────────────────────────────────
    // Fired on every successful recurring renewal.
    case 'invoice.payment_succeeded': {
      const invoice  = event.data.object;
      // Metadata may be on the subscription or the invoice depending on Stripe version
      let tenantId = invoice.subscription_details?.metadata?.tenantId
                  || invoice.metadata?.tenantId;
      if (!tenantId) tenantId = await getTenantByStripeCustomer(invoice.customer);
      if (!tenantId) {
        console.warn('[Payments/Stripe] invoice.payment_succeeded: cannot resolve tenantId — skipping');
        return;
      }

      const periodEnd = invoice.lines?.data?.[0]?.period?.end;

      await db.collection(COLLECTIONS.TENANTS).doc(tenantId).update({
        subscriptionStatus: 'active',
        ...(periodEnd ? { currentPeriodEnd: new Date(periodEnd * 1000) } : {}),
        updatedAt: FieldValue.serverTimestamp(),
      });

      await db.collection(COLLECTIONS.PAYMENTS).add({
        tenantId,
        processor:        'stripe',
        amount:           invoice.amount_paid || 0,
        currency:         (invoice.currency || 'usd').toUpperCase(),
        status:           'renewal_succeeded',
        stripeInvoiceId:  invoice.id,
        stripeCustomerId: invoice.customer,
        createdAt:        FieldValue.serverTimestamp(),
      });

      break;
    }

    // ── invoice.payment_failed ────────────────────────────────────────────────
    // A renewal charge failed — flag the account and alert the admin.
    case 'invoice.payment_failed': {
      const invoice  = event.data.object;
      let tenantId   = invoice.metadata?.tenantId;
      if (!tenantId) tenantId = await getTenantByStripeCustomer(invoice.customer);
      if (!tenantId) {
        console.warn('[Payments/Stripe] invoice.payment_failed: cannot resolve tenantId — skipping');
        return;
      }

      await db.collection(COLLECTIONS.TENANTS).doc(tenantId).update({
        subscriptionStatus: 'payment_failed',
        updatedAt:          FieldValue.serverTimestamp(),
      });

      const admin = await findTenantAdmin(tenantId);
      if (admin?.phone) {
        sendSMS(admin.phone, buildPaymentFailedSMS(admin.language))
          .catch(err =>
            console.error(`[Payments/Stripe] Payment-failed SMS to ***${String(admin.phone).slice(-4)}:`, err.message)
          );
      }

      writeAuditLog({
        action:   'subscription_payment_failed',
        actorId:  `stripe:${invoice.customer}`,
        targetId: tenantId,
        meta:     { invoiceId: invoice.id, attemptCount: invoice.attempt_count },
      }).catch(() => {});

      break;
    }

    // ── customer.subscription.deleted ────────────────────────────────────────
    // Subscription cancelled — downgrade to Community (free) tier.
    case 'customer.subscription.deleted': {
      const sub     = event.data.object;
      let tenantId  = sub.metadata?.tenantId;
      if (!tenantId) tenantId = await getTenantByStripeCustomer(sub.customer);
      if (!tenantId) {
        console.warn('[Payments/Stripe] customer.subscription.deleted: cannot resolve tenantId — skipping');
        return;
      }

      await db.collection(COLLECTIONS.TENANTS).doc(tenantId).update({
        plan:                 'community',
        planInterval:         null,
        subscriptionStatus:   'cancelled',
        stripeSubscriptionId: null,
        cancelledAt:          FieldValue.serverTimestamp(),
        updatedAt:            FieldValue.serverTimestamp(),
      });

      const admin = await findTenantAdmin(tenantId);
      if (admin?.phone) {
        sendSMS(admin.phone, buildCancellationSMS(admin.language))
          .catch(err =>
            console.error(`[Payments/Stripe] Cancellation SMS to ***${String(admin.phone).slice(-4)}:`, err.message)
          );
      }

      writeAuditLog({
        action:   'subscription_cancelled',
        actorId:  `stripe:${sub.customer}`,
        targetId: tenantId,
        meta:     { stripeSubscriptionId: sub.id },
      }).catch(() => {});

      break;
    }

    default:
      // Silently acknowledge events we don't handle — Stripe requires 200 regardless
      console.log(`[Payments/Stripe] Unhandled event type: ${event.type} — acknowledged`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 1 — POST /webhook
// Handles all three processor webhooks. Differentiated by req.baseUrl.
// All three paths capture raw body in index.js before express.json() runs, so
// req.rawBody is a Buffer and req.body is NOT populated on these paths.
// ─────────────────────────────────────────────────────────────────────────────

router.post('/webhook', webhookLimiter, async (req, res) => {
  const processor = req.baseUrl; // '/stripe' | '/africastalking' | '/flutterwave'

  // ════════════════════════════════════════════════════════════════════════════
  // Stripe
  // ════════════════════════════════════════════════════════════════════════════
  if (processor === '/stripe') {
    const sig           = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    // Guard 1 — raw body must exist (populated by raw-body middleware in index.js)
    if (!req.rawBody) {
      console.error('[Payments/Stripe] rawBody missing — check raw-body middleware in index.js');
      return res.status(400).send('Raw body not available.');
    }

    // Guard 2 — both the signature header and the webhook secret must be present
    if (!sig || !webhookSecret) {
      console.error('[Payments/Stripe] Missing stripe-signature header or STRIPE_WEBHOOK_SECRET');
      return res.status(400).send('Signature configuration missing.');
    }

    // Verify signature using the Stripe SDK (HMAC-SHA256, constant-time comparison)
    let event;
    try {
      const stripe = getStripe();
      event = stripe.webhooks.constructEvent(req.rawBody, sig, webhookSecret);
    } catch (err) {
      // Do NOT log err.message to the response — it may reveal internal details
      console.error('[Payments/Stripe] Webhook signature verification failed:', err.message);
      return res.status(400).send('Webhook verification failed.');
    }

    // Return 200 immediately — Stripe retries on 5xx but not on 200.
    // Process asynchronously so we never block the acknowledgement.
    res.status(200).json({ received: true });
    setImmediate(() =>
      processStripeEvent(event).catch(err =>
        console.error('[Payments/Stripe] processStripeEvent error:', err.message)
      )
    );
    return;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Africa's Talking
  // ════════════════════════════════════════════════════════════════════════════
  if (processor === '/africastalking') {
    // AT does not sign webhook bodies with HMAC the way Stripe does. The standard
    // approach is a pre-shared secret token embedded in the callback URL at
    // registration time, e.g. /africastalking/webhook?token=<AT_WEBHOOK_SECRET>
    const expectedToken = process.env.AFRICASTALKING_WEBHOOK_SECRET;
    const receivedToken = req.query.token;

    if (!expectedToken) {
      // Not yet configured — log and acknowledge (prevents AT retry flood)
      console.error('[Payments/AT] AFRICASTALKING_WEBHOOK_SECRET is not set');
      return res.status(200).send('OK');
    }

    if (!receivedToken || !timingSafeCompare(String(receivedToken), expectedToken)) {
      console.error('[Payments/AT] Webhook token verification failed');
      return res.status(403).send('Forbidden');
    }

    // express.json() / express.urlencoded() already parsed the body into req.body
    // (via the captureRawBody verify callback in index.js).
    // No manual stream parsing needed here.
    const payload = req.body;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return res.status(400).send('Missing or invalid body.');
    }

    const status = (payload.paymentStatus || payload.status || '').toLowerCase();

    // Only process confirmed payments
    if (status !== 'success' && status !== 'successful') {
      console.log(`[Payments/AT] Non-success status "${status}" — no action`);
      return res.status(200).send('OK');
    }

    const txId     = String(payload.transactionId || payload.id || '');
    const phoneRaw = String(payload.phoneNumber   || payload.customerNumber || '');
    const valueRaw = String(payload.value         || payload.amount         || '0');
    // txRef is embedded in requestMetadata or at top level, depending on AT version
    const txRef    = String(
      payload.requestMetadata?.txRef
      || payload.requestMetadata?.transactionRef
      || payload.transactionRef
      || ''
    );

    const tenantId = extractTenantFromTxRef(txRef);
    if (!tenantId) {
      console.warn('[Payments/AT] Cannot resolve tenantId from txRef:', txRef);
      return res.status(200).send('OK'); // Acknowledge so AT stops retrying
    }

    const txParts  = txRef.split('_');
    const plan     = PAID_PLANS.includes(txParts[2]) ? txParts[2] : 'pro';
    const interval = VALID_INTERVALS.includes(txParts[3]) ? txParts[3] : 'monthly';
    const ctInfo   = getATCountryInfo(phoneRaw);
    const currency = ctInfo?.currency || 'RWF';
    const country  = ctInfo?.country  || 'RW';
    const adminLang = country === 'RW' ? 'rw' : 'sw';

    // Acknowledge AT immediately — Firestore writes are best-effort after this point
    res.status(200).send('OK');

    setImmediate(async () => {
      try {
        await db.collection(COLLECTIONS.TENANTS).doc(tenantId).update({
          plan,
          planInterval:       interval,
          subscriptionStatus: 'active',
          cancelledAt:        null,
          updatedAt:          FieldValue.serverTimestamp(),
        });

        await db.collection(COLLECTIONS.PAYMENTS).add({
          tenantId,
          processor:       'africastalking',
          amount:          parseFloat(valueRaw) || 0,
          currency,
          plan,
          interval,
          status:          'completed',
          atTransactionId: txId,
          phoneLast4:      phoneRaw ? `***${String(phoneRaw).slice(-4)}` : null,
          createdAt:       FieldValue.serverTimestamp(),
        });

        const admin = await findTenantAdmin(tenantId);
        if (admin?.phone) {
          sendSMS(admin.phone, buildMoMoSuccessSMS(admin.language || adminLang, plan))
            .catch(err =>
              console.error(`[Payments/AT] Success SMS to ***${String(admin.phone).slice(-4)}:`, err.message)
            );
        }

        writeAuditLog({
          action:   'mobilemoney_payment_received',
          actorId:  `at:${txId}`,
          targetId: tenantId,
          meta:     { plan, interval, phoneLast4: phoneRaw ? `***${phoneRaw.slice(-4)}` : null },
        }).catch(() => {});
      } catch (err) {
        console.error('[Payments/AT] Post-webhook Firestore error:', err.message);
      }
    });

    return;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Flutterwave
  // ════════════════════════════════════════════════════════════════════════════
  if (processor === '/flutterwave') {
    // FLW sends a `verif-hash` header set to the "Secret Hash" configured in
    // the FLW dashboard. This is separate from FLW_SECRET_KEY.
    const expectedHash = process.env.FLW_SECRET_HASH;
    const receivedHash = req.headers['verif-hash'];

    if (!expectedHash) {
      console.error('[Payments/FLW] FLW_SECRET_HASH is not set');
      return res.status(200).json({ received: true }); // Acknowledge to stop retries
    }

    if (!receivedHash || !timingSafeCompare(String(receivedHash), expectedHash)) {
      console.error('[Payments/FLW] verif-hash verification failed');
      return res.status(403).send('Forbidden');
    }

    // express.json() already parsed the body into req.body via captureRawBody in index.js.
    const payload = req.body;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return res.status(400).send('Missing or invalid body.');
    }

    // Only process charge.completed events
    if (payload.event !== 'charge.completed') {
      return res.status(200).json({ received: true });
    }

    const data   = payload.data || {};
    const status = (data.status || '').toLowerCase();

    if (status !== 'successful') {
      console.log(`[Payments/FLW] Non-successful status "${status}" — no action`);
      return res.status(200).json({ received: true });
    }

    // Validate FLW transaction ID format before any API call
    const txIdRaw = String(data.id || '');
    if (!FLW_TX_ID_PATTERN.test(txIdRaw)) {
      console.error('[Payments/FLW] Invalid transaction ID format:', txIdRaw);
      return res.status(200).json({ received: true });
    }

    const txRef    = String(data.tx_ref || '');
    const tenantId = extractTenantFromTxRef(txRef);
    if (!tenantId) {
      console.warn('[Payments/FLW] Cannot resolve tenantId from tx_ref:', txRef);
      return res.status(200).json({ received: true });
    }

    const txParts  = txRef.split('_');
    const plan     = PAID_PLANS.includes(txParts[2])     ? txParts[2] : 'pro';
    const interval = VALID_INTERVALS.includes(txParts[3]) ? txParts[3] : 'monthly';

    // Acknowledge FLW immediately; verification + Firestore write happen asynchronously
    res.status(200).json({ received: true });

    setImmediate(async () => {
      try {
        // Double-verify with FLW API before writing to Firestore.
        // This prevents a spoofed-but-correctly-signed webhook from activating a plan.
        let verified = false;
        try {
          const flw    = getFlw();
          const verify = await flw.Transaction.verify({ id: txIdRaw });
          verified     = verify?.data?.status === 'successful'
                      && verify?.data?.tx_ref  === txRef;
        } catch (err) {
          console.error('[Payments/FLW] Transaction.verify error:', err.message);
        }

        if (!verified) {
          console.error('[Payments/FLW] Payment verification failed for txId:', txIdRaw);
          return; // Do not update Firestore — the payload could be fabricated
        }

        await db.collection(COLLECTIONS.TENANTS).doc(tenantId).update({
          plan,
          planInterval:       interval,
          subscriptionStatus: 'active',
          cancelledAt:        null,
          updatedAt:          FieldValue.serverTimestamp(),
        });

        await db.collection(COLLECTIONS.PAYMENTS).add({
          tenantId,
          processor:        'flutterwave',
          amount:           Number(data.charged_amount || data.amount) || 0,
          currency:         (String(data.currency || 'USD')).toUpperCase().slice(0, 10),
          plan,
          interval,
          status:           'completed',
          flwTransactionId: txIdRaw,
          flwTxRef:         txRef,
          createdAt:        FieldValue.serverTimestamp(),
        });

        const admin = await findTenantAdmin(tenantId);
        if (admin?.phone) {
          sendSMS(admin.phone, buildPaymentSuccessSMS(admin.language, plan))
            .catch(err =>
              console.error(`[Payments/FLW] Success SMS to ***${String(admin.phone).slice(-4)}:`, err.message)
            );
        }

        writeAuditLog({
          action:   'flutterwave_payment_received',
          actorId:  `flw:${txIdRaw}`,
          targetId: tenantId,
          meta:     { plan, interval, txRef },
        }).catch(() => {});
      } catch (err) {
        console.error('[Payments/FLW] Post-webhook Firestore error:', err.message);
      }
    });

    return;
  }

  // Unknown baseUrl — should never happen given index.js mount configuration
  console.error('[Payments] POST /webhook called from unexpected baseUrl:', processor);
  return res.status(404).json({ error: 'Unknown payment processor.' });
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 2 — GET /subscription
// Returns the current tenant subscription status and plan details.
// ─────────────────────────────────────────────────────────────────────────────

router.get('/subscription', requireAuth, async (req, res) => {
  const { tenantId, role } = req.user;

  if (!tenantId) {
    return res.status(400).json({ error: 'Your account is not associated with a tenant.' });
  }

  try {
    const snap = await db.collection(COLLECTIONS.TENANTS).doc(tenantId).get();
    if (!snap.exists) {
      return res.status(404).json({ error: 'Tenant not found.' });
    }

    const t    = snap.data();
    const plan = t.plan || 'community';
    const isAdmin = role === 'admin' || role === 'superadmin';

    // Safely convert Firestore Timestamps to ISO strings
    const toISO = (v) => {
      if (!v) return null;
      if (v?.toDate) return v.toDate().toISOString();
      if (v instanceof Date) return v.toISOString();
      return null;
    };

    const subscription = {
      plan,
      planInterval:       t.planInterval       || null,
      subscriptionStatus: t.subscriptionStatus  || 'active',
      currentPeriodEnd:   toISO(t.currentPeriodEnd),
      cancelledAt:        toISO(t.cancelledAt),
      // Plan pricing details (server-side only — for UI display)
      planDetails: PLAN_PRICES_USD[plan] || { monthly: 0, yearly: 0 },
      // Admins get a presence-only indicator for Stripe IDs (never the raw value)
      ...(isAdmin && {
        stripeLinked:    !!t.stripeCustomerId,
        stripeActive:    !!t.stripeSubscriptionId,
        processor:       t.lastProcessor || null,
      }),
    };

    return res.json({ subscription });
  } catch (err) {
    console.error('[Payments] GET /subscription error:', err.message);
    return res.status(500).json({ error: 'Could not load subscription details. Please try again.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 3 — POST /stripe/create-session
// Creates a Stripe Checkout session for card payment.
// Used for Canada, USA, and Europe.
// ─────────────────────────────────────────────────────────────────────────────

router.post('/stripe/create-session', sessionLimiter, requireAuth, async (req, res) => {
  const { role, tenantId, userId } = req.user;

  // Only admins can manage billing
  if (role !== 'admin' && role !== 'superadmin') {
    return res.status(403).json({ error: 'Only organisation admins can manage billing.' });
  }

  if (!tenantId) {
    return res.status(400).json({ error: 'Your account is not associated with a tenant.' });
  }

  const { plan: rawPlan, interval: rawInterval } = req.body;

  // Validate plan — server whitelist only; amount never comes from client
  if (!rawPlan || !PAID_PLANS.includes(String(rawPlan))) {
    return res.status(400).json({
      error: `Invalid plan. Accepted values: ${PAID_PLANS.join(', ')}.`,
    });
  }
  const plan = String(rawPlan);

  if (!rawInterval || !VALID_INTERVALS.includes(String(rawInterval))) {
    return res.status(400).json({ error: 'Invalid interval. Must be "monthly" or "yearly".' });
  }
  const interval = String(rawInterval);

  // Look up the Stripe Price ID server-side — client can only choose plan + interval
  const priceId = getStripePriceId(plan, interval);
  if (!priceId) {
    console.error(`[Payments/Stripe] Missing env var: STRIPE_PRICE_${plan.toUpperCase()}_${interval.toUpperCase()}`);
    return res.status(503).json({
      error: 'Stripe pricing for this plan is not yet configured. Please contact support.',
    });
  }

  let stripe;
  try {
    stripe = getStripe();
  } catch (err) {
    console.error('[Payments/Stripe] SDK init error:', err.message);
    return res.status(503).json({ error: 'Payment service is temporarily unavailable. Please try again later.' });
  }

  const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');

  try {
    const session = await stripe.checkout.sessions.create({
      mode:                 'subscription',
      payment_method_types: ['card'],
      line_items:           [{ price: priceId, quantity: 1 }],
      // tenantId + userId in metadata so the webhook can resolve them without
      // a customer lookup (faster and more resilient to Stripe metadata gaps)
      metadata:             { tenantId, userId, plan, interval },
      success_url:          `${frontendUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:           `${frontendUrl}/payment/cancelled`,
      client_reference_id:  tenantId,
    });

    writeAuditLog({
      action:   'stripe_session_created',
      actorId:  userId,
      targetId: tenantId,
      meta:     { plan, interval, stripeSessionId: session.id },
    }).catch(() => {});

    return res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error('[Payments/Stripe] checkout.sessions.create error:', err.message);
    return res.status(500).json({ error: 'Could not create payment session. Please try again.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 4 — POST /mobilemoney/initiate
// Initiates an Africa's Talking mobile checkout (MTN / Airtel STK push).
// Used for Rwanda, Kenya, Tanzania, Uganda, Nigeria, Ghana.
// ─────────────────────────────────────────────────────────────────────────────

router.post('/mobilemoney/initiate', momoLimiter, requireAuth, async (req, res) => {
  const { role, tenantId, userId } = req.user;

  if (role !== 'admin' && role !== 'superadmin') {
    return res.status(403).json({ error: 'Only organisation admins can manage billing.' });
  }

  if (!tenantId) {
    return res.status(400).json({ error: 'Your account is not associated with a tenant.' });
  }

  const { plan: rawPlan, interval: rawInterval, phone: rawPhone } = req.body;

  if (!rawPlan || !PAID_PLANS.includes(String(rawPlan))) {
    return res.status(400).json({
      error: `Invalid plan. Accepted values: ${PAID_PLANS.join(', ')}.`,
    });
  }
  const plan = String(rawPlan);

  if (!rawInterval || !VALID_INTERVALS.includes(String(rawInterval))) {
    return res.status(400).json({ error: 'Invalid interval. Must be "monthly" or "yearly".' });
  }
  const interval = String(rawInterval);

  // Phone must be E.164 format
  if (!rawPhone || !PHONE_PATTERN.test(String(rawPhone))) {
    return res.status(400).json({
      error: 'Invalid phone number. Use E.164 format, e.g. +250788123456.',
    });
  }
  const phone = String(rawPhone);

  // Determine country and currency from prefix — also gates unsupported countries
  const countryInfo = getATCountryInfo(phone);
  if (!countryInfo) {
    return res.status(400).json({
      error: 'Mobile money via this service is only available for Rwanda, Kenya, Tanzania, Uganda, Nigeria, and Ghana.',
    });
  }

  // Server-side amount — never read from request body
  const amountUSD = PLAN_PRICES_USD[plan][interval];

  let localAmount;
  try {
    localAmount = usdToLocal(amountUSD, countryInfo.currency);
  } catch (err) {
    console.error('[Payments/AT] FX conversion error:', err.message);
    return res.status(400).json({ error: 'Currency conversion unavailable for this region.' });
  }

  let atPayments;
  try {
    atPayments = getATPayments();
  } catch (err) {
    console.error('[Payments/AT] SDK init error:', err.message);
    return res.status(503).json({ error: 'Mobile money service is temporarily unavailable. Please try again later.' });
  }

  const txRef       = buildTxRef(tenantId, plan, interval);
  const productName = process.env.AFRICASTALKING_PRODUCT_NAME || 'BridgeUp';

  try {
    const result = await atPayments.mobileCheckout({
      productName,
      phoneNumber:  phone,
      currencyCode: countryInfo.currency,
      amount:       localAmount,
      metadata:     { txRef, tenantId, plan, interval },
    });

    // Store the pending payment record so the webhook can reconcile it
    await db.collection(COLLECTIONS.PAYMENTS).add({
      tenantId,
      userId,
      processor:       'africastalking',
      amount:          localAmount,
      currency:        countryInfo.currency,
      amountUSD,
      plan,
      interval,
      status:          'pending',
      atTransactionId: result.transactionId || null,
      txRef,
      // Phone stored as last-4 only — full number is never persisted server-side
      phoneLast4:      `***${phone.slice(-4)}`,
      createdAt:       FieldValue.serverTimestamp(),
    });

    writeAuditLog({
      action:   'mobilemoney_initiated',
      actorId:  userId,
      targetId: tenantId,
      meta: {
        plan, interval,
        currency:   countryInfo.currency,
        txRef,
        phoneLast4: `***${phone.slice(-4)}`,
      },
    }).catch(() => {});

    return res.json({
      initiated:     true,
      txRef,
      transactionId: result.transactionId || null,
      currency:      countryInfo.currency,
      amount:        localAmount,
      message:       'Payment request sent. Please check your phone to approve the transaction.',
    });
  } catch (err) {
    console.error('[Payments/AT] mobileCheckout error:', err.message);
    return res.status(500).json({ error: 'Could not initiate mobile money payment. Please try again.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 5 — POST /flutterwave/initiate
// Creates a Flutterwave Standard payment link for African countries not
// covered by Africa's Talking (e.g. South Africa, Egypt, Ivory Coast, Cameroon).
// ─────────────────────────────────────────────────────────────────────────────

router.post('/flutterwave/initiate', momoLimiter, requireAuth, async (req, res) => {
  const { role, tenantId, userId } = req.user;

  if (role !== 'admin' && role !== 'superadmin') {
    return res.status(403).json({ error: 'Only organisation admins can manage billing.' });
  }

  if (!tenantId) {
    return res.status(400).json({ error: 'Your account is not associated with a tenant.' });
  }

  const { plan: rawPlan, interval: rawInterval, email: rawEmail } = req.body;

  if (!rawPlan || !PAID_PLANS.includes(String(rawPlan))) {
    return res.status(400).json({
      error: `Invalid plan. Accepted values: ${PAID_PLANS.join(', ')}.`,
    });
  }
  const plan = String(rawPlan);

  if (!rawInterval || !VALID_INTERVALS.includes(String(rawInterval))) {
    return res.status(400).json({ error: 'Invalid interval. Must be "monthly" or "yearly".' });
  }
  const interval = String(rawInterval);

  // Basic RFC 5322 email validation — required for FLW checkout
  if (!rawEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(rawEmail))) {
    return res.status(400).json({ error: 'A valid email address is required for card payments.' });
  }
  const email = String(rawEmail).toLowerCase().trim().slice(0, 254);

  // Server-side amount only
  const amountUSD = PLAN_PRICES_USD[plan][interval];

  let flw;
  try {
    flw = getFlw();
  } catch (err) {
    console.error('[Payments/FLW] SDK init error:', err.message);
    return res.status(503).json({ error: 'Payment service is temporarily unavailable. Please try again later.' });
  }

  const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
  const txRef       = buildTxRef(tenantId, plan, interval);

  // Call FLW Standard Payment API to generate a hosted checkout link.
  // We use the native fetch (Node 18+) to hit the v3 API directly; the
  // flutterwave-node-v3 SDK focuses on direct charges rather than Standard checkout.
  try {
    const flwSecretKey = process.env.FLW_SECRET_KEY;
    if (!flwSecretKey) {
      return res.status(503).json({ error: 'Payment service is not configured. Please contact support.' });
    }

    const payload = {
      tx_ref:       txRef,
      amount:       amountUSD,
      currency:     'USD',
      redirect_url: `${frontendUrl}/payment/success`,
      customer:     { email },
      meta:         { tenantId, plan, interval },
      customizations: {
        title:       'BridgeUp Subscription',
        description: `${plan.charAt(0).toUpperCase() + plan.slice(1)} — ${interval}`,
        logo:        `${frontendUrl}/logo.png`,
      },
    };

    const httpRes = await fetch('https://api.flutterwave.com/v3/payments', {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${flwSecretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const responseData = await httpRes.json();

    if (!httpRes.ok || responseData.status !== 'success') {
      console.error('[Payments/FLW] API error:', responseData?.message || httpRes.status);
      return res.status(502).json({ error: 'Could not generate payment link. Please try again.' });
    }

    const link = responseData?.data?.link;
    if (!link) {
      console.error('[Payments/FLW] No link in response:', JSON.stringify(responseData));
      return res.status(502).json({ error: 'Could not generate payment link. Please try again.' });
    }

    // Store pending payment record
    await db.collection(COLLECTIONS.PAYMENTS).add({
      tenantId,
      userId,
      processor: 'flutterwave',
      amount:    amountUSD,
      currency:  'USD',
      plan,
      interval,
      status:    'pending',
      txRef,
      createdAt: FieldValue.serverTimestamp(),
    });

    writeAuditLog({
      action:   'flutterwave_initiated',
      actorId:  userId,
      targetId: tenantId,
      meta:     { plan, interval, txRef },
    }).catch(() => {});

    return res.json({ initiated: true, url: link, txRef });
  } catch (err) {
    console.error('[Payments/FLW] Initiate error:', err.message);
    return res.status(500).json({ error: 'Could not initiate payment. Please try again.' });
  }
});

module.exports = router;
