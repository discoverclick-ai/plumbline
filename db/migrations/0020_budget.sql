-- 0020 · the budget
--
-- One line per budget code per project, and every number on it is an ANSWER
-- rather than a stored value, except the two that are not.
--
-- The distinction matters more than it sounds. A budget line has an original
-- amount and a set of approved revisions, and those are facts somebody
-- entered and signed. Everything else people call a budget number is derived:
-- the current budget is original plus approved revisions, the committed cost
-- is the sum of the commitments pointing here, the cost to date is the sum of
-- the costs, the projected cost is a forecast somebody made. Storing derived
-- numbers is how two screens in the same product disagree about the same job,
-- and once that happens nobody trusts either.
--
-- So: two stored columns and a view. The view is the product.
--
-- Amounts are NUMERIC(18,2), never floats. A cent lost to binary rounding on
-- a forty million dollar job is a reconciliation somebody spends a week on.

CREATE TABLE budget_lines (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    project_id      UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    budget_code_id  UUID NOT NULL REFERENCES budget_codes (id) ON DELETE RESTRICT,
    description     TEXT NOT NULL DEFAULT '',
    -- The two facts. Everything else about this line is computed.
    original_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
    -- Unit tracking, for the lines where the quantity is the thing people
    -- manage. Optional, because most lines are a lump sum.
    unit_of_measure TEXT,
    original_quantity NUMERIC(18,4),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    version         INTEGER NOT NULL DEFAULT 1,
    UNIQUE (project_id, budget_code_id)
);

-- A revision is an append-only fact: who moved money, when, how much, and
-- pointing at the change event that authorised it. Editing the original
-- amount after the fact would erase the reason.
CREATE TABLE budget_revisions (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    budget_line_id UUID NOT NULL REFERENCES budget_lines (id) ON DELETE CASCADE,
    amount         NUMERIC(18,2) NOT NULL,
    reason         TEXT NOT NULL,
    -- The change event that authorised it, where there was one. A revision
    -- with no source is a transfer between lines, which is legitimate and
    -- worth being able to find later.
    source_record_id UUID REFERENCES records (id) ON DELETE SET NULL,
    created_by     UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX budget_revisions_by_line ON budget_revisions (budget_line_id, created_at);
CREATE INDEX budget_lines_by_project ON budget_lines (tenant_id, project_id);

-- Cost, as it actually lands. Deliberately one table for every kind of cost
-- rather than a table per kind: a job cost report does not care whether a
-- dollar arrived as an invoice, a timesheet or a credit card, and a schema
-- that splits them makes every report a union.
CREATE TYPE cost_kind AS ENUM ('committed', 'actual', 'pending', 'forecast');

CREATE TABLE cost_entries (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    project_id     UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    budget_code_id UUID NOT NULL REFERENCES budget_codes (id) ON DELETE RESTRICT,
    kind           cost_kind NOT NULL,
    amount         NUMERIC(18,2) NOT NULL,
    quantity       NUMERIC(18,4),
    description    TEXT NOT NULL DEFAULT '',
    -- What caused it: a commitment, an invoice, a T&M ticket, a change order.
    source_record_id UUID REFERENCES records (id) ON DELETE SET NULL,
    incurred_on    DATE NOT NULL DEFAULT CURRENT_DATE,
    created_by     UUID REFERENCES users (id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX cost_entries_by_code ON cost_entries (tenant_id, project_id, budget_code_id, kind);
CREATE INDEX cost_entries_by_source ON cost_entries (source_record_id) WHERE source_record_id IS NOT NULL;

/*
 * The view is the product.
 *
 * Every derived number in one place, computed the same way for every screen,
 * every report and every agent. The moment one of these is cached somewhere
 * for speed, two parts of the product start disagreeing about the same job.
 */
CREATE VIEW budget_summary AS
SELECT
    bl.id                AS budget_line_id,
    bl.tenant_id,
    bl.project_id,
    bl.budget_code_id,
    bc.display           AS budget_code,
    bl.description,
    bl.original_amount,
    COALESCE(rev.revised, 0)                        AS approved_revisions,
    bl.original_amount + COALESCE(rev.revised, 0)   AS current_budget,
    COALESCE(c.committed, 0)                        AS committed_cost,
    COALESCE(c.actual, 0)                           AS actual_cost,
    COALESCE(c.pending, 0)                          AS pending_cost,
    -- What the job is expected to cost: whichever is larger of what has been
    -- committed and what has actually landed, plus anything pending. Taking
    -- the larger is the conservative read, and a projection that flatters the
    -- job is worse than no projection.
    GREATEST(COALESCE(c.committed, 0), COALESCE(c.actual, 0)) + COALESCE(c.pending, 0) AS projected_cost,
    (bl.original_amount + COALESCE(rev.revised, 0))
      - (GREATEST(COALESCE(c.committed, 0), COALESCE(c.actual, 0)) + COALESCE(c.pending, 0)) AS projected_over_under
FROM budget_lines bl
JOIN budget_codes bc ON bc.id = bl.budget_code_id
LEFT JOIN LATERAL (
    SELECT SUM(amount) AS revised FROM budget_revisions r WHERE r.budget_line_id = bl.id
) rev ON TRUE
LEFT JOIN LATERAL (
    SELECT
        SUM(amount) FILTER (WHERE kind = 'committed') AS committed,
        SUM(amount) FILTER (WHERE kind = 'actual')    AS actual,
        SUM(amount) FILTER (WHERE kind = 'pending')   AS pending
      FROM cost_entries ce
     WHERE ce.budget_code_id = bl.budget_code_id AND ce.project_id = bl.project_id
) c ON TRUE;

DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['budget_lines', 'budget_revisions', 'cost_entries'] LOOP
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

-- The view inherits the policies of the tables under it, so it needs no
-- policy of its own, only the grant.
GRANT SELECT ON budget_summary TO plumbline_app;
