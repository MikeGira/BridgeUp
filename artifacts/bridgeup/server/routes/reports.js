'use strict';

/**
 * reports.js — 7-type reporting engine with PDF/Excel export and AI narrative.
 *
 * Mount: /api/reports  (index.js: app.use('/api/reports', loadRoute('./routes/reports', 'reports')))
 *
 * Endpoints:
 *   GET  /api/reports/:type               — Live report data + AI narrative
 *   POST /api/reports/:type/export/pdf    — Stream branded PDF (pdfkit)
 *   POST /api/reports/:type/export/excel  — Stream Excel workbook (xlsx/SheetJS)
 *
 * Report types:
 *   needs_impact | helper_performance | geographic_coverage |
 *   donor_ngo_impact | financial_grant | compliance | sms_feature_phone
 *
 * Date ranges: today | last7days | last30days | last90days | lastyear | custom
 *
 * Security:
 *   - requireAuth + requireReportAccess on every endpoint
 *   - Tenant isolation: scopedRef() adds where('tenantId','==',tenantId) for non-superadmin
 *   - Phone numbers redacted to last 4 digits in all responses
 *   - Rate limited: 10 requests / minute / authenticated user
 *
 * Firestore composite indexes required (firebase.json / Firebase Console):
 *   needs     : (tenantId ASC, createdAt ASC)
 *   helpers   : (tenantId ASC, status ASC)
 *   matches   : (tenantId ASC, createdAt ASC)
 *   audit_log : (action ASC, tenantId ASC, timestamp DESC)
 */

const express  = require('express');
const rateLimit = require('express-rate-limit');
const PDFDocument = require('pdfkit');
const XLSX     = require('xlsx');
const {
  db,
  Timestamp,
  COLLECTIONS,
  queryToArray,
  writeAuditLog,
} = require('../services/firebase');
const { requireAuth }           = require('./auth');
const { generateReportSummary } = require('../services/claude');

const router = express.Router();

// ─── Constants ────────────────────────────────────────────────────────────────

const VALID_REPORT_TYPES = [
  'needs_impact',
  'helper_performance',
  'geographic_coverage',
  'donor_ngo_impact',
  'financial_grant',
  'compliance',
  'sms_feature_phone',
];

const VALID_RANGES = ['today', 'last7days', 'last30days', 'last90days', 'lastyear', 'custom'];

// Roles allowed to generate reports
const REPORT_ROLES = new Set(['admin', 'superadmin', 'management', 'ngo', 'donor']);

// PDF brand colours
const PDF_BLUE  = '#1A56DB';
const PDF_GRAY  = '#6B7280';
const PDF_BLACK = '#111827';
const PDF_LIGHT = '#E5E7EB';

// Report display titles (shared with claude.js generateReportSummary labels)
const REPORT_TITLES = {
  needs_impact:        'Needs & Impact Report',
  helper_performance:  'Helper Performance Report',
  geographic_coverage: 'Geographic Coverage Report',
  donor_ngo_impact:    'Donor & NGO Impact Report',
  financial_grant:     'Financial & Grant Readiness Report',
  compliance:          'Compliance & Data Governance Report',
  sms_feature_phone:   'SMS & Feature Phone Report',
};

// ─── Rate limiter — 10 req / min / authenticated user ────────────────────────
// Report generation fires multiple Firestore reads + a Claude call. The general
// 100/min IP limiter in index.js is too loose — cap at 10/min per user.
const reportLimiter = rateLimit({
  windowMs:        60 * 1000,
  max:             10,
  standardHeaders: true,
  legacyHeaders:   false,
  message: {
    error: 'You have generated too many reports. Please wait before requesting another.',
  },
  keyGenerator: (req) => req.user?.userId || req.ip,
});

// ─── Role middleware ──────────────────────────────────────────────────────────

function requireReportAccess(req, res, next) {
  if (!REPORT_ROLES.has(req.user?.role)) {
    return res.status(403).json({ error: 'You do not have permission to access reports.' });
  }
  next();
}

// ─── Utility helpers ──────────────────────────────────────────────────────────

/** Masks a phone string to last 4 digits: "+250788123456" → "***3456". */
function redactPhone(str) {
  if (!str) return null;
  return '***' + String(str).slice(-4);
}

/** Converts a Firestore Timestamp or Date to ISO string, or null. */
function tsToISO(val) {
  if (!val) return null;
  if (typeof val.toDate === 'function') return val.toDate().toISOString();
  if (val instanceof Date) return val.toISOString();
  return null;
}

/**
 * Parses a named date range string into start/end Timestamps and a display label.
 * Throws a 400-status error for invalid input.
 */
function parseRange(range, startDateStr, endDateStr) {
  const now = new Date();
  let start, end, label;

  switch (range) {
    case 'today':
      start = new Date(now); start.setUTCHours(0, 0, 0, 0);
      end   = new Date(now); end.setUTCHours(23, 59, 59, 999);
      label = 'Today';
      break;
    case 'last7days':
      start = new Date(now.getTime() - 7 * 86_400_000);
      end   = now;
      label = 'Last 7 Days';
      break;
    case 'last30days':
      start = new Date(now.getTime() - 30 * 86_400_000);
      end   = now;
      label = 'Last 30 Days';
      break;
    case 'last90days':
      start = new Date(now.getTime() - 90 * 86_400_000);
      end   = now;
      label = 'Last 90 Days';
      break;
    case 'lastyear':
      start = new Date(now.getTime() - 365 * 86_400_000);
      end   = now;
      label = 'Last 12 Months';
      break;
    case 'custom': {
      if (!startDateStr || !endDateStr) {
        const e = new Error('custom range requires startDate and endDate query parameters.');
        e.status = 400; throw e;
      }
      start = new Date(startDateStr);
      end   = new Date(endDateStr);
      end.setUTCHours(23, 59, 59, 999);
      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        const e = new Error('Invalid date format. Use ISO 8601 (e.g. 2025-01-01).');
        e.status = 400; throw e;
      }
      if (start > end) {
        const e = new Error('startDate must be before endDate.');
        e.status = 400; throw e;
      }
      label = `${start.toLocaleDateString('en-GB')} – ${end.toLocaleDateString('en-GB')}`;
      break;
    }
    default: {
      const e = new Error(`Invalid date range "${range}". Valid values: ${VALID_RANGES.join(', ')}.`);
      e.status = 400; throw e;
    }
  }

  return {
    startTs:   Timestamp.fromDate(start),
    endTs:     Timestamp.fromDate(end),
    label,
    startDate: start,
    endDate:   end,
  };
}

/**
 * Returns a scoped Firestore collection query.
 * tenantId === null means superadmin — no tenant filter applied.
 */
function scopedRef(collection, tenantId) {
  const ref = db.collection(collection);
  return tenantId ? ref.where('tenantId', '==', tenantId) : ref;
}

