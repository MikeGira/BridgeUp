'use strict';

/**
 * scheduler.js — Automated report delivery service.
 *
 * Schedules are:
 *   Weekly      — Every Monday 08:00 UTC   (cron: 0 8 * * 1)
 *   Monthly     — 1st of every month 08:00 UTC (cron: 0 8 1 * *)
 *   Quarterly   — 1st of Jan/Apr/Jul/Oct 08:00 UTC (cron: 0 8 1 1,4,7,10 *)
 *   Annual      — 1st January 08:00 UTC   (cron: 0 8 1 1 *)
 *
 * Each run:
 *   1. Fetches all active tenants from Firestore.
 *   2. For each tenant, generates the scheduled report types.
 *   3. Emails a text/HTML summary if SMTP is configured.
 *   4. Stores a delivery record in Firestore (audit trail).
 *
 * Email requires SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM env vars.
 * If SMTP is not configured the reports are still generated and logged — email
 * is silently skipped so the server never crashes on a missing env var.
 *
 * This module NEVER requires('./routes/reports') to avoid circular deps.
 * It imports DATA_FETCHERS and helpers from routes/reports.js via the explicit
 * named export surface, which is safe after the module graph is fully resolved.
 */

const cron       = require('node-cron');
const nodemailer = require('nodemailer');
const {
  db,
  COLLECTIONS,
  queryToArray,
  writeAuditLog,
} = require('./firebase');

// ─── Report helpers — imported AFTER module graph is resolved ─────────────────
// We defer the require() call to the first job run to guarantee reports.js
// is fully loaded (index.js registers the route before starting the scheduler).
let _reports = null;
function getReports() {
  if (!_reports) _reports = require('../routes/reports');
  return _reports;
}

// ─── SMTP helper (no-op if not configured) ───────────────────────────────────

async function sendScheduledEmail({ to, subject, text, html }) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.log(`[Scheduler] Email skipped (SMTP not configured): ${subject} → ${to}`);
    return false;
  }
  try {
    const transporter = nodemailer.createTransport({
      host:   SMTP_HOST,
      port:   parseInt(SMTP_PORT || '587', 10),
      secure: parseInt(SMTP_PORT || '587', 10) === 465,
      auth:   { user: SMTP_USER, pass: SMTP_PASS },
    });
    await transporter.sendMail({
      from:    SMTP_FROM || `BridgeUp <${SMTP_USER}>`,
      to, subject, text, html,
    });
    console.log(`[Scheduler] Email sent: ${subject} → ${to}`);
    return true;
  } catch (err) {
    console.error(`[Scheduler] Email error (${subject} → ${to}):`, err.message);
    return false;
  }
}

// ─── Core job — generate + deliver reports for a set of types ───────────────

/**
 * Runs one scheduled delivery cycle.
 *
 * @param {string}   scheduleLabel  — human-readable name (e.g. "weekly")
 * @param {string[]} reportTypes    — report type keys to generate
 * @param {string}   rangeParam     — date range key (e.g. "last7days")
 */
