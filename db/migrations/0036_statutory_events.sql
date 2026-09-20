-- 0036 · the three statutory triggers this product does not witness
--
-- Five of the eight statutory triggers are facts about the job, and the job
-- knows them: first and last furnishing, completion, a recorded notice of
-- completion, contract execution. Three are not. A lien recorded at the
-- county, a notice of termination served, a payment falling due under terms
-- that live in a contract this product did not write — nothing in the
-- product witnesses any of those, so the rules that hang off them started no
-- clocks at all and said so in a skip reason nobody could act on.
--
-- Somebody records them. That is the honest answer rather than the clever
-- one: the alternative is deriving a payment due date from an invoice table
-- that has no due date on it, which is a guess, and a guessed statutory
-- deadline is the exact failure this subsystem exists to prevent.
--
-- One row per occurrence, not one column per kind. A lien gets recorded
-- against a job more than once and by more than one claimant, and a project
-- that has been partially terminated twice has two dates. Flattening those
-- into a column means the second one overwrites the first, which is how a
-- deadline that was real disappears.

CREATE TYPE statutory_event_kind AS ENUM (
    'notice_of_termination',
    'lien_recorded',
    'payment_due'
);

CREATE TABLE statutory_events (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    project_id  UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    kind        statutory_event_kind NOT NULL,
    -- The date the statute counts from, which is frequently not the date
    -- anybody typed it in. Recording it a fortnight late must not move the
    -- deadline a fortnight later.
    occurred_on DATE NOT NULL,
    -- What it was: an instrument number at the county, an invoice number, the
    -- notice served. Free text because the shape of it differs by county and
    -- a dropdown would just be wrong in a new one.
    reference   TEXT NOT NULL DEFAULT '',
    note        TEXT NOT NULL DEFAULT '',
    recorded_by UUID REFERENCES users (id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Two people recording the same lien on the same day is a duplicate, not
    -- a second lien. Distinct references are distinct events.
    UNIQUE (project_id, kind, occurred_on, reference)
);

CREATE INDEX statutory_events_by_project
    ON statutory_events (tenant_id, project_id, kind, occurred_on);

ALTER TABLE statutory_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE statutory_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON statutory_events
    USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON statutory_events TO plumbline_app;

-- Provenance, not identity. The clock's idempotency key stays
-- (project, rule, start date), because two liens recorded on the same day
-- against the same rule produce ONE deadline, not two. But a clock whose
-- start date came from an event somebody typed should be able to say which
-- one, or "why does this say the 14th" has no answer.
ALTER TABLE statutory_clocks
    ADD COLUMN source_event_id UUID REFERENCES statutory_events (id) ON DELETE SET NULL;