/** Counts items by a key function. Returns { key: count }. */
function countBy(arr, keyFn) {
  const out = {};
  for (const item of arr) {
    const k = String(keyFn(item) || 'unknown');
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

/**
 * Computes average milliseconds between two Timestamp fields per item.
 * Items missing either field are skipped.
 */
function avgMsBetween(items, startField, endField) {
  let total = 0, count = 0;
  for (const item of items) {
    const t0 = item[startField]?.toDate?.()?.getTime?.();
    const t1 = item[endField]?.toDate?.()?.getTime?.();
    if (t0 && t1 && t1 > t0) { total += t1 - t0; count++; }
  }
  return count > 0 ? Math.round(total / count) : null;
}

/**
 * Divides the date range into ≤8 equal buckets and counts submitted/resolved
 * needs per bucket. Returns an array ordered chronologically.
 */
function buildTrend(items, startDate, endDate) {
  const start    = startDate.getTime();
  const duration = Math.max(endDate.getTime() - start, 1);
  const periods  = Math.min(8, Math.max(1, Math.ceil(duration / (7 * 86_400_000))));
  const periodMs = duration / periods;

  const buckets = Array.from({ length: periods }, (_, i) => ({
    periodStart:    new Date(start + i * periodMs).toISOString().split('T')[0],
    periodEnd:      new Date(start + (i + 1) * periodMs - 1).toISOString().split('T')[0],
    submitted:      0,
    resolved:       0,
    resolutionRate: 0,
  }));

  for (const n of items) {
    const t = n.createdAt?.toDate?.()?.getTime?.();
    if (!t) continue;
    const idx = Math.min(Math.floor((t - start) / periodMs), periods - 1);
    if (idx >= 0) {
      buckets[idx].submitted++;
      if (n.status === 'resolved') buckets[idx].resolved++;
    }
  }
  for (const b of buckets) {
    b.resolutionRate = b.submitted > 0 ? Math.round((b.resolved / b.submitted) * 100) : 0;
  }
  return buckets;
}

/** Extracts the first city/region token from a free-text location string. */
function toRegion(locationStr) {
  return (locationStr || 'Unknown').split(',')[0].trim() || 'Unknown';
}

/** Returns tenant name from Firestore, or fallback string. */
async function getTenantName(tenantId) {
  if (!tenantId) return 'All Tenants';
  try {
    const snap = await db.collection(COLLECTIONS.TENANTS).doc(tenantId).get();
    return snap.exists ? (snap.data().name || tenantId) : tenantId;
  } catch { return tenantId; }
}

/** Returns tenantId for query scoping: null for superadmin, tenantId otherwise. */
function getTenantScope(req) {
  return req.user.role === 'superadmin' ? null : (req.user.tenantId || null);
}

// ─── Data fetchers ────────────────────────────────────────────────────────────
// Each fetcher returns a plain JS object with all report data.
// Queries use date-range filtering at the Firestore level; secondary filters
// (status, channel, etc.) are applied in memory to minimise composite index deps.
// ─────────────────────────────────────────────────────────────────────────────

/** Report 1 — needs_impact */
async function fetchNeedsImpact(tenantId, startTs, endTs, startDate, endDate) {
  const [inRangeSnap, allTimeSnap] = await Promise.all([
    scopedRef(COLLECTIONS.NEEDS, tenantId)
      .where('createdAt', '>=', startTs).where('createdAt', '<=', endTs).get(),
    scopedRef(COLLECTIONS.NEEDS, tenantId).get(),
  ]);

  const needs    = queryToArray(inRangeSnap);
  const resolved = needs.filter(n => n.status === 'resolved');
  const allTime  = queryToArray(allTimeSnap);

  const avgResponseMs = avgMsBetween(needs.filter(n => n.matchedAt), 'createdAt', 'matchedAt');
  const byCategory    = countBy(needs, n => n.category);
  const byUrgency     = countBy(needs, n => n.urgency);
  const byStatus      = countBy(needs, n => n.status);
  const byChannel     = countBy(needs, n => n.channel || 'web');

  // Location summary — top 15 regions by need volume
  const byLocationRaw = countBy(needs, n => toRegion(n.location));
  const byLocation    = Object.entries(byLocationRaw)
    .sort((a, b) => b[1] - a[1]).slice(0, 15)
    .map(([location, count]) => ({ location, count }));

  // Unmet needs (never matched)
  const unmet = needs.filter(n => ['no_match_found', 'cancelled', 'pending_match'].includes(n.status));
  const unmetByCategory = countBy(unmet, n => n.category);
  const unmetByLocationRaw = countBy(unmet, n => toRegion(n.location));
  const topUnmetLocations  = Object.entries(unmetByLocationRaw)
    .sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([location, count]) => ({ location, count }));

  const allTotal    = allTime.length;
  const allResolved = allTime.filter(n => n.status === 'resolved').length;

  return {
    period: {
      total:          needs.length,
      resolved:       resolved.length,
      resolutionRate: needs.length > 0 ? Math.round((resolved.length / needs.length) * 100) : 0,
    },
    allTime: {
      total:          allTotal,
      resolved:       allResolved,
      resolutionRate: allTotal > 0 ? Math.round((allResolved / allTotal) * 100) : 0,
    },
    avgResponseMs,
    avgResponseHours: avgResponseMs !== null ? +(avgResponseMs / 3_600_000).toFixed(1) : null,
    byCategory,
    byUrgency,
    byStatus,
    byChannel,
    byLocation,
    unmet: {
      total:        unmet.length,
      rate:         needs.length > 0 ? Math.round((unmet.length / needs.length) * 100) : 0,
      byCategory:   unmetByCategory,
      topLocations: topUnmetLocations,
    },
    trend: buildTrend(needs, startDate, endDate),
  };
}

/** Report 2 — helper_performance */
async function fetchHelperPerformance(tenantId, startTs, endTs, filters = {}) {
  const { country, city, helpType, ratingMin, ratingMax } = filters;

  const [helpersSnap, matchesSnap] = await Promise.all([
    scopedRef(COLLECTIONS.HELPERS, tenantId).get(),
    scopedRef(COLLECTIONS.MATCHES, tenantId)
      .where('createdAt', '>=', startTs).where('createdAt', '<=', endTs).get(),
  ]);

  const allHelpers = queryToArray(helpersSnap);
  const matches    = queryToArray(matchesSnap);

  // Aggregate per-helper period stats from matches
  const matchStats = {};
  for (const m of matches) {
    if (!m.helperId) continue;
    if (!matchStats[m.helperId]) matchStats[m.helperId] = { accepted: 0, resolved: 0, responseTimes: [] };
    matchStats[m.helperId].accepted++;
    if (m.status === 'resolved') matchStats[m.helperId].resolved++;
    const t0 = m.createdAt?.toDate?.()?.getTime?.();
    const t1 = m.acceptedAt?.toDate?.()?.getTime?.();
    if (t0 && t1 && t1 > t0) matchStats[m.helperId].responseTimes.push(t1 - t0);
  }

  let helpers = allHelpers.map(h => {
    const s  = matchStats[h.id] || { accepted: 0, resolved: 0, responseTimes: [] };
    const rt = s.responseTimes.length > 0
      ? Math.round(s.responseTimes.reduce((a, b) => a + b, 0) / s.responseTimes.length)
      : null;
    return {
      id:               h.id,
      name:             h.name           || '—',
      status:           h.status,
      helpTypes:        h.helpTypes      || [],
      location:         h.location       || null,
      city:             h.city           || null,
      country:          h.country        || null,
      periodAccepted:   s.accepted,
      periodResolved:   s.resolved,
      periodRate:       s.accepted > 0 ? Math.round((s.resolved / s.accepted) * 100) : 0,
      avgResponseMs:    rt,
      avgResponseHours: rt !== null ? +(rt / 3_600_000).toFixed(1) : null,
      allTimeAssigned:  h.totalAssigned  || 0,
      allTimeResolved:  h.resolvedCount  || 0,
      allTimeRate:      (h.totalAssigned || 0) > 0
        ? Math.round((h.resolvedCount || 0) / h.totalAssigned * 100) : 0,
      avgRating:        typeof h.rating === 'number' ? Math.round(h.rating * 10) / 10 : null,
      lastActiveAt:     tsToISO(h.lastActiveAt),
      isOnline:         h.isOnline || false,
    };
  });

  // Apply optional filters in memory
  if (country)   helpers = helpers.filter(h => h.country?.toLowerCase() === country.toLowerCase());
  if (city)      helpers = helpers.filter(h => h.city?.toLowerCase()    === city.toLowerCase());
  if (helpType)  helpers = helpers.filter(h => Array.isArray(h.helpTypes) && h.helpTypes.includes(helpType));
  if (ratingMin != null) helpers = helpers.filter(h => h.avgRating !== null && h.avgRating >= ratingMin);
  if (ratingMax != null) helpers = helpers.filter(h => h.avgRating !== null && h.avgRating <= ratingMax);

  helpers.sort((a, b) => b.allTimeRate - a.allTimeRate);

  const active = helpers.filter(h => h.status === 'approved');
  return {
    summary: {
      totalHelpers:       helpers.length,
      activeHelpers:      active.length,
      avgResolutionRate:  helpers.length > 0
        ? Math.round(helpers.reduce((s, h) => s + h.allTimeRate, 0) / helpers.length) : 0,
    },
    helpers,
  };
}

/** Report 3 — geographic_coverage */
async function fetchGeographicCoverage(tenantId, startTs, endTs) {
  const [needsSnap, helpersSnap] = await Promise.all([
    scopedRef(COLLECTIONS.NEEDS, tenantId)
      .where('createdAt', '>=', startTs).where('createdAt', '<=', endTs).get(),
    scopedRef(COLLECTIONS.HELPERS, tenantId).get(),
  ]);

  const needs   = queryToArray(needsSnap);
  const helpers = queryToArray(helpersSnap).filter(h => h.status === 'approved');

  const needsByRegion   = countBy(needs,   n => toRegion(n.location));
  const helpersByRegion = countBy(helpers, h => h.city || toRegion(h.location));

  const allRegions = new Set([...Object.keys(needsByRegion), ...Object.keys(helpersByRegion)]);

  const coverage = Array.from(allRegions).map(region => {
    const n = needsByRegion[region]   || 0;
    const h = helpersByRegion[region] || 0;
    const gapScore = n - h * 5;
    return {
      region,
      needCount:      n,
      helperCount:    h,
      needsPerHelper: h > 0 ? +(n / h).toFixed(1) : null,
      gapScore,
      coverageStatus: h === 0 && n > 0 ? 'no_coverage'
        : gapScore > 10 ? 'underserved'
        : gapScore > 0  ? 'stretched'
        : 'adequate',
    };
  }).sort((a, b) => b.gapScore - a.gapScore);

  const gaps = coverage.filter(c => c.coverageStatus !== 'adequate');

  // Dominant need categories in top gap regions
  const topGapRegions = gaps.slice(0, 5).map(c => c.region);
  const categoryByGapRegion = {};
  for (const n of needs) {
    const region = toRegion(n.location);
    if (!topGapRegions.includes(region)) continue;
    if (!categoryByGapRegion[region]) categoryByGapRegion[region] = {};
    categoryByGapRegion[region][n.category] = (categoryByGapRegion[region][n.category] || 0) + 1;
  }

  return {
    summary: {
      totalRegions:     allRegions.size,
      coveredRegions:   coverage.filter(c => c.helperCount > 0).length,
      uncoveredRegions: coverage.filter(c => c.helperCount === 0 && c.needCount > 0).length,
      underservedCount: gaps.length,
    },
    coverage,
    gaps,
    categoryByGapRegion,
  };
}

/** Report 4 — donor_ngo_impact */
async function fetchDonorNGOImpact(tenantId, startTs, endTs) {
  const [needsSnap, helpersSnap] = await Promise.all([
    scopedRef(COLLECTIONS.NEEDS, tenantId)
      .where('createdAt', '>=', startTs).where('createdAt', '<=', endTs).get(),
    scopedRef(COLLECTIONS.HELPERS, tenantId).get(),
  ]);

  const needs    = queryToArray(needsSnap);
  const helpers  = queryToArray(helpersSnap).filter(h => h.status === 'approved');
  const resolved = needs.filter(n => n.status === 'resolved');

  // Unique people reached and helped (by userId or redacted phone)
  const reached = new Set(needs.map(n => n.userId || n.phone).filter(Boolean));
  const helped  = new Set(resolved.map(n => n.userId || n.phone).filter(Boolean));

  const avgResponseMs  = avgMsBetween(resolved, 'createdAt', 'matchedAt');
  const locationsServed = new Set(resolved.map(n => toRegion(n.location)).filter(r => r !== 'Unknown'));

  // Anonymized narratives — only where sharePermission === true
  const narratives = resolved
    .filter(n => n.sharePermission === true && n.description)
    .slice(0, 10)
    .map(n => ({
      category:   n.category,
      location:   toRegion(n.location),
      urgency:    n.urgency,
      summary:    String(n.description).slice(0, 200),
      resolvedAt: tsToISO(n.resolvedAt),
    }));

  return {
    impact: {
      totalNeedsSubmitted: needs.length,
      totalPeopleReached:  reached.size,
      totalPeopleHelped:   helped.size,
      needsResolved:       resolved.length,
      resolutionRate:      needs.length > 0 ? Math.round((resolved.length / needs.length) * 100) : 0,
      avgResponseHours:    avgResponseMs !== null ? +(avgResponseMs / 3_600_000).toFixed(1) : null,
      activeHelpers:       helpers.length,
      locationsServed:     locationsServed.size,
    },
    resolvedByCategory: countBy(resolved, n => n.category),
    geographicReach:    Array.from(locationsServed).slice(0, 20),
    needsByUrgency:     countBy(needs, n => n.urgency),
    impactNarratives:   narratives,
  };
}

/** Report 5 — financial_grant */
async function fetchFinancialGrant(tenantId, startTs, endTs) {
  const [impactData, allNeedsSnap, paymentsSnap] = await Promise.all([
    fetchDonorNGOImpact(tenantId, startTs, endTs),
    scopedRef(COLLECTIONS.NEEDS, tenantId).get(),
    // Payments collection: scoped to tenant if tenantId set
    (tenantId
      ? db.collection(COLLECTIONS.PAYMENTS).where('tenantId', '==', tenantId)
      : db.collection(COLLECTIONS.PAYMENTS)
    ).get(),
  ]);

  const allNeeds     = queryToArray(allNeedsSnap);
  const payments     = queryToArray(paymentsSnap);
  const totalRevenue = payments
    .filter(p => p.status === 'active' || p.status === 'succeeded')
    .reduce((sum, p) => sum + (Number(p.amountUSD) || Number(p.amount) || 0), 0);

  const helped        = impactData.impact.totalPeopleHelped;
  const costPerPerson = helped > 0 && totalRevenue > 0
    ? Math.round((totalRevenue / helped) * 100) / 100
    : null;

  const periodNeeds   = impactData.impact.totalNeedsSubmitted;

  return {
    ...impactData,
    financial: {
      totalPlatformFeesUSD:    Math.round(totalRevenue * 100) / 100,
      costPerPersonHelpedUSD:  costPerPerson,
      currency:                'USD',
      note: 'Platform-fee-based calculation. Excludes volunteer time and in-kind contributions.',
    },
    growth: {
      allTimeNeedsTotal: allNeeds.length,
      periodNeedsTotal:  periodNeeds,
      projectedAnnual:   periodNeeds > 0
        ? Math.round((periodNeeds / 30) * 365)   // rough annualisation from 30-day period
        : null,
    },
  };
}

/** Report 6 — compliance (no date range — all-time structural data) */
async function fetchCompliance(tenantId) {
  // Fetch all users, all helpers (filter by status in memory to avoid composite indexes)
  const [usersSnap, helpersSnap, flaggedSnap] = await Promise.all([
    scopedRef(COLLECTIONS.USERS,   tenantId).get(),
    scopedRef(COLLECTIONS.HELPERS, tenantId).get(),
    scopedRef(COLLECTIONS.USERS,   tenantId).where('flagged', '==', true).get(),
  ]);

  // Deletion requests from audit log
  let deletionSnap;
  try {
    let q = db.collection(COLLECTIONS.AUDIT_LOG).where('action', '==', 'data_deletion_request');
    if (tenantId) q = q.where('tenantId', '==', tenantId);
    deletionSnap = await q.limit(200).get();
  } catch {
    deletionSnap = { docs: [] };
  }

  const users   = queryToArray(usersSnap);
  const helpers = queryToArray(helpersSnap);
  const flagged = queryToArray(flaggedSnap);

  const byStatus = countBy(helpers, h => h.status || 'unknown');

  const helperVerification = {
    approved:  byStatus.approved  || byStatus.active          || 0,
    pending:   byStatus.pending   || byStatus.pending_approval || 0,
    rejected:  byStatus.rejected  || 0,
    suspended: byStatus.suspended || 0,
    total:     helpers.length,
  };

  const deletionRequests = queryToArray(deletionSnap).map(d => ({
    id:          d.id,
    requestedAt: tsToISO(d.timestamp),
    actorId:     d.actorId,
    status:      d.meta?.status || 'pending',
    completedAt: d.meta?.completedAt || null,
  }));

  const flaggedAccounts = flagged.map(u => ({
    id:         u.id,
    role:       u.role,
    flagReason: u.flagReason  || 'unspecified',
    flaggedAt:  tsToISO(u.flaggedAt),
    resolvedAt: tsToISO(u.flagResolvedAt),
    resolved:   !!u.flagResolvedAt,
  }));

  return {
    generatedAt:          new Date().toISOString(),
    complianceFrameworks: ['GDPR (EU 2016/679)', 'CCPA (California Civil Code § 1798.100)'],
    dataInventory: {
      seeker:  { dataHeld: ['location strings', 'need categories', 'urgency', 'language', 'phone (last 4 only)'], legalBasis: 'Legitimate interest — humanitarian aid services' },
      helper:  { dataHeld: ['name', 'location', 'help types', 'verification doc reference', 'rating', 'phone (last 4 only)'], legalBasis: 'Contract — service provider agreement' },
      admin:   { dataHeld: ['role', 'tenant association', 'audit log entries', 'phone (last 4 only)'], legalBasis: 'Contract — platform administration' },
    },
    usersByRole:  countBy(users,   u => u.role   || 'unknown'),
    totalUsers:   users.length,
    totalHelpers: helpers.length,
    helperVerification,
    flaggedAccounts: {
      total:    flagged.length,
      resolved: flaggedAccounts.filter(f => f.resolved).length,
      pending:  flaggedAccounts.filter(f => !f.resolved).length,
      accounts: flaggedAccounts,
    },
    deletionRequests: {
      total:     deletionRequests.length,
      completed: deletionRequests.filter(d => d.status === 'completed').length,
      pending:   deletionRequests.filter(d => d.status !== 'completed').length,
      requests:  deletionRequests,
    },
    retentionPolicy: {
      userProfiles:    '7 years from last activity (GDPR Art. 5 / CCPA)',
      needsData:       '7 years minimum — humanitarian accountability',
      auditLog:        '7 years — legal hold for compliance reporting',
      helperDocuments: '7 years from verification date',
      paymentRecords:  '7 years — financial regulation requirement',
      smsVoiceLogs:    '2 years — Twilio data policy',
    },
  };
}

/** Report 7 — sms_feature_phone */
async function fetchSMSFeaturePhone(tenantId, startTs, endTs, startDate, endDate) {
  const [allNeedsSnap, smsQueueSnap] = await Promise.all([
    scopedRef(COLLECTIONS.NEEDS, tenantId)
      .where('createdAt', '>=', startTs).where('createdAt', '<=', endTs).get(),
    scopedRef(COLLECTIONS.SMS_QUEUE, tenantId)
      .where('createdAt', '>=', startTs).where('createdAt', '<=', endTs).get(),
  ]);

  const allNeeds = queryToArray(allNeedsSnap);
  const smsQueue = queryToArray(smsQueueSnap);

  // Split by channel in memory — avoids compound equality+range Firestore query
  const smsNeeds = allNeeds.filter(n => n.channel === 'sms');
  const appNeeds = allNeeds.filter(n => ['web', 'app', 'voice'].includes(n.channel || 'web'));

  const smsResolved = smsNeeds.filter(n => n.status === 'resolved').length;
  const appResolved = appNeeds.filter(n => n.status === 'resolved').length;
  const smsRate     = smsNeeds.length > 0 ? Math.round((smsResolved / smsNeeds.length) * 100) : 0;
  const appRate     = appNeeds.length  > 0 ? Math.round((appResolved / appNeeds.length)  * 100) : 0;

  const smsByRegion   = countBy(smsNeeds, n => toRegion(n.location));
  const topRegions    = Object.entries(smsByRegion)
    .sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([region, count]) => ({ region, count }));

  const inbound  = smsQueue.filter(m => m.direction === 'inbound'  || !m.direction).length;
  const outbound = smsQueue.filter(m => m.direction === 'outbound').length;

  return {
    summary: {
      totalSMSNeeds:       smsNeeds.length,
      smsResolutionRate:   smsRate,
      appResolutionRate:   appRate,
      totalAppNeeds:       appNeeds.length,
      totalAllNeeds:       allNeeds.length,
      smsShare:            allNeeds.length > 0 ? Math.round((smsNeeds.length / allNeeds.length) * 100) : 0,
      inboundSMSMessages:  inbound,
      outboundSMSMessages: outbound,
    },
    smsByCategory: countBy(smsNeeds, n => n.category),
    smsByLanguage: countBy(smsNeeds, n => n.language || 'unknown'),
    topRegions,
    channelComparison: {
      sms:    { needs: smsNeeds.length, resolved: smsResolved, rate: smsRate },
      appWeb: { needs: appNeeds.length, resolved: appResolved, rate: appRate },
    },
    trend: buildTrend(smsNeeds, startDate, endDate),
  };
}

