-- 0021 · commitments
--
-- A subcontract or a purchase order: the promise to pay somebody. Until now
-- the committed cost in budget_summary came from cost entries somebody typed,
-- which is fine for a demo and useless on a job. This is where it comes from.
--
-- The shape that matters is the SCHEDULE OF VALUES. A commitment is not one
-- number, it is a list of lines, each against a budget code, each with its own
-- amount. That is what a sub bills against, what the GC releases retainage
-- against, and what makes a progress invoice checkable rather than a matter of
-- opinion. A commitment stored as a single total is the thing that forces
-- every contractor back into a spreadsheet.
--
-- Commitment change orders are separate rows, not edits. A signed subcontract
-- is a contract: its value changes by executing a change order against it, and
-- the original stays visible forever. Same reasoning as budget revisions, with
-- more legal weight, because the other party signed the original.
--
-- The one number this schema refuses to store is the current value. It is the
-- original plus executed change orders, and the view computes it, for the same
-- reason the budget does.

CREATE TYPE commitment_kind AS ENUM ('subcontract', 'purchase_order');

CREATE TYPE commitment_status AS ENUM ('draft', 'out_for_signature', 'executed', 'closed', 'void');

CREATE TABLE commitments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    project_id      UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    kind            commitment_kind NOT NULL,
    number          TEXT NOT NULL,
    title           TEXT NOT NULL,
    -- Who we are promising to pay. An organization, not a user: people leave
    -- and the contract does not follow them.
    vendor_org_id   UUID NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
    status          commitment_status NOT NULL DEFAULT 'draft',
    -- Retainage as a percentage, because it is withheld per invoice and the
    -- rate is negotiated per contract rather than per company.
    retainage_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
    executed_on     DATE,
    created_by      UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    version         INTEGER NOT NULL DEFAULT 1,
    UNIQUE (project_id, number)
);

CREATE INDEX commitments_by_vendor ON commitments (tenant_id, vendor_org_id);

-- The schedule of values. One line per scope per budget code.
CREATE TABLE commitment_lines (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    commitment_id   UUID NOT NULL REFERENCES commitments (id) ON DELETE CASCADE,
    budget_code_id  UUID NOT NULL REFERENCES budget_codes (id) ON DELETE RESTRICT,
    description     TEXT NOT NULL,
    amount          NUMERIC(18,2) NOT NULL,
    sort_order      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX commitment_lines_by_commitment ON commitment_lines (commitment_id, sort_order);
CREATE INDEX commitment_lines_by_code ON commitment_lines (tenant_id, budget_code_id);

-- A change to a signed contract is its own instrument, with its own number
-- and its own lines, never an edit to the original.
CREATE TABLE commitment_change_orders (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    commitment_id   UUID NOT NULL REFERENCES commitments (id) ON DELETE CASCADE,
    number          TEXT NOT NULL,
    title           TEXT NOT NULL,
    status          commitment_status NOT NULL DEFAULT 'draft',
    -- The change event this came from, so a dollar on a subcontract traces
    -- back to the condition on site that caused it.
    source_record_id UUID REFERENCES records (id) ON DELETE SET NULL,
    executed_on     DATE,
    created_by      UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (commitment_id, number)
);

CREATE TABLE commitment_change_order_lines (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    change_order_id   UUID NOT NULL REFERENCES commitment_change_orders (id) ON DELETE CASCADE,
    budget_code_id    UUID NOT NULL REFERENCES budget_codes (id) ON DELETE RESTRICT,
    description       TEXT NOT NULL,
    amount            NUMERIC(18,2) NOT NULL,
    sort_order        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX commitment_co_lines_by_co ON commitment_change_order_lines (change_order_id, sort_order);

/*
 * Current value, computed. Only EXECUTED change orders count: a change order
 * out for signature is a negotiation, and a contractor who books it as
 * committed cost is reporting a number the other party has not agreed to.
 */
CREATE VIEW commitment_summary AS
SELECT
    c.id AS commitment_id,
    c.tenant_id,
    c.project_id,
    c.kind,
    c.number,
    c.title,
    c.vendor_org_id,
    c.status,
    c.retainage_percent,
    COALESCE(orig.amount, 0)                        AS original_value,
    COALESCE(chg.amount, 0)                         AS executed_changes,
    COALESCE(orig.amount, 0) + COALESCE(chg.amount, 0) AS current_value
FROM commitments c
LEFT JOIN LATERAL (
    SELECT SUM(amount) AS amount FROM commitment_lines l WHERE l.commitment_id = c.id
) orig ON TRUE
LEFT JOIN LATERAL (
    SELECT SUM(l.amount) AS amount
      FROM commitment_change_orders co
      JOIN commitment_change_order_lines l ON l.change_order_id = co.id
     WHERE co.commitment_id = c.id AND co.status = 'executed'
) chg ON TRUE;

/*
 * What is committed against each budget code, which is what the budget view
 * has been waiting for. Executed commitments and executed change orders only,
 * for the same reason: an unsigned contract is not a commitment.
 */
CREATE VIEW committed_by_budget_code AS
SELECT tenant_id, project_id, budget_code_id, SUM(amount) AS committed
FROM (
    SELECT l.tenant_id, c.project_id, l.budget_code_id, l.amount
      FROM commitment_lines l
      JOIN commitments c ON c.id = l.commitment_id
     WHERE c.status IN ('executed', 'closed')
    UNION ALL
    SELECT l.tenant_id, c.project_id, l.budget_code_id, l.amount
      FROM commitment_change_order_lines l
      JOIN commitment_change_orders co ON co.id = l.change_order_id
      JOIN commitments c ON c.id = co.commitment_id
     WHERE co.status = 'executed' AND c.status IN ('executed', 'closed')
) parts
GROUP BY tenant_id, project_id, budget_code_id;

DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['commitments', 'commitment_lines', 'commitment_change_orders',
                             'commitment_change_order_lines'] LOOP
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

GRANT SELECT ON commitment_summary, committed_by_budget_code TO plumbline_app;

INSERT INTO tools (key, scope, display_name, sort_order) VALUES
    ('commitments', 'project', 'Commitments', 62);

INSERT INTO tool_privileges (tool_key, privilege, description) VALUES
    ('commitments', 'create',  'Draft subcontracts and purchase orders'),
    ('commitments', 'execute', 'Execute a commitment or a commitment change order');
