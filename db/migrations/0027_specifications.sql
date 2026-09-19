-- 0027 · specifications, and the register hiding inside them
--
-- A spec book is two thousand pages nobody reads end to end, and buried in it
-- is a list every project engineer builds by hand in the first fortnight of a
-- job: every submittal the contract requires, by section. Missing one is not
-- a paperwork problem. It is a material that arrives unapproved, gets
-- rejected, and becomes a six week lead time nobody budgeted.
--
-- That list is the single best agent job in construction. It is tedious,
-- mechanical, entirely determined by the document, and checkable line by line
-- against the clause it came from. So the schema is built for that: sections
-- carry their text, requirements carry a citation back into it, and nothing
-- becomes a submittal until a human accepts it.
--
-- Deliberately NOT modelled as a record type. A spec section has no workflow
-- and no ball in court; it is reference material the job is measured against.
-- Forcing it into the kernel would give it a state machine nobody would ever
-- transition.

CREATE TABLE specification_books (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    project_id  UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    issued_on   DATE,
    storage_key TEXT,
    created_by  UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, name)
);

CREATE TABLE specification_sections (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    book_id     UUID NOT NULL REFERENCES specification_books (id) ON DELETE CASCADE,
    -- "03 30 00", as MasterFormat numbers it and as every submittal references it.
    number      TEXT NOT NULL,
    title       TEXT NOT NULL,
    body        TEXT NOT NULL,
    page_start  INTEGER,
    page_end    INTEGER,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (book_id, number)
);

CREATE INDEX specification_sections_by_book ON specification_sections (tenant_id, book_id, number);

CREATE INDEX specification_sections_search
    ON specification_sections USING GIN (to_tsvector('english', title || ' ' || body));

CREATE TYPE spec_requirement_status AS ENUM ('proposed', 'accepted', 'rejected', 'satisfied');

-- One required submittal, extracted from one section.
CREATE TABLE specification_requirements (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    section_id     UUID NOT NULL REFERENCES specification_sections (id) ON DELETE CASCADE,
    -- Product Data, Shop Drawings, Samples, and the rest: the same vocabulary
    -- the submittal record type already uses, so accepting one is a copy
    -- rather than a translation.
    submittal_type TEXT NOT NULL,
    description    TEXT NOT NULL,
    -- The verbatim sentence this came from. NOT NULL on purpose: an extracted
    -- requirement nobody can trace to a clause is a requirement nobody will
    -- defend in a meeting, and the register is only useful if a project
    -- engineer can check it line by line.
    quote          TEXT NOT NULL,
    paragraph      TEXT,
    status         spec_requirement_status NOT NULL DEFAULT 'proposed',
    confidence     NUMERIC(4,3),
    -- The submittal raised to satisfy it, once one exists.
    submittal_id   UUID REFERENCES records (id) ON DELETE SET NULL,
    reviewed_by    UUID REFERENCES users (id) ON DELETE SET NULL,
    reviewed_at    TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX specification_requirements_by_section
    ON specification_requirements (tenant_id, section_id, status);
CREATE INDEX specification_requirements_open
    ON specification_requirements (tenant_id, status) WHERE status IN ('proposed', 'accepted');

DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['specification_books', 'specification_sections', 'specification_requirements'] LOOP
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

INSERT INTO tools (key, scope, display_name, sort_order) VALUES
    ('specifications', 'project', 'Specifications', 14);

INSERT INTO tool_privileges (tool_key, privilege, description) VALUES
    ('specifications', 'upload', 'Upload and section a specification book'),
    ('specifications', 'review', 'Accept or reject extracted submittal requirements');
