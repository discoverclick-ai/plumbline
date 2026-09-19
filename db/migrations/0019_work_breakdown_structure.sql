-- 0019 · the work breakdown structure
--
-- The financial spine, and the one piece of this product that cannot be
-- retrofitted. Every budget line, commitment, change order, invoice and cost
-- entry hangs off a budget code. Get the shape of that code wrong and every
-- accounting integration is bespoke forever, which is the state most
-- construction software is permanently stuck in.
--
-- Procore's answer is the right one and worth copying exactly: a budget code
-- is not a string, it is a COMPOSITION of segments. Cost code and cost type
-- are the two everybody has. Sub job is the third most common. Beyond that,
-- companies segment by whatever their accounting system segments by: phase,
-- area, tower, funding source, tax jurisdiction. So the segments are
-- configuration per tenant, ordered, and the code is their values joined.
--
-- Three decisions that look like over-engineering until you have shipped
-- without them.
--
-- Segments are per tenant, not per project. A contractor's chart of accounts
-- does not change between jobs; if it did, nothing would roll up across the
-- portfolio and the ERP sync would be per project, which is nobody's idea of
-- a integration.
--
-- Codes are immutable once used. A budget code that gets edited after costs
-- are posted against it silently rewrites history in the accounting system
-- too. Retire it and make a new one.
--
-- CSI MasterFormat ships as a default cost code set but is NOT baked in. Plenty
-- of self-performing contractors and most owners use their own. A product that
-- assumes MasterFormat is a product that cannot be sold to a utility.

CREATE TABLE wbs_segments (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    key         TEXT NOT NULL,
    label       TEXT NOT NULL,
    -- Position in the assembled code. Procore allows ten custom segments on
    -- top of the built-ins; the number matters less than the fact that it is
    -- the CUSTOMER's order, because it has to match their ERP's.
    position    INTEGER NOT NULL,
    -- Built-in segments cannot be deleted, because the rest of the schema
    -- names them. Custom ones are entirely the customer's.
    builtin     BOOLEAN NOT NULL DEFAULT FALSE,
    required    BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, key),
    UNIQUE (tenant_id, position)
);

CREATE TABLE wbs_segment_values (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    segment_id  UUID NOT NULL REFERENCES wbs_segments (id) ON DELETE CASCADE,
    -- The code as printed on a drawing or an invoice: "03 30 00", "L", "T2".
    code        TEXT NOT NULL,
    label       TEXT NOT NULL,
    -- Values can be scoped to one project (a sub job only this job has) or
    -- shared across the company (the cost code list).
    project_id  UUID REFERENCES projects (id) ON DELETE CASCADE,
    parent_id   UUID REFERENCES wbs_segment_values (id) ON DELETE RESTRICT,
    active      BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX wbs_segment_values_company_wide
    ON wbs_segment_values (segment_id, code) WHERE project_id IS NULL;
CREATE UNIQUE INDEX wbs_segment_values_per_project
    ON wbs_segment_values (segment_id, project_id, code) WHERE project_id IS NOT NULL;
CREATE INDEX wbs_segment_values_lookup ON wbs_segment_values (tenant_id, segment_id, active);

-- A budget code is the assembled thing: one value per segment, for one
-- project. This is what every financial row in the product points at.
CREATE TABLE budget_codes (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    project_id  UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    -- The assembled display form, e.g. "03 30 00.L.T2". Stored rather than
    -- computed because it appears on paper that outlives the segment config,
    -- and a code printed on a signed subcontract cannot change shape later.
    display     TEXT NOT NULL,
    -- Immutable once anything is posted against it. Retire and replace.
    retired_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, display)
);

CREATE TABLE budget_code_segments (
    budget_code_id UUID NOT NULL REFERENCES budget_codes (id) ON DELETE CASCADE,
    segment_id     UUID NOT NULL REFERENCES wbs_segments (id) ON DELETE RESTRICT,
    value_id       UUID NOT NULL REFERENCES wbs_segment_values (id) ON DELETE RESTRICT,
    PRIMARY KEY (budget_code_id, segment_id)
);

CREATE INDEX budget_code_segments_by_value ON budget_code_segments (value_id);

ALTER TABLE budget_codes ADD CONSTRAINT budget_codes_display_not_blank CHECK (length(trim(display)) > 0);

DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['wbs_segments', 'wbs_segment_values', 'budget_codes'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())',
            t
        );
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO plumbline_app', t);
    END LOOP;
END
$$;

-- budget_code_segments carries no tenant_id of its own: it is a join table
-- whose every row is reachable only through a budget_code that has one, and
-- duplicating the column would create a second place for the truth to live.
-- It is confined by the policies on both sides of the join.
GRANT SELECT, INSERT, UPDATE, DELETE ON budget_code_segments TO plumbline_app;

INSERT INTO tools (key, scope, display_name, sort_order) VALUES
    ('budget', 'project', 'Budget', 60);

INSERT INTO tool_privileges (tool_key, privilege, description) VALUES
    ('budget', 'manage_codes', 'Create and retire budget codes'),
    ('budget', 'view_costs',   'See cost and committed amounts, not only quantities');