async function runDelivery(scheduleLabel, reportTypes, rangeParam) {
  console.log(`[Scheduler] Starting ${scheduleLabel} delivery: ${reportTypes.join(', ')}`);

  const { DATA_FETCHERS, parseRange, REPORT_TITLES, getTenantName } = getReports();

  // Fetch all tenants
  let tenants = [];
  try {
    const snap = await db.collection(COLLECTIONS.TENANTS).get();
    tenants = queryToArray(snap).filter(t => t.active !== false);
  } catch (err) {
    console.error('[Scheduler] Could not load tenants:', err.message);
    return;
  }

  console.log(`[Scheduler] ${scheduleLabel} — ${tenants.length} tenant(s) to process`);

  // Parse date range
  let rangeResult;
  try {
    rangeResult = parseRange(rangeParam);
  } catch (err) {
    console.error('[Scheduler] Invalid range:', err.message);
    return;
  }

  const { startTs, endTs, label: dateRangeLabel, startDate, endDate } = rangeResult;

  for (const tenant of tenants) {
    const tenantId   = tenant.id;
    const tenantName = tenant.name || tenantId;
    const contactEmail = tenant.contactEmail || tenant.billingEmail || null;

    for (const type of reportTypes) {
      try {
        const fetcher = DATA_FETCHERS[type];
        if (!fetcher) continue;

        const data = await fetcher(tenantId, startTs, endTs, startDate, endDate, {});

        const reportTitle = REPORT_TITLES[type] || type;
        const subject = `[BridgeUp] ${scheduleLabel} ${reportTitle} — ${dateRangeLabel}`;

        // Build a short plain-text summary for email body
        const textBody = buildTextSummary(type, data, { tenantName, dateRangeLabel, reportTitle });

        // Store delivery record in Firestore (audit trail — 7-year retention requirement)
        await db.collection('scheduled_reports').add({
          tenantId,
          tenantName,
          reportType:    type,
          schedule:      scheduleLabel,
          dateRange:     rangeParam,
          dateRangeLabel,
          generatedAt:   new Date(),
          emailSent:     false,    // updated below
          emailAddress:  contactEmail,
        }).then(async (ref) => {
          // Attempt email delivery
          let emailSent = false;
          if (contactEmail) {
            emailSent = await sendScheduledEmail({
              to:      contactEmail,
              subject,
              text:    textBody,
              html:    textToHTML(textBody, reportTitle),
            });
          }
          // Update with actual email result
          await ref.update({ emailSent, deliveredAt: emailSent ? new Date() : null });
        });

        // Fire-and-forget audit
        writeAuditLog({
          action:   'scheduled_report_generated',
          actorId:  'scheduler',
          targetId: type,
          tenantId,
          meta:     { schedule: scheduleLabel, range: rangeParam, emailTo: contactEmail },
        }).catch(() => {});

        console.log(`[Scheduler] ✓ ${scheduleLabel} ${type} for tenant "${tenantName}"`);
      } catch (jobErr) {
        // One tenant/type failure must not abort the entire run
        console.error(`[Scheduler] ✗ ${scheduleLabel} ${type} for tenant "${tenantId}":`, jobErr.message);
      }
    }
  }

  console.log(`[Scheduler] ${scheduleLabel} delivery complete.`);
}

// ─── Text summary builder ────────────────────────────────────────────────────

/**
 * Builds a short plain-text email body summarising key metrics per report type.
 * This is intentionally concise — recipients open the dashboard for full detail.
 */
function buildTextSummary(type, data, { tenantName, dateRangeLabel, reportTitle }) {
  const lines = [
    `BridgeUp — ${reportTitle}`,
    `Organisation: ${tenantName}`,
    `Period: ${dateRangeLabel}`,
    `Generated: ${new Date().toUTCString()}`,
    '',
  ];

  switch (type) {
    case 'needs_impact':
      lines.push(`Total Needs Submitted : ${data.period?.total ?? '—'}`);
      lines.push(`Needs Resolved        : ${data.period?.resolved ?? '—'}`);
      lines.push(`Resolution Rate       : ${data.period?.resolutionRate ?? '—'}%`);
      lines.push(`Avg Response Time     : ${data.avgResponseHours != null ? data.avgResponseHours + ' hours' : 'N/A'}`);
      lines.push(`Unmet Needs           : ${data.unmet?.total ?? '—'}`);
      break;
    case 'helper_performance':
      lines.push(`Total Helpers     : ${data.summary?.totalHelpers ?? '—'}`);
      lines.push(`Active Helpers    : ${data.summary?.activeHelpers ?? '—'}`);
      lines.push(`Avg Resolution    : ${data.summary?.avgResolutionRate ?? '—'}%`);
      break;
    case 'geographic_coverage':
      lines.push(`Regions with Needs  : ${data.summary?.totalRegions ?? '—'}`);
      lines.push(`Covered Regions     : ${data.summary?.coveredRegions ?? '—'}`);
      lines.push(`Uncovered Regions   : ${data.summary?.uncoveredRegions ?? '—'}`);
      break;
    case 'donor_ngo_impact':
      lines.push(`People Helped   : ${data.impact?.totalPeopleHelped ?? '—'}`);
      lines.push(`Needs Resolved  : ${data.impact?.needsResolved ?? '—'}`);
      lines.push(`Resolution Rate : ${data.impact?.resolutionRate ?? '—'}%`);
      lines.push(`Locations Served: ${data.impact?.locationsServed ?? '—'}`);
      break;
    case 'financial_grant':
      lines.push(`People Helped          : ${data.impact?.totalPeopleHelped ?? '—'}`);
      lines.push(`Total Platform Fees    : $${data.financial?.totalPlatformFeesUSD ?? '—'}`);
      lines.push(`Cost per Person        : ${data.financial?.costPerPersonHelpedUSD != null ? '$' + data.financial.costPerPersonHelpedUSD : 'N/A'}`);
      break;
    case 'compliance':
      lines.push(`Total Users               : ${data.totalUsers ?? '—'}`);
      lines.push(`Total Helpers             : ${data.totalHelpers ?? '—'}`);
      lines.push(`Helpers Verified          : ${data.helperVerification?.approved ?? '—'}`);
      lines.push(`Pending Verification      : ${data.helperVerification?.pending ?? '—'}`);
      lines.push(`Flagged Accounts (open)   : ${data.flaggedAccounts?.pending ?? '—'}`);
      lines.push(`Deletion Requests (open)  : ${data.deletionRequests?.pending ?? '—'}`);
      break;
    case 'sms_feature_phone':
      lines.push(`Total SMS Needs      : ${data.summary?.totalSMSNeeds ?? '—'}`);
      lines.push(`SMS Resolution Rate  : ${data.summary?.smsResolutionRate ?? '—'}%`);
      lines.push(`App Resolution Rate  : ${data.summary?.appResolutionRate ?? '—'}%`);
      lines.push(`SMS Share of Needs   : ${data.summary?.smsShare ?? '—'}%`);
      break;
    default:
      lines.push('See your BridgeUp dashboard for full details.');
  }

  lines.push('');
  lines.push('— BridgeUp Platform');
  lines.push('Full reports available on your admin dashboard.');
  return lines.join('\n');
}