// ─── Data-fetcher router ──────────────────────────────────────────────────────

const DATA_FETCHERS = {
  needs_impact:        (tid, s, e, sd, ed, f) => fetchNeedsImpact(tid, s, e, sd, ed),
  helper_performance:  (tid, s, e, sd, ed, f) => fetchHelperPerformance(tid, s, e, f),
  geographic_coverage: (tid, s, e, sd, ed, f) => fetchGeographicCoverage(tid, s, e),
  donor_ngo_impact:    (tid, s, e, sd, ed, f) => fetchDonorNGOImpact(tid, s, e),
  financial_grant:     (tid, s, e, sd, ed, f) => fetchFinancialGrant(tid, s, e),
  compliance:          (tid, s, e, sd, ed, f) => fetchCompliance(tid),
  sms_feature_phone:   (tid, s, e, sd, ed, f) => fetchSMSFeaturePhone(tid, s, e, sd, ed),
};

// ─── PDF Builder ──────────────────────────────────────────────────────────────

/**
 * Streams a branded PDF to the Express response.
 * Called AFTER res headers are set by the route handler.
 *
 * Layout: cover page → AI narrative → report-specific data sections → footer on every page.
 */
function buildPDF(res, reportType, data, aiSummary, { tenantName, dateRangeLabel, generatedAt }) {
  const MARGIN = 50;
  const doc = new PDFDocument({
    size: 'A4', margin: MARGIN, autoFirstPage: false,
    info: { Title: `BridgeUp — ${REPORT_TITLES[reportType]}`, Author: 'BridgeUp Platform' },
  });

  // ── Fix 3: PDF stream error handling ──────────────────────────────────────────
  // Once doc.pipe(res) is called the response is committed. If PDFKit emits an
  // error event after that point we cannot send an HTTP error response, so we
  // destroy the response stream to signal an abrupt close to the client (they
  // see a network/download error rather than a silently truncated PDF).
  doc.on('error', (pdfErr) => {
    console.error('[Reports] PDFKit stream error:', pdfErr.message);
    res.destroy(pdfErr);
  });

  doc.pipe(res);

  const PW = doc.page.width - MARGIN * 2;
  let pageNum = 0;

  function addPage() {
    doc.addPage();
    pageNum++;
    // Footer
    doc.save().fontSize(8).fillColor(PDF_GRAY)
      .text(
        `BridgeUp  |  ${REPORT_TITLES[reportType]}  |  Page ${pageNum}  |  ${generatedAt}`,
        MARGIN, doc.page.height - 35, { width: PW, align: 'center' }
      ).restore();
    doc.y = MARGIN + 10;
  }

  function guard(h = 60) {
    if (doc.y + h > doc.page.height - 55) addPage();
  }

  function secHeader(title) {
    guard(50);
    doc.moveDown(0.5)
      .fontSize(13).font('Helvetica-Bold').fillColor(PDF_BLUE).text(title)
      .moveDown(0.2)
      .moveTo(MARGIN, doc.y).lineTo(MARGIN + PW, doc.y)
      .strokeColor(PDF_BLUE).lineWidth(1).stroke()
      .moveDown(0.4);
    doc.fontSize(10).font('Helvetica').fillColor(PDF_BLACK);
  }

  function kv(label, value) {
    guard(18);
    doc.fontSize(10)
      .font('Helvetica-Bold').fillColor(PDF_GRAY).text(`${label}:`, { continued: true })
      .font('Helvetica').fillColor(PDF_BLACK).text(`  ${value ?? '—'}`);
  }

  function tableRow(cols, widths, header = false) {
    guard(20);
    const rowY = doc.y;
    let x = MARGIN;
    doc.fontSize(header ? 9 : 9)
      .font(header ? 'Helvetica-Bold' : 'Helvetica')
      .fillColor(header ? PDF_BLUE : PDF_BLACK);
    for (let i = 0; i < cols.length; i++) {
      doc.text(String(cols[i] ?? '—'), x + 2, rowY, { width: widths[i] - 4, height: 16, ellipsis: true, lineBreak: false });
      x += widths[i];
    }
    doc.y = rowY + 16;
    doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + PW, doc.y).strokeColor(PDF_LIGHT).lineWidth(0.5).stroke();
    doc.font('Helvetica').fillColor(PDF_BLACK);
  }

  // ── Cover Page ───────────────────────────────────────────────────────────────
  addPage();

  // Logo placeholder
  doc.save().rect(MARGIN, MARGIN + 10, 130, 48).fillColor(PDF_BLUE).fill()
    .fontSize(15).font('Helvetica-Bold').fillColor('#FFFFFF')
    .text('BridgeUp', MARGIN, MARGIN + 25, { width: 130, align: 'center' })
    .restore();

  doc.y = MARGIN + 80;
  doc.fontSize(26).font('Helvetica-Bold').fillColor(PDF_BLUE)
    .text(REPORT_TITLES[reportType], MARGIN, doc.y, { width: PW });
  doc.moveDown(0.4).fontSize(14).font('Helvetica').fillColor(PDF_GRAY).text(dateRangeLabel);
  doc.moveDown(0.3).fontSize(12).fillColor(PDF_BLACK).text(`Organisation: ${tenantName}`);
  doc.moveDown(0.3).fontSize(10).fillColor(PDF_GRAY).text(`Generated: ${generatedAt}`);

  // AI summary on cover if available
  if (aiSummary) {
    doc.moveDown(1.5);
    secHeader('AI Narrative Summary');
    doc.fontSize(10).font('Helvetica').fillColor(PDF_BLACK)
      .text(aiSummary, MARGIN, doc.y, { width: PW, lineGap: 2 });
  }

  // ── Report-specific sections ─────────────────────────────────────────────────
  switch (reportType) {

    case 'needs_impact': {
      addPage();
      secHeader('Period Overview');
      kv('Total Needs Submitted', data.period?.total);
      kv('Resolved', data.period?.resolved);
      kv('Resolution Rate', `${data.period?.resolutionRate}%`);
      kv('Avg Response Time', data.avgResponseHours != null ? `${data.avgResponseHours} hours` : 'N/A');
      kv('All-Time Total', data.allTime?.total);
      kv('All-Time Resolution Rate', `${data.allTime?.resolutionRate}%`);

      secHeader('By Category');
      tableRow(['Category', 'Count'], [220, 80], true);
      for (const [k, v] of Object.entries(data.byCategory || {})) tableRow([k, v], [220, 80]);

      secHeader('By Status');
      tableRow(['Status', 'Count'], [220, 80], true);
      for (const [k, v] of Object.entries(data.byStatus || {})) tableRow([k, v], [220, 80]);

      secHeader('By Urgency');
      tableRow(['Urgency', 'Count'], [220, 80], true);
      for (const [k, v] of Object.entries(data.byUrgency || {})) tableRow([k, v], [220, 80]);

      secHeader('Top Locations by Need Volume');
      tableRow(['Location', 'Count'], [300, 80], true);
      for (const l of (data.byLocation || []).slice(0, 12)) tableRow([l.location, l.count], [300, 80]);

      secHeader('Unmet Needs Analysis');
      kv('Total Unmet', data.unmet?.total);
      kv('Unmet Rate', `${data.unmet?.rate}%`);
      doc.moveDown(0.3);
      tableRow(['Category', 'Unmet Count'], [220, 80], true);
      for (const [k, v] of Object.entries(data.unmet?.byCategory || {})) tableRow([k, v], [220, 80]);

      secHeader('Resolution Trend');
      tableRow(['Period Start', 'Period End', 'Submitted', 'Resolved', 'Rate%'], [110, 110, 80, 80, 70], true);
      for (const b of (data.trend || [])) tableRow([b.periodStart, b.periodEnd, b.submitted, b.resolved, `${b.resolutionRate}%`], [110, 110, 80, 80, 70]);
      break;
    }

    case 'helper_performance': {
      addPage();
      secHeader('Summary');
      kv('Total Helpers', data.summary?.totalHelpers);
      kv('Active Helpers', data.summary?.activeHelpers);
      kv('Platform Avg Resolution Rate', `${data.summary?.avgResolutionRate}%`);

      secHeader('Helper Leaderboard (All-Time Resolution Rate)');
      tableRow(['Name', 'Status', 'Resolved', 'Assigned', 'Rate%', 'Rating', 'Last Active'], [120, 70, 55, 55, 48, 50, 100], true);
      for (const h of (data.helpers || []).slice(0, 40)) {
        tableRow([h.name, h.status, h.allTimeResolved, h.allTimeAssigned, `${h.allTimeRate}%`, h.avgRating ?? '—', h.lastActiveAt ? h.lastActiveAt.split('T')[0] : '—'], [120, 70, 55, 55, 48, 50, 100]);
      }
      break;
    }

    case 'geographic_coverage': {
      addPage();
      secHeader('Coverage Summary');
      kv('Total Regions', data.summary?.totalRegions);
      kv('Covered Regions', data.summary?.coveredRegions);
      kv('Uncovered Regions (Needs Exist)', data.summary?.uncoveredRegions);
      kv('Underserved Regions', data.summary?.underservedCount);

      secHeader('Coverage by Region');
      tableRow(['Region', 'Needs', 'Helpers', 'Status'], [210, 70, 70, 120], true);
      for (const c of (data.coverage || []).slice(0, 30)) tableRow([c.region, c.needCount, c.helperCount, c.coverageStatus], [210, 70, 70, 120]);

      secHeader('Coverage Gaps (High Need / Low Helper)');
      tableRow(['Region', 'Needs', 'Helpers', 'Gap Score'], [210, 70, 70, 90], true);
      for (const g of (data.gaps || []).slice(0, 15)) tableRow([g.region, g.needCount, g.helperCount, g.gapScore], [210, 70, 70, 90]);
      break;
    }

    case 'donor_ngo_impact': {
      addPage();
      secHeader('Impact Summary');
      kv('Total People Reached',  data.impact?.totalPeopleReached);
      kv('Total People Helped',   data.impact?.totalPeopleHelped);
      kv('Needs Resolved',        data.impact?.needsResolved);
      kv('Resolution Rate',       `${data.impact?.resolutionRate}%`);
      kv('Avg Response Time',     data.impact?.avgResponseHours != null ? `${data.impact.avgResponseHours} hours` : 'N/A');
      kv('Active Helpers',        data.impact?.activeHelpers);
      kv('Locations Served',      data.impact?.locationsServed);

      secHeader('Resolved Needs by Category');
      tableRow(['Category', 'Count'], [220, 80], true);
      for (const [k, v] of Object.entries(data.resolvedByCategory || {})) tableRow([k, v], [220, 80]);

      secHeader('Geographic Reach');
      doc.fontSize(10).text((data.geographicReach || []).join(', ') || 'No data', { width: PW });

      if ((data.impactNarratives || []).length > 0) {
        secHeader('Anonymized Impact Narratives');
        for (const n of data.impactNarratives) {
          guard(60);
          doc.fontSize(10).font('Helvetica-Bold').text(`${n.category} — ${n.location}`)
            .font('Helvetica').fillColor(PDF_GRAY).fontSize(9).text(n.urgency + ' urgency')
            .fillColor(PDF_BLACK).fontSize(10).text(n.summary, { width: PW }).moveDown(0.5);
        }
      }
      break;
    }

    case 'financial_grant': {
      addPage();
      secHeader('Financial Summary');
      kv('Total Platform Fees (USD)',     `$${data.financial?.totalPlatformFeesUSD}`);
      kv('Cost per Person Helped (USD)',  data.financial?.costPerPersonHelpedUSD != null ? `$${data.financial.costPerPersonHelpedUSD}` : 'N/A');
      kv('Note',                          data.financial?.note);

      secHeader('Impact Metrics');
      kv('People Helped',     data.impact?.totalPeopleHelped);
      kv('Resolution Rate',   `${data.impact?.resolutionRate}%`);
      kv('Locations Served',  data.impact?.locationsServed);
      kv('Active Helpers',    data.impact?.activeHelpers);

      secHeader('Growth Projections');
      kv('All-Time Needs Total',  data.growth?.allTimeNeedsTotal);
      kv('Period Needs Total',    data.growth?.periodNeedsTotal);
      kv('Projected Annual Needs', data.growth?.projectedAnnual ?? 'N/A');

      secHeader('Resolved by Category');
      tableRow(['Category', 'Count'], [220, 80], true);
      for (const [k, v] of Object.entries(data.resolvedByCategory || {})) tableRow([k, v], [220, 80]);
      break;
    }

    case 'compliance': {
      addPage();
      secHeader('Compliance Overview');
      kv('Generated At',   data.generatedAt);
      kv('Frameworks',     (data.complianceFrameworks || []).join(', '));
      kv('Total Users',    data.totalUsers);
      kv('Total Helpers',  data.totalHelpers);

      secHeader('User Type Distribution');
      tableRow(['Role', 'Count'], [220, 80], true);
      for (const [k, v] of Object.entries(data.usersByRole || {})) tableRow([k, v], [220, 80]);

      secHeader('Helper Verification Status');
      const hv = data.helperVerification || {};
      for (const [label, val] of [['Approved', hv.approved], ['Pending', hv.pending], ['Rejected', hv.rejected], ['Suspended', hv.suspended], ['Total', hv.total]]) {
        tableRow([label, val], [220, 80], label === 'Approved');
      }

      secHeader('Flagged Accounts');
      kv('Total Flagged',    data.flaggedAccounts?.total);
      kv('Resolved',         data.flaggedAccounts?.resolved);
      kv('Pending',          data.flaggedAccounts?.pending);
      if ((data.flaggedAccounts?.accounts || []).length > 0) {
        doc.moveDown(0.3);
        tableRow(['ID', 'Role', 'Reason', 'Flagged At', 'Resolved'], [90, 70, 130, 120, 60], true);
        for (const f of (data.flaggedAccounts.accounts || []).slice(0, 20)) {
          tableRow([f.id, f.role, f.flagReason, f.flaggedAt ? f.flaggedAt.split('T')[0] : '—', f.resolved ? 'Yes' : 'No'], [90, 70, 130, 120, 60]);
        }
      }

      secHeader('Data Deletion Requests');
      kv('Total Requests', data.deletionRequests?.total);
      kv('Completed',      data.deletionRequests?.completed);
      kv('Pending',        data.deletionRequests?.pending);

      secHeader('Data Retention Policy');
      for (const [k, v] of Object.entries(data.retentionPolicy || {})) {
        kv(k.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase()), v);
      }
      break;
    }

    case 'sms_feature_phone': {
      addPage();
      secHeader('SMS Summary');
      kv('Total SMS Needs',        data.summary?.totalSMSNeeds);
      kv('SMS Resolution Rate',    `${data.summary?.smsResolutionRate}%`);
      kv('App/Web Resolution Rate',`${data.summary?.appResolutionRate}%`);
      kv('SMS Share of All Needs', `${data.summary?.smsShare}%`);
      kv('Inbound SMS Messages',   data.summary?.inboundSMSMessages);
      kv('Outbound SMS Messages',  data.summary?.outboundSMSMessages);

      secHeader('Channel Comparison');
      tableRow(['Channel', 'Needs', 'Resolved', 'Rate%'], [130, 80, 80, 80], true);
      const cc = data.channelComparison || {};
      tableRow(['SMS',     cc.sms?.needs,    cc.sms?.resolved,    `${cc.sms?.rate}%`],    [130, 80, 80, 80]);
      tableRow(['App/Web', cc.appWeb?.needs, cc.appWeb?.resolved, `${cc.appWeb?.rate}%`], [130, 80, 80, 80]);

      secHeader('SMS Needs by Category');
      tableRow(['Category', 'Count'], [220, 80], true);
      for (const [k, v] of Object.entries(data.smsByCategory || {})) tableRow([k, v], [220, 80]);

      secHeader('Top Regions by SMS Volume');
      tableRow(['Region', 'SMS Needs'], [260, 80], true);
      for (const r of (data.topRegions || [])) tableRow([r.region, r.count], [260, 80]);

      secHeader('SMS Submission Trend');
      tableRow(['Period Start', 'Period End', 'Submitted', 'Resolved', 'Rate%'], [110, 110, 80, 80, 70], true);
      for (const b of (data.trend || [])) tableRow([b.periodStart, b.periodEnd, b.submitted, b.resolved, `${b.resolutionRate}%`], [110, 110, 80, 80, 70]);
      break;
    }

    default:
      doc.fontSize(12).text('Report data is available in the JSON response.');
  }

  doc.end();
}

