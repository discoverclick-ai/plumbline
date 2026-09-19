-- 0030 · the paper, and where every citation points
--
-- Construction contracts do not only describe the work. They impose deadlines
-- on the act of complaining about the work. A delay is compensable only if you
-- gave written notice inside the window the contract sets, usually five to
-- twenty-one days, often measured from the moment you became aware rather than
-- from the moment the delay happened. Miss it and the claim is waived on its
-- merits unheard. The same shape governs differing site conditions, weather
-- days, change directives, cure periods and payment applications.
--
-- That is the most expensive failure mode in the industry and it is not an
-- intelligence problem. It is bookkeeping nobody does, because doing it means
-- someone reading two hundred pages, extracting every timed obligation, and
-- then watching the job for the events that start each clock.
--
-- This migration is the half with no AI in it: the instrument, and the clause,
-- with coordinates. Nothing here reads anything. It exists first on purpose,
-- because the single failure that would destroy this product is a fabricated
-- citation, and the defence against that is a schema where a citation is a
-- pointer at a rectangle on a page rather than text we retyped.

CREATE TYPE contract_document_kind AS ENUM (
    'prime_contract', 'subcontract', 'purchase_order', 'general_conditions',
    'supplementary_conditions', 'amendment', 'change_order', 'exhibit'
);

CREATE TYPE contract_document_status AS ENUM ('uploaded', 'segmented', 'profiled', 'active', 'superseded');

CREATE TABLE contract_documents (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    project_id          UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    kind                contract_document_kind NOT NULL,
    title               TEXT NOT NULL,
    -- The other side of this instrument. Which is also the permission
    -- boundary: a sub reads the subcontract they signed and nothing else.
    counterparty_org_id UUID REFERENCES organizations (id) ON DELETE RESTRICT,
    -- Amendments and exhibits point at what they modify. A subcontract points
    -- at the prime when the prime is incorporated by reference, which is how
    -- an obligation three levels up lands on a second tier sub.
    parent_document_id  UUID REFERENCES contract_documents (id) ON DELETE RESTRICT,
    executed_at         DATE,
    effective_at        DATE,
    storage_key         TEXT,
    page_count          INTEGER,
    status              contract_document_status NOT NULL DEFAULT 'uploaded',
    -- Same optimistic concurrency as records. Two people profiling one
    -- contract at once is rare and silently losing half the work is not
    -- something you find out about until a deadline is missed.
    version             INTEGER NOT NULL DEFAULT 1,
    uploaded_by         UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX contract_documents_by_project ON contract_documents (tenant_id, project_id, kind);
CREATE INDEX contract_documents_by_counterparty
    ON contract_documents (tenant_id, counterparty_org_id) WHERE counterparty_org_id IS NOT NULL;

-- A document cannot be its own parent, and the chain cannot be one row long.
-- Cheap to state, and it is the shape a bad import produces.
ALTER TABLE contract_documents
    ADD CONSTRAINT contract_documents_not_own_parent CHECK (parent_document_id IS DISTINCT FROM id);

CREATE TABLE contract_clauses (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    document_id   UUID NOT NULL REFERENCES contract_documents (id) ON DELETE CASCADE,
    -- As printed: "8.3.2". Null for unnumbered prose, which is most of a
    -- supplementary conditions page and is exactly where the nasty terms live.
    clause_number TEXT,
    heading       TEXT,
    text          TEXT NOT NULL,
    page          INTEGER,
    -- [x0, y0, x1, y1] in PDF user space, so a citation renders as a highlight
    -- on the original page. A quotation we retyped is a claim about the
    -- contract. A rectangle is the contract.
    bbox          NUMERIC[],
    order_index   INTEGER NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (document_id, order_index)
);

CREATE INDEX contract_clauses_by_number
    ON contract_clauses (tenant_id, document_id, clause_number) WHERE clause_number IS NOT NULL;

CREATE INDEX contract_clauses_search
    ON contract_clauses USING GIN (to_tsvector('english', coalesce(heading, '') || ' ' || text));

ALTER TABLE contract_clauses
    ADD CONSTRAINT contract_clauses_bbox_shape CHECK (bbox IS NULL OR array_length(bbox, 1) = 4);

-- ---------------------------------------------------------------------------
-- The project calendar
-- ---------------------------------------------------------------------------
--
-- Required, not inferred. "Within ten days" means one thing under a contract
-- that defines days as calendar days and another under one that says working
-- days, and the difference is routinely a week. Inferring a work week from
-- observed activity would produce a deadline the system could not defend, and
-- an indefensible deadline is worth less than none.

CREATE TABLE project_calendars (
    project_id     UUID PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
    tenant_id      UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    -- ISO weekday numbers, 1 = Monday. Six day weeks are normal on a job.
    work_days      INTEGER[] NOT NULL DEFAULT ARRAY[1, 2, 3, 4, 5],
    -- IANA zone. A deadline is a date in somebody's actual timezone, and the
    -- somebody is the job, not the server.
    time_zone      TEXT NOT NULL DEFAULT 'UTC',
    -- Where the contract defines its own term for a day, the definition and
    -- the clause it came from, so the arithmetic can cite its own basis.
    day_definition TEXT,
    source_clause_id UUID REFERENCES contract_clauses (id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE project_calendars
    ADD CONSTRAINT project_calendars_has_a_work_week CHECK (array_length(work_days, 1) BETWEEN 1 AND 7);

CREATE TABLE project_holidays (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    project_id  UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    observed_on DATE NOT NULL,
    name        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, observed_on)
);

CREATE INDEX project_holidays_by_project ON project_holidays (tenant_id, project_id, observed_on);

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------
--
-- Contract terms are the most sensitive data in this system. A trade partner
-- reads the subcontract they signed; they do not read the prime's indemnity
-- language and they never read another sub's price. So `contracts` is its own
-- tool and it is granted to almost nobody by default.

INSERT INTO tools (key, scope, display_name, sort_order) VALUES
    ('contracts', 'project', 'Contracts', 46);

INSERT INTO tool_privileges (tool_key, privilege, description) VALUES
    ('contracts', 'upload',      'Upload an executed instrument'),
    ('contracts', 'segment',     'Segment a document into clauses'),
    ('contracts', 'view_terms',  'Read clause text, as opposed to only the obligations that bind you'),
    ('contracts', 'manage_calendar', 'Set the project work week and holidays');

ALTER TABLE contract_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON contract_documents
    USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON contract_documents TO plumbline_app;

ALTER TABLE contract_clauses ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_clauses FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON contract_clauses
    USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON contract_clauses TO plumbline_app;

ALTER TABLE project_calendars ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_calendars FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON project_calendars
    USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON project_calendars TO plumbline_app;

ALTER TABLE project_holidays ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_holidays FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON project_holidays
    USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON project_holidays TO plumbline_app;