/** Wraps plain text in minimal branded HTML for the email body. */
function textToHTML(text, title) {
  const escaped = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .split('\n').map((line, i) => {
      if (i === 0) return `<h2 style="color:#1A56DB;margin:0 0 4px">${line}</h2>`;
      if (line === '') return '<br>';
      return `<p style="margin:2px 0;font-family:monospace">${line}</p>`;
    }).join('');
  return `<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:600px;margin:40px auto;padding:24px;border:1px solid #E5E7EB;border-radius:8px">${escaped}</body></html>`;
}

// ─── Schedule definitions ─────────────────────────────────────────────────────

const SCHEDULES = [
  {
    name:    'weekly',
    cron:    '0 8 * * 1',          // Every Monday at 08:00 UTC
    range:   'last7days',
    types:   ['needs_impact', 'helper_performance'],
  },
  {
    name:    'monthly',
    cron:    '0 8 1 * *',          // 1st of every month at 08:00 UTC
    range:   'last30days',
    types:   ['needs_impact', 'helper_performance', 'geographic_coverage', 'sms_feature_phone'],
  },
  {
    name:    'quarterly',
    cron:    '0 8 1 1,4,7,10 *',   // 1st day of Jan/Apr/Jul/Oct at 08:00 UTC
    range:   'last90days',
    types:   ['needs_impact', 'helper_performance', 'geographic_coverage', 'donor_ngo_impact', 'financial_grant', 'compliance', 'sms_feature_phone'],
  },
  {
    name:    'annual',
    cron:    '0 8 1 1 *',          // 1st January at 08:00 UTC
    range:   'lastyear',
    types:   ['needs_impact', 'helper_performance', 'geographic_coverage', 'donor_ngo_impact', 'financial_grant', 'compliance', 'sms_feature_phone'],
  },
];

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Starts all cron schedules. Called once from index.js after routes are mounted.
 * Each job failure is caught and logged — a failing job never brings down the server.
 */
function startScheduler() {
  for (const schedule of SCHEDULES) {
    if (!cron.validate(schedule.cron)) {
      console.error(`[Scheduler] Invalid cron expression for "${schedule.name}": ${schedule.cron}`);
      continue;
    }

    cron.schedule(schedule.cron, async () => {
      try {
        await runDelivery(schedule.name, schedule.types, schedule.range);
      } catch (err) {
        console.error(`[Scheduler] Unhandled error in ${schedule.name} job:`, err.message);
      }
    }, {
      scheduled: true,
      timezone:  'UTC',
    });

    console.log(`[Scheduler] ${schedule.name} job scheduled (${schedule.cron} UTC)`);
  }
}

/**
 * Manually triggers a single delivery cycle — useful for testing or backfills.
 * Called by POST /api/admin/trigger-report-delivery (future admin route).
 */
async function triggerDelivery(scheduleName, tenantIdOverride) {
  const schedule = SCHEDULES.find(s => s.name === scheduleName);
  if (!schedule) throw new Error(`Unknown schedule "${scheduleName}". Valid: ${SCHEDULES.map(s => s.name).join(', ')}.`);
  await runDelivery(schedule.name, schedule.types, schedule.range);
}

module.exports = { startScheduler, triggerDelivery, SCHEDULES };
