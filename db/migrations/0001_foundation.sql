-- 0001 · foundation
--
-- Plumbline is a construction management platform. Its central bet is that
-- there is exactly ONE record kernel underneath every tool — RFIs, submittals,
-- punch items, observations, daily logs — rather than two dozen hand-built
-- CRUD apps that happen to share a nav bar. This migration lays the ground
-- everything else stands on: the tenant, the directory of people and firms,
-- and the projects that work happens inside.
--
-- Naming note: `tenants` is the account holder (the GC, owner, or specialty
-- contractor that pays us). `organizations` is the directory of firms that
-- appear ON a tenant's projects, including the tenant's own firm. Conflating
-- those two is the mistake that makes multi-party collaboration impossible to
-- retrofit later, so they are separate from the first migration.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE organization_kind AS ENUM (
    'owner',
    'general_contractor',
    'specialty_contractor',
    'architect',
    'engineer',
    'supplier',
    'consultant',
    'other'
);

CREATE TYPE project_stage AS ENUM (
    'bidding',
    'pre_construction',
    'course_of_construction',
    'post_construction',
    'warranty',
    'closed'
);

CREATE TABLE tenants (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE tenants IS 'The account holder. Every other tenant-scoped table keys back to this and is fenced by row-level security (migration 0006).';

-- Firms that appear on this tenant's projects. Exactly one row per tenant is
-- flagged is_self: the tenant's own firm. Subcontractors, architects and
-- owners live here too, which is what makes a project a multi-party space
-- rather than a single company's private workspace.
CREATE TABLE organizations (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    kind       organization_kind NOT NULL DEFAULT 'other',
    trade      TEXT,
    is_self    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name)
);

CREATE UNIQUE INDEX organizations_one_self_per_tenant
    ON organizations (tenant_id)
    WHERE is_self;

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
    email           TEXT NOT NULL,
    name            TEXT NOT NULL,
    job_title       TEXT,
    phone           TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, email)
);

CREATE INDEX users_by_org ON users (tenant_id, organization_id);

CREATE TABLE projects (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    number                TEXT NOT NULL,
    name                  TEXT NOT NULL,
    stage                 project_stage NOT NULL DEFAULT 'pre_construction',
    address_line1         TEXT,
    city                  TEXT,
    state_code            TEXT,
    postal_code           TEXT,
    country_code          TEXT NOT NULL DEFAULT 'US',
    latitude              NUMERIC(9, 6),
    longitude             NUMERIC(9, 6),
    time_zone             TEXT NOT NULL DEFAULT 'UTC',
    start_date            DATE,
    projected_finish_date DATE,
    -- Contract value drives portfolio rollups. NUMERIC, never float: money
    -- that loses cents loses arguments.
    contract_value        NUMERIC(14, 2),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, number)
);

CREATE INDEX projects_by_stage ON projects (tenant_id, stage);

-- Which people are on which project. The permission template applied here is
-- what governs the project-level tools for this user (see migration 0002).
CREATE TABLE project_memberships (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id              UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    project_id             UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    user_id                UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    permission_template_id UUID,
    added_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, user_id)
);

CREATE INDEX project_memberships_by_user ON project_memberships (tenant_id, user_id);
