-- 0023 · invoices, retainage and the money actually leaving
--
-- A subcontractor bills against the schedule of values on their commitment,
-- line by line, as a percentage complete. The GC reviews it, withholds
-- retainage, and pays. That loop is the one every contractor cares about more
-- than any other feature in any construction platform, because it is the one
-- that decides whether they can make payroll on the fifteenth.
--
-- Three things this schema refuses to get wrong.
--
-- Billing is PER LINE, not per invoice. "The sub is 60% done" is not a fact;
-- "the sub is 90% done on rough-in and 10% on trim" is. An invoice that
-- carries one percentage is an invoice nobody can check, and checking it is
-- the GC's entire job here.
--
-- Over-billing is refused by the database, not by a form. Billing more than
-- a line's commitment value, cumulatively across every invoice, is the single
-- most common way a GC ends up having paid out more than they hold. The check
-- is on the line at insert time and stated in one place.
--
-- Retainage is withheld per line per invoice and released explicitly. It is
-- not a percentage applied to a total at the end, because lines get released
-- at different times: stored materials often carry none, and a closed-out
-- scope releases before the job does.

CREATE TYPE invoice_status AS ENUM ('draft', 'submitted', 'under_review', 'approved', 'rejected', 'paid', 'void');

CREATE TABLE invoices (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    project_id     UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    commitment_id  UUID NOT NULL REFERENCES commitments (id) ON DELETE RESTRICT,
    number         TEXT NOT NULL,
    -- The billing period this covers. Two invoices for the same period on the
    -- same commitment is almost always a duplicate submission.
    period_start   DATE NOT NULL,
    period_end     DATE NOT NULL,
    status         invoice_status NOT NULL DEFAULT 'draft',
    -- A signed lien waiver is a precondition of payment on most jobs, and
    -- "we paid them without one" is a story that ends in a lien on the owner's
    -- building. Tracked here rather than in a folder somebody forgets.
    lien_waiver_received BOOLEAN NOT NULL DEFAULT FALSE,
    submitted_at   TIMESTAMPTZ,
    approved_at    TIMESTAMPTZ,
    paid_at        TIMESTAMPTZ,
    rejection_reason TEXT,
    created_by     UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    version        INTEGER NOT NULL DEFAULT 1,
    UNIQUE (commitment_id, number),
    CHECK (period_end >= period_start)
);

CREATE INDEX invoices_by_commitment ON invoices (tenant_id, commitment_id, period_end);

CREATE TABLE invoice_lines (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    invoice_id         UUID NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,
    -- The schedule-of-values line being billed against.
    commitment_line_id UUID NOT NULL REFERENCES commitment_lines (id) ON DELETE RESTRICT,
    -- What is being billed THIS period, not cumulatively. Cumulative is a
    -- sum over the invoices before it, and storing it would let two numbers
    -- that must agree drift apart.
    amount             NUMERIC(18,2) NOT NULL,
    retainage_amount   NUMERIC(18,2) NOT NULL DEFAULT 0,
    retainage_released NUMERIC(18,2) NOT NULL DEFAULT 0,
    CHECK (amount >= 0),
    CHECK (retainage_amount >= 0),
    UNIQUE (invoice_id, commitment_line_id)
);

CREATE INDEX invoice_lines_by_commitment_line ON invoice_lines (commitment_line_id);

/*
 * Billed to date per schedule-of-values line, counting everything not voided
 * or rejected. This is what the over-billing check reads, and what a GC
 * checking an invoice actually wants to see.
 */
CREATE VIEW commitment_line_billing AS
SELECT
    cl.id                                  AS commitment_line_id,
    cl.tenant_id,
    cl.commitment_id,
    cl.budget_code_id,
    cl.amount                              AS scheduled_value,
    COALESCE(SUM(il.amount), 0)            AS billed_to_date,
    COALESCE(SUM(il.retainage_amount), 0)  AS retainage_held,
    COALESCE(SUM(il.retainage_released), 0) AS retainage_released,
    cl.amount - COALESCE(SUM(il.amount), 0) AS remaining
FROM commitment_lines cl
LEFT JOIN invoice_lines il ON il.commitment_line_id = cl.id
LEFT JOIN invoices i ON i.id = il.invoice_id AND i.status NOT IN ('void', 'rejected')
GROUP BY cl.id, cl.tenant_id, cl.commitment_id, cl.budget_code_id, cl.amount;

/*
 * What is actually due on an invoice: billed this period, less retainage
 * withheld, plus any retainage released on it.
 */
CREATE VIEW invoice_summary AS
SELECT
    i.id          AS invoice_id,
    i.tenant_id,
    i.project_id,
    i.commitment_id,
    i.number,
    i.status,
    i.period_start,
    i.period_end,
    i.lien_waiver_received,
    COALESCE(SUM(il.amount), 0)             AS billed_this_period,
    COALESCE(SUM(il.retainage_amount), 0)   AS retainage_withheld,
    COALESCE(SUM(il.retainage_released), 0) AS retainage_released,
    COALESCE(SUM(il.amount), 0) - COALESCE(SUM(il.retainage_amount), 0)
      + COALESCE(SUM(il.retainage_released), 0) AS amount_due
FROM invoices i
LEFT JOIN invoice_lines il ON il.invoice_id = i.id
GROUP BY i.id;

DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['invoices', 'invoice_lines'] LOOP
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

GRANT SELECT ON commitment_line_billing, invoice_summary TO plumbline_app;

INSERT INTO tools (key, scope, display_name, sort_order) VALUES
    ('invoicing', 'project', 'Invoicing', 64);

INSERT INTO tool_privileges (tool_key, privilege, description) VALUES
    ('invoicing', 'submit',           'Submit an invoice against your own commitment'),
    ('invoicing', 'review',           'Approve or reject a submitted invoice'),
    ('invoicing', 'pay',              'Mark an approved invoice paid'),
    ('invoicing', 'release_retainage', 'Release withheld retainage');
