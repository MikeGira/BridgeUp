-- =============================================================================
-- BridgeUp — Supabase PostgreSQL Schema
-- Run this in Supabase SQL Editor to initialise the database.
-- =============================================================================

-- ─── Extensions ──────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "unaccent";

-- ─── Tenants (organisations / NGOs) ──────────────────────────────────────────
CREATE TABLE tenants (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE CHECK (char_length(name) BETWEEN 2 AND 100),
  plan        TEXT NOT NULL DEFAULT 'free'
                CHECK (plan IN ('free', 'pro', 'ngo', 'enterprise')),
  email       TEXT CHECK (email ~* '^[^@]+@[^@]+\.[^@]+$'),
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Users ───────────────────────────────────────────────────────────────────
CREATE TABLE users (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  phone         TEXT UNIQUE NOT NULL CHECK (phone ~ '^\+[1-9]\d{6,14}$'),
  role          TEXT NOT NULL DEFAULT 'user'
                  CHECK (role IN ('user', 'helper', 'admin', 'ngo', 'superadmin')),
  tenant_id     UUID REFERENCES tenants(id) ON DELETE SET NULL,
  country       TEXT,
  language      TEXT NOT NULL DEFAULT 'en',
  display_name  TEXT CHECK (char_length(display_name) <= 100),
  avatar_url    TEXT,
  bio           TEXT CHECK (char_length(bio) <= 500),
  verified      BOOLEAN NOT NULL DEFAULT TRUE,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at TIMESTAMPTZ DEFAULT NOW(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_phone     ON users(phone);
CREATE INDEX idx_users_tenant_id ON users(tenant_id);
CREATE INDEX idx_users_role      ON users(role);

-- ─── OTP codes (one row per phone, overwritten on each send) ─────────────────
CREATE TABLE otp_codes (
  phone       TEXT PRIMARY KEY CHECK (phone ~ '^\+[1-9]\d{6,14}$'),
  code        TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  verified    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── OTP send rate limiting (per phone, 1-hour window) ───────────────────────
CREATE TABLE otp_rate_limit (
  phone        TEXT PRIMARY KEY,
  count        INTEGER NOT NULL DEFAULT 0,
  window_start BIGINT  NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── JWT revocation list ─────────────────────────────────────────────────────
CREATE TABLE revoked_tokens (
  jti        TEXT PRIMARY KEY,
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  revoked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);

CREATE INDEX idx_revoked_tokens_expires ON revoked_tokens(expires_at);

-- ─── Needs ───────────────────────────────────────────────────────────────────
CREATE TABLE needs (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id        UUID REFERENCES users(id) ON DELETE SET NULL,
  tenant_id      UUID REFERENCES tenants(id) ON DELETE SET NULL,
  phone          TEXT CHECK (phone ~ '^\+[1-9]\d{6,14}$'),
  category       TEXT NOT NULL
                   CHECK (category IN ('food','housing','employment','medical','training','funding','other')),
  description    TEXT NOT NULL CHECK (char_length(description) BETWEEN 5 AND 2000),
  location       TEXT CHECK (char_length(location) <= 255),
  location_lat   DOUBLE PRECISION CHECK (location_lat BETWEEN -90  AND 90),
  location_lng   DOUBLE PRECISION CHECK (location_lng BETWEEN -180 AND 180),
  urgency        TEXT NOT NULL DEFAULT 'days'
                   CHECK (urgency IN ('immediate', 'days', 'weeks')),
  status         TEXT NOT NULL DEFAULT 'pending_match'
                   CHECK (status IN ('pending_match','matching','matched','in_progress','resolved','closed','cancelled')),
  channel        TEXT NOT NULL DEFAULT 'web'
                   CHECK (channel IN ('web','sms','voice','app')),
  language       TEXT NOT NULL DEFAULT 'en',
  status_history JSONB NOT NULL DEFAULT '[]',
  ai_session_id  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_needs_user_id   ON needs(user_id);
CREATE INDEX idx_needs_tenant_id ON needs(tenant_id);
CREATE INDEX idx_needs_status    ON needs(status);
CREATE INDEX idx_needs_category  ON needs(category);
CREATE INDEX idx_needs_created   ON needs(created_at DESC);
CREATE INDEX idx_needs_location  ON needs(location_lat, location_lng)
  WHERE location_lat IS NOT NULL;

-- ─── Helpers ─────────────────────────────────────────────────────────────────
CREATE TABLE helpers (
  id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id          UUID REFERENCES users(id) ON DELETE CASCADE UNIQUE NOT NULL,
  tenant_id        UUID REFERENCES tenants(id) ON DELETE SET NULL,
  organization     TEXT CHECK (char_length(organization) <= 200),
  help_types       TEXT[] NOT NULL DEFAULT '{}',
  location_lat     DOUBLE PRECISION CHECK (location_lat BETWEEN -90  AND 90),
  location_lng     DOUBLE PRECISION CHECK (location_lng BETWEEN -180 AND 180),
  location_address TEXT CHECK (char_length(location_address) <= 255),
  service_radius_km INTEGER NOT NULL DEFAULT 50 CHECK (service_radius_km BETWEEN 1 AND 500),
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','approved','rejected','suspended')),
  is_online        BOOLEAN NOT NULL DEFAULT FALSE,
  rating           DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (rating BETWEEN 0 AND 5),
  total_resolved   INTEGER NOT NULL DEFAULT 0,
  total_assigned   INTEGER NOT NULL DEFAULT 0,
  verification_docs JSONB NOT NULL DEFAULT '[]',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_helpers_user_id   ON helpers(user_id);
CREATE INDEX idx_helpers_tenant_id ON helpers(tenant_id);
CREATE INDEX idx_helpers_status    ON helpers(status);
CREATE INDEX idx_helpers_location  ON helpers(location_lat, location_lng)
  WHERE location_lat IS NOT NULL;

-- ─── Matches ─────────────────────────────────────────────────────────────────
CREATE TABLE matches (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  need_id      UUID NOT NULL REFERENCES needs(id) ON DELETE CASCADE,
  helper_id    UUID NOT NULL REFERENCES helpers(id) ON DELETE CASCADE,
  user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  user_phone   TEXT,
  tenant_id    UUID REFERENCES tenants(id) ON DELETE SET NULL,
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','accepted','declined','in_progress','resolved','cancelled')),
  score        INTEGER NOT NULL DEFAULT 0,
  distance_km  DOUBLE PRECISION,
  notes        TEXT CHECK (char_length(notes) <= 1000),
  accepted_at  TIMESTAMPTZ,
  declined_at  TIMESTAMPTZ,
  resolved_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_matches_need_id   ON matches(need_id);
CREATE INDEX idx_matches_helper_id ON matches(helper_id);
CREATE INDEX idx_matches_user_id   ON matches(user_id);
CREATE INDEX idx_matches_status    ON matches(status);
CREATE INDEX idx_matches_created   ON matches(created_at DESC);

-- ─── Reviews ─────────────────────────────────────────────────────────────────
CREATE TABLE reviews (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  match_id    UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  reviewer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  helper_id   UUID NOT NULL REFERENCES helpers(id) ON DELETE CASCADE,
  rating      INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment     TEXT CHECK (char_length(comment) <= 1000),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_reviews_unique ON reviews(match_id, reviewer_id);

-- ─── Payments ────────────────────────────────────────────────────────────────
CREATE TABLE payments (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  tenant_id   UUID REFERENCES tenants(id) ON DELETE SET NULL,
  amount      INTEGER NOT NULL CHECK (amount > 0),
  currency    TEXT NOT NULL DEFAULT 'USD',
  provider    TEXT CHECK (provider IN ('stripe','flutterwave','africastalking')),
  provider_id TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',
  phone_last4 TEXT,
  metadata    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_payments_user_id ON payments(user_id);
CREATE INDEX idx_payments_status  ON payments(status);

-- ─── Notifications ────────────────────────────────────────────────────────────
CREATE TABLE notifications (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  title      TEXT NOT NULL CHECK (char_length(title) <= 200),
  body       TEXT CHECK (char_length(body) <= 1000),
  data       JSONB NOT NULL DEFAULT '{}',
  read       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notifications_user_id ON notifications(user_id, read, created_at DESC);

-- ─── Audit log ───────────────────────────────────────────────────────────────
CREATE TABLE audit_log (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  action     TEXT NOT NULL,
  actor_id   TEXT,
  target_id  TEXT,
  tenant_id  UUID REFERENCES tenants(id) ON DELETE SET NULL,
  meta       JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_log_action    ON audit_log(action, created_at DESC);
CREATE INDEX idx_audit_log_actor     ON audit_log(actor_id);
CREATE INDEX idx_audit_log_tenant_id ON audit_log(tenant_id, created_at DESC);

-- ─── SMS conversation state ───────────────────────────────────────────────────
CREATE TABLE sms_conversations (
  phone                TEXT PRIMARY KEY,
  country              TEXT,
  language             TEXT NOT NULL DEFAULT 'en',
  step                 TEXT NOT NULL,
  conversation_history JSONB NOT NULL DEFAULT '[]',
  intake_data          JSONB,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Reports cache ───────────────────────────────────────────────────────────
CREATE TABLE reports (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id    UUID REFERENCES tenants(id) ON DELETE CASCADE,
  type         TEXT NOT NULL,
  period       TEXT NOT NULL,
  data         JSONB NOT NULL,
  generated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_reports_tenant ON reports(tenant_id, type, created_at DESC);

-- ─── updated_at trigger ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at    BEFORE UPDATE ON users    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_needs_updated_at    BEFORE UPDATE ON needs    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_helpers_updated_at  BEFORE UPDATE ON helpers  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_matches_updated_at  BEFORE UPDATE ON matches  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_sms_updated_at      BEFORE UPDATE ON sms_conversations FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ─── Row Level Security ───────────────────────────────────────────────────────
ALTER TABLE users             ENABLE ROW LEVEL SECURITY;
ALTER TABLE needs             ENABLE ROW LEVEL SECURITY;
ALTER TABLE helpers           ENABLE ROW LEVEL SECURITY;
ALTER TABLE matches           ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviews           ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments          ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications     ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log         ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants           ENABLE ROW LEVEL SECURITY;
ALTER TABLE otp_codes         ENABLE ROW LEVEL SECURITY;
ALTER TABLE otp_rate_limit    ENABLE ROW LEVEL SECURITY;
ALTER TABLE revoked_tokens    ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports           ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS — all server-side operations use service role key.
-- The anon key (client-side) cannot access any table directly.
-- All access goes through the server-side API (Express on Vercel).

-- Allow service role full access (this is the default — explicitly stated for clarity)
CREATE POLICY "service_role_all" ON users             FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all" ON needs             FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all" ON helpers           FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all" ON matches           FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all" ON reviews           FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all" ON payments          FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all" ON notifications     FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all" ON audit_log         FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all" ON tenants           FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all" ON otp_codes         FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all" ON otp_rate_limit    FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all" ON revoked_tokens    FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all" ON sms_conversations FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service_role_all" ON reports           FOR ALL USING (auth.role() = 'service_role');

-- =============================================================================
-- Seed: default superadmin tenant
-- =============================================================================
INSERT INTO tenants (name, plan, email)
VALUES ('BridgeUp Global', 'enterprise', 'admin@bridgeup.org')
ON CONFLICT DO NOTHING;
