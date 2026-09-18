-- 0003 · the record kernel
--
-- Every tool in this product is the same table. An RFI, a submittal, a punch
-- item, an observation and a daily log differ by their type definition —
-- fields, workflow, numbering — and by nothing else. Adding a tool is a row in
-- `record_types` plus a view config, not a new schema and not a new service.
--
-- Why this matters beyond engineering economics: it gives agents ONE interface
-- to the whole business. An assistant that can read, propose, and transition a
-- `record` can work every tool the product will ever have, including the ones
-- shipped after the agent was written.
--
-- Two things are first class here because they are what make the product feel
-- like one system rather than 24 CRUD screens:
--
--   1. BALL IN COURT. Not a status string — an assignment with a holder, an
--      expected action, a due time, and a history. "Who owes the next action,
--      and for how long" becomes a query instead of a report.
--   2. THE EVENT LOG. Every state change is appended to `record_events`. That
--      is the substrate agents subscribe to, and the audit trail a dispute
--      gets settled with.

CREATE TYPE participant_role AS ENUM (
    'creator',
    'assignee',
    'reviewer',
    'approver',
    'distribution',
    'watcher'
);

-- Global type registry. A type's `definition` holds its field schema and its
-- workflow (states, transitions, and what each transition does to the ball in
-- court). See @plumbline/shared/src/record-type.ts for the contract, and
-- migration 0004 for the built-in types.
CREATE TABLE record_types (
    key                 TEXT PRIMARY KEY,
    tool_key            TEXT NOT NULL REFERENCES tools (key) ON DELETE RESTRICT,
    display_name        TEXT NOT NULL,
    display_name_plural TEXT NOT NULL,
    -- Prefix for the human-facing designation: 'RFI' yields RFI-001.
    number_prefix       TEXT NOT NULL,
    definition          JSONB NOT NULL,
    -- Bumped when the definition changes so a record can say which shape of
    -- the type it was created under.
    version             INTEGER NOT NULL DEFAULT 1,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE records (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    project_id           UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    type_key             TEXT NOT NULL REFERENCES record_types (key) ON DELETE RESTRICT,
    type_version         INTEGER NOT NULL,
    -- Per project, per type, gapless, assigned from record_number_sequences.
    number               INTEGER NOT NULL,
    designation          TEXT NOT NULL,
    title                TEXT NOT NULL,
    -- Type-defined fields, validated against the definition's field schema
    -- before every write. JSONB because the whole point is that adding a tool
    -- does not add a table.
    body                 JSONB NOT NULL DEFAULT '{}'::jsonb,
    status               TEXT NOT NULL,
    ball_in_court_user_id UUID REFERENCES users (id) ON DELETE SET NULL,
    due_at               TIMESTAMPTZ,
    created_by           UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    updated_by           UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    -- Optimistic concurrency. Two people editing the same RFI from two
    -- trailers is the normal case, not the edge case.
    version              INTEGER NOT NULL DEFAULT 1,
    closed_at            TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, type_key, number)
);

CREATE INDEX records_by_project_type ON records (tenant_id, project_id, type_key, status);
CREATE INDEX records_by_ball_in_court ON records (tenant_id, ball_in_court_user_id) WHERE closed_at IS NULL;
CREATE INDEX records_open_by_due ON records (tenant_id, due_at) WHERE closed_at IS NULL;

-- Numbering lives in its own table so allocation is a single UPDATE ...
-- RETURNING under row lock. Gapless numbering matters here: RFI-014 is cited
-- in correspondence and, eventually, in court.
CREATE TABLE record_number_sequences (
    tenant_id   UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    project_id  UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    type_key    TEXT NOT NULL REFERENCES record_types (key) ON DELETE CASCADE,
    next_number INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (project_id, type_key)
);

CREATE TABLE record_participants (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    record_id  UUID NOT NULL REFERENCES records (id) ON DELETE CASCADE,
    user_id    UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role       participant_role NOT NULL,
    -- Ordering within a role, for sequential approval chains.
    position   INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (record_id, user_id, role)
);

CREATE INDEX record_participants_by_user ON record_participants (tenant_id, user_id);

-- Ball-in-court history. The open row (released_at IS NULL) is the current
-- holder and is kept in lockstep with records.ball_in_court_user_id.
CREATE TABLE record_assignments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    record_id       UUID NOT NULL REFERENCES records (id) ON DELETE CASCADE,
    holder_user_id  UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    expected_action TEXT NOT NULL,
    due_at          TIMESTAMPTZ,
    assigned_by     UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    assigned_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    released_at     TIMESTAMPTZ,
    released_reason TEXT
);

CREATE UNIQUE INDEX record_assignments_one_open_per_record
    ON record_assignments (record_id)
    WHERE released_at IS NULL;

CREATE INDEX record_assignments_open_by_holder
    ON record_assignments (tenant_id, holder_user_id)
    WHERE released_at IS NULL;

CREATE TABLE record_state_history (
    id             BIGSERIAL PRIMARY KEY,
    tenant_id      UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    record_id      UUID NOT NULL REFERENCES records (id) ON DELETE CASCADE,
    from_status    TEXT,
    to_status      TEXT NOT NULL,
    transition_key TEXT NOT NULL,
    actor_user_id  UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    note           TEXT,
    occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX record_state_history_by_record ON record_state_history (record_id, id);

CREATE TABLE record_comments (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    record_id      UUID NOT NULL REFERENCES records (id) ON DELETE CASCADE,
    author_user_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    body           TEXT NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX record_comments_by_record ON record_comments (record_id, created_at);

CREATE TABLE record_attachments (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    record_id    UUID NOT NULL REFERENCES records (id) ON DELETE CASCADE,
    filename     TEXT NOT NULL,
    content_type TEXT NOT NULL,
    byte_size    BIGINT NOT NULL,
    storage_key  TEXT NOT NULL,
    uploaded_by  UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX record_attachments_by_record ON record_attachments (record_id);

-- Append-only. Nothing updates or deletes from this table; agents read it
-- forward from a durable cursor, and disputes read it backwards.
CREATE TABLE record_events (
    id            BIGSERIAL PRIMARY KEY,
    tenant_id     UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    project_id    UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    record_id     UUID NOT NULL REFERENCES records (id) ON DELETE CASCADE,
    type_key      TEXT NOT NULL,
    event         TEXT NOT NULL,
    payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
    actor_user_id UUID REFERENCES users (id) ON DELETE SET NULL,
    occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX record_events_by_record ON record_events (record_id, id);
CREATE INDEX record_events_feed ON record_events (tenant_id, id);

CREATE TABLE audit_log (
    id            BIGSERIAL PRIMARY KEY,
    tenant_id     UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    actor_user_id UUID REFERENCES users (id) ON DELETE SET NULL,
    action        TEXT NOT NULL,
    subject_type  TEXT NOT NULL,
    subject_id    TEXT,
    detail        JSONB NOT NULL DEFAULT '{}'::jsonb,
    occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_feed ON audit_log (tenant_id, id);