// ─── Excel Builder ────────────────────────────────────────────────────────────

function buildExcel(res, reportType, data, aiSummary, { tenantName, dateRangeLabel, generatedAt }) {
  const wb = XLSX.utils.book_new();

  // Summary sheet — always first
  const summaryRows = [
    ['BridgeUp Report'],
    [REPORT_TITLES[reportType]],
    ['Date Range', dateRangeLabel],
    ['Organisation', tenantName],
    ['Generated', generatedAt],
    [],
  ];
  if (aiSummary) { summaryRows.push(['AI Narrative Summary']); summaryRows.push([aiSummary]); summaryRows.push([]); }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summaryRows), 'Summary');

  // Report-specific data sheets
  switch (reportType) {

    case 'needs_impact': {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
        ['Metric', 'Period Value', 'All-Time Value'],
        ['Total Needs', data.period?.total, data.allTime?.total],
        ['Resolved',   data.period?.resolved, data.allTime?.resolved],
        ['Resolution Rate (%)', data.period?.resolutionRate, data.allTime?.resolutionRate],
        ['Avg Response (hours)', data.avgResponseHours ?? 'N/A', ''],
        ['Unmet Needs', data.unmet?.total, ''],
        ['Unmet Rate (%)', data.unmet?.rate, ''],
      ]), 'Metrics');

      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
        ['Category', 'Count'], ...Object.entries(data.byCategory || {}),
      ]), 'By Category');

      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
        ['Location', 'Count'], ...(data.byLocation || []).map(l => [l.location, l.count]),
      ]), 'By Location');

      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
        ['Status', 'Count'], ...Object.entries(data.byStatus || {}),
      ]), 'By Status');

      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
        ['Period Start', 'Period End', 'Submitted', 'Resolved', 'Rate (%)'],
        ...(data.trend || []).map(b => [b.periodStart, b.periodEnd, b.submitted, b.resolved, b.resolutionRate]),
      ]), 'Trend');

      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
        ['Category', 'Unmet Count'], ...Object.entries(data.unmet?.byCategory || {}),
      ]), 'Unmet Needs');
      break;
    }

    case 'helper_performance': {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
        ['ID', 'Name', 'Status', 'Help Types', 'Country', 'City',
         'Period Accepted', 'Period Resolved', 'Period Rate (%)',
         'All-Time Assigned', 'All-Time Resolved', 'All-Time Rate (%)',
         'Avg Rating', 'Avg Response (hrs)', 'Last Active'],
        ...(data.helpers || []).map(h => [
          h.id, h.name, h.status, (h.helpTypes || []).join(', '), h.country, h.city,
          h.periodAccepted, h.periodResolved, h.periodRate,
          h.allTimeAssigned, h.allTimeResolved, h.allTimeRate,
          h.avgRating ?? '', h.avgResponseHours ?? '',
          h.lastActiveAt ? h.lastActiveAt.split('T')[0] : '',
        ]),
      ]), 'Helper Performance');
      break;
    }

    case 'geographic_coverage': {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
        ['Region', 'Need Count', 'Helper Count', 'Needs per Helper', 'Gap Score', 'Coverage Status'],
        ...(data.coverage || []).map(c => [c.region, c.needCount, c.helperCount, c.needsPerHelper ?? '', c.gapScore, c.coverageStatus]),
      ]), 'Coverage by Region');

      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
        ['Region', 'Need Count', 'Helper Count', 'Gap Score'],
        ...(data.gaps || []).map(g => [g.region, g.needCount, g.helperCount, g.gapScore]),
      ]), 'Coverage Gaps');
      break;
    }

    case 'donor_ngo_impact': {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
        ['Metric', 'Value'],
        ['People Reached',      data.impact?.totalPeopleReached],
        ['People Helped',       data.impact?.totalPeopleHelped],
        ['Needs Resolved',      data.impact?.needsResolved],
        ['Resolution Rate (%)', data.impact?.resolutionRate],
        ['Avg Response (hrs)',  data.impact?.avgResponseHours ?? 'N/A'],
        ['Active Helpers',      data.impact?.activeHelpers],
        ['Locations Served',    data.impact?.locationsServed],
      ]), 'Impact Metrics');

      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
        ['Category', 'Resolved Count'], ...Object.entries(data.resolvedByCategory || {}),
      ]), 'By Category');

      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
        ['Category', 'Location', 'Urgency', 'Summary', 'Resolved At'],
        ...(data.impactNarratives || []).map(n => [n.category, n.location, n.urgency, n.summary, n.resolvedAt]),
      ]), 'Impact Narratives');
      break;
    }

    case 'financial_grant': {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
        ['Metric', 'Value'],
        ['Total Platform Fees (USD)',    data.financial?.totalPlatformFeesUSD],
        ['Cost per Person (USD)',        data.financial?.costPerPersonHelpedUSD ?? 'N/A'],
        ['People Helped',               data.impact?.totalPeopleHelped],
        ['Resolution Rate (%)',         data.impact?.resolutionRate],
        ['Locations Served',            data.impact?.locationsServed],
        ['All-Time Needs Total',        data.growth?.allTimeNeedsTotal],
        ['Period Needs Total',          data.growth?.periodNeedsTotal],
        ['Projected Annual Needs',      data.growth?.projectedAnnual ?? 'N/A'],
        ['Note',                        data.financial?.note],
      ]), 'Financial Grant');

      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
        ['Category', 'Resolved Count'], ...Object.entries(data.resolvedByCategory || {}),
      ]), 'By Category');
      break;
    }

    case 'compliance': {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
        ['Metric', 'Value'],
        ['Generated At',    data.generatedAt],
        ['Frameworks',      (data.complianceFrameworks || []).join(', ')],
        ['Total Users',     data.totalUsers],
        ['Total Helpers',   data.totalHelpers],
      ]), 'Compliance Overview');

      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
        ['Role', 'Count'], ...Object.entries(data.usersByRole || {}),
      ]), 'User Types');

      const hv = data.helperVerification || {};
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
        ['Status', 'Count'],
        ['Approved', hv.approved], ['Pending', hv.pending],
        ['Rejected', hv.rejected], ['Suspended', hv.suspended], ['Total', hv.total],
      ]), 'Helper Verification');

      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
        ['ID', 'Role', 'Flag Reason', 'Flagged At', 'Resolved At', 'Resolved'],
        ...(data.flaggedAccounts?.accounts || []).map(f => [f.id, f.role, f.flagReason, f.flaggedAt || '', f.resolvedAt || '', f.resolved ? 'Yes' : 'No']),
      ]), 'Flagged Accounts');

      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
        ['ID', 'Requested At', 'Status', 'Completed At'],
        ...(data.deletionRequests?.requests || []).map(d => [d.id, d.requestedAt || '', d.status, d.completedAt || '']),
      ]), 'Deletion Requests');

      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
        ['Data Type', 'Retention Period'],
        ...Object.entries(data.retentionPolicy || {}).map(([k, v]) => [k, v]),
      ]), 'Retention Policy');
      break;
    }

    case 'sms_feature_phone': {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
        ['Metric', 'Value'],
        ['Total SMS Needs',         data.summary?.totalSMSNeeds],
        ['SMS Resolution Rate (%)', data.summary?.smsResolutionRate],
        ['App Resolution Rate (%)', data.summary?.appResolutionRate],
        ['SMS Share of All Needs (%)', data.summary?.smsShare],
        ['Inbound SMS Messages',    data.summary?.inboundSMSMessages],
        ['Outbound SMS Messages',   data.summary?.outboundSMSMessages],
      ]), 'SMS Summary');

      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
        ['Category', 'Count'], ...Object.entries(data.smsByCategory || {}),
      ]), 'By Category');

      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
        ['Region', 'SMS Needs'], ...(data.topRegions || []).map(r => [r.region, r.count]),
      ]), 'By Region');

      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
        ['Period Start', 'Period End', 'Submitted', 'Resolved', 'Rate (%)'],
        ...(data.trend || []).map(b => [b.periodStart, b.periodEnd, b.submitted, b.resolved, b.resolutionRate]),
      ]), 'Trend');
      break;
    }
  }

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="bridgeup_${reportType}_${Date.now()}.xlsx"`);
  res.send(buf);
}

// ─── Shared request handler — parse params, fetch data, call Claude ──────────

async function resolveReportRequest(req, { bodyOrQuery }) {
  const { type } = req.params;

  if (!VALID_REPORT_TYPES.includes(type)) {
    const e = new Error(`Invalid report type "${type}". Valid types: ${VALID_REPORT_TYPES.join(', ')}.`);
    e.status = 400; throw e;
  }

  const {
    range = 'last30days',
    startDate,
    endDate,
    language = 'en',
    country, city, helpType, ratingMin, ratingMax,
  } = bodyOrQuery;

  if (typeof language !== 'string' || !/^[a-z]{2,3}(-[A-Z]{2})?$/.test(language)) {
    const e = new Error('Invalid language code. Use ISO 639-1 format (e.g. "en", "fr", "rw").');
    e.status = 400; throw e;
  }

  // ── Fix 1: cap range string length before it can be embedded in an error message
  const rangeStr = String(range).slice(0, 40);
  const rangeResult = parseRange(rangeStr, startDate, endDate);
  const tenantId    = getTenantScope(req);

  // ── Fix 2: cap filter string lengths; validate ratingMin/ratingMax as numbers in [0,5]
  const STR_MAX = 100;
  const parseRating = (val, label) => {
    if (val == null) return undefined;
    const n = parseFloat(val);
    if (isNaN(n) || n < 0 || n > 5) {
      const e = new Error(`${label} must be a number between 0 and 5.`);
      e.status = 400; throw e;
    }
    return n;
  };
  const filters     = {
    country:  country   ? String(country).trim().slice(0, STR_MAX)   : undefined,
    city:     city      ? String(city).trim().slice(0, STR_MAX)       : undefined,
    helpType: helpType  ? String(helpType).trim().slice(0, STR_MAX)   : undefined,
    ratingMin: parseRating(ratingMin, 'ratingMin'),
    ratingMax: parseRating(ratingMax, 'ratingMax'),
  };

  // Additional cross-field validation
  if (filters.ratingMin != null && filters.ratingMax != null && filters.ratingMin > filters.ratingMax) {
    const e = new Error('ratingMin must not be greater than ratingMax.');
    e.status = 400; throw e;
  }

  const { startTs, endTs, label: dateRangeLabel, startDate: sDate, endDate: eDate } = rangeResult;
  const data = await DATA_FETCHERS[type](tenantId, startTs, endTs, sDate, eDate, filters);

  let aiSummary = null;
  try {
    const tenantName = await getTenantName(req.user.tenantId);
    aiSummary = await generateReportSummary(type, data, { language, dateRange: dateRangeLabel, tenantName });
  } catch (aiErr) {
    console.error(`[Reports] AI summary failed for ${type}:`, aiErr.message);
  }

  return { type, data, aiSummary, rangeResult, tenantId, language };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /api/reports/:type
 * Returns live report data as JSON with an AI narrative summary.
 * Supports all date range values; compliance ignores date range (all-time).
 */
router.get('/:type', requireAuth, requireReportAccess, reportLimiter, async (req, res, next) => {
  try {
    const { type, data, aiSummary, rangeResult, tenantId } = await resolveReportRequest(req, {
      bodyOrQuery: req.query,
    });

    writeAuditLog({
      action:   'report_generated',
      actorId:  req.user.userId,
      targetId: type,
      tenantId: req.user.role === 'superadmin' ? null : req.user.tenantId,
      meta:     { reportType: type, range: req.query.range || 'last30days', dateRangeLabel: rangeResult.label },
    }).catch(() => {});

    res.json({
      reportType:  type,
      dateRange:   {
        range:     req.query.range || 'last30days',
        label:     rangeResult.label,
        startDate: rangeResult.startDate.toISOString(),
        endDate:   rangeResult.endDate.toISOString(),
      },
      scope:       tenantId ? `tenant:${tenantId}` : 'all_tenants',
      generatedAt: new Date().toISOString(),
      data,
      aiSummary,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/reports/:type/export/pdf
 * Generates and streams a branded multi-page PDF.
 * Body params same as GET query params.
 */
router.post('/:type/export/pdf', requireAuth, requireReportAccess, reportLimiter, async (req, res, next) => {
  try {
    const { type, data, aiSummary, rangeResult } = await resolveReportRequest(req, {
      bodyOrQuery: req.body || {},
    });

    const tenantName  = await getTenantName(req.user.tenantId);
    const generatedAt = new Date().toUTCString();

    writeAuditLog({
      action:   'report_exported_pdf',
      actorId:  req.user.userId,
      targetId: type,
      tenantId: req.user.role === 'superadmin' ? null : req.user.tenantId,
      meta:     { reportType: type, format: 'pdf' },
    }).catch(() => {});

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="bridgeup_${type}_${Date.now()}.pdf"`);
    buildPDF(res, type, data, aiSummary, { tenantName, dateRangeLabel: rangeResult.label, generatedAt });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/reports/:type/export/excel
 * Generates and streams an xlsx workbook with per-type data sheets.
 * Body params same as GET query params.
 */
router.post('/:type/export/excel', requireAuth, requireReportAccess, reportLimiter, async (req, res, next) => {
  try {
    const { type, data, aiSummary, rangeResult } = await resolveReportRequest(req, {
      bodyOrQuery: req.body || {},
    });

    const tenantName  = await getTenantName(req.user.tenantId);
    const generatedAt = new Date().toISOString();

    writeAuditLog({
      action:   'report_exported_excel',
      actorId:  req.user.userId,
      targetId: type,
      tenantId: req.user.role === 'superadmin' ? null : req.user.tenantId,
      meta:     { reportType: type, format: 'excel' },
    }).catch(() => {});

    buildExcel(res, type, data, aiSummary, { tenantName, dateRangeLabel: rangeResult.label, generatedAt });
  } catch (err) {
    next(err);
  }
});

// ─── Exports (DATA_FETCHERS exposed for scheduler.js) ─────────────────────────
module.exports        = router;
module.exports.DATA_FETCHERS = DATA_FETCHERS;
module.exports.parseRange    = parseRange;
module.exports.REPORT_TITLES = REPORT_TITLES;
module.exports.getTenantName = getTenantName;
