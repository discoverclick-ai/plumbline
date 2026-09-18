-- 0008 · the capture pipeline
--
-- The inversion this product exists for.
--
-- In every incumbent construction platform a human produces the record: they
-- open a form on a phone, in the rain, wearing gloves, and type. Every record
-- in the system is bought with somebody's data entry, which is why roughly
-- 43% of construction software rollouts fail on field adoption. Here the field
-- produces SIGNAL — a photo, a voice note, a scanned transmittal, an email —
-- and an agent drafts the record from it. A human approves.
--
-- Three tables and one rule.
--
--   captures            raw signal, exactly as it left the field.
--   capture_proposals   what an agent thinks the signal means.
--   ai_usage            what that cost, per tenant, exactly.
--
-- THE RULE: nothing is ever born approved. A proposal is not a record and
-- cannot become one on its own. Acceptance runs the ordinary kernel path as
-- the approving human, under their permissions, so an agent can never create
-- anything the person approving it could not have created by hand. There is
-- no confidence threshold that bypasses this, and there is no batch mode that
-- skips it. The gate is the product.

CREATE TYPE capture_kind AS ENUM ('photo', 'voice', 'document', 'text', 'email');

CREATE TYPE capture_status AS ENUM ('received', 'interpreting', 'interpreted', 'failed', 'dismissed');

CREATE TYPE proposal_status AS ENUM ('pending', 'accepted', 'rejected', 'superseded');

CREATE TABLE captures (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    project_id     UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    captured_by    UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    kind           capture_kind NOT NULL,
    -- Where the bytes live. NULL for a plain text or dictated note that is
    -- fully contained in `text`.
    storage_key    TEXT,
    content_type   TEXT,
    byte_size      BIGINT,
    -- What the signal says: a transcript, OCR output, an email body, or the
    -- note as typed. This is what the interpreter reads. Images are described
    -- by the vision model at interpretation time and the description lands
    -- here, so a later re-interpretation never needs the original bytes.
    text           TEXT,
    -- When the signal was produced in the field, which is not when it reached
    -- the server. A phone in a basement uploads hours later, and the daily log
    -- it becomes belongs to the day the work happened.
    captured_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    latitude       NUMERIC(9, 6),
    longitude      NUMERIC(9, 6),
    device         JSONB NOT NULL DEFAULT '{}'::jsonb,
    status         capture_status NOT NULL DEFAULT 'received',
    failure_reason TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX captures_by_project ON captures (tenant_id, project_id, captured_at DESC);
CREATE INDEX captures_awaiting_interpretation ON captures (tenant_id, status) WHERE status = 'received';

CREATE TABLE capture_proposals (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    capture_id   UUID NOT NULL REFERENCES captures (id) ON DELETE CASCADE,
    project_id   UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    -- What the agent thinks this is. Constrained to the same registry the
    -- human-facing tools use, so a proposal can never name a record type that
    -- does not exist.
    type_key     TEXT NOT NULL REFERENCES record_types (key) ON DELETE RESTRICT,
    title        TEXT NOT NULL,
    body         JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- [{ userId, role }], already resolved to real project members.
    participants JSONB NOT NULL DEFAULT '[]'::jsonb,
    confidence   NUMERIC(4, 3),
    -- Why the agent read it this way, in one or two sentences. Shown to the
    -- approver: a proposal you cannot interrogate is a proposal you should not
    -- accept.
    rationale    TEXT,
    model        TEXT,
    -- Validation problems found when the proposal was drafted: a missing
    -- required field, an unresolvable person. Stored rather than discarded so
    -- the approver sees exactly what needs fixing before this can be accepted.
    issues       JSONB NOT NULL DEFAULT '[]'::jsonb,
    status       proposal_status NOT NULL DEFAULT 'pending',
    -- Did the human change anything before accepting? This is the quality
    -- metric for the whole pipeline: an agent whose drafts are always edited
    -- is an agent that is costing the field time rather than saving it, and
    -- you cannot hill-climb what you do not record.
    edited       BOOLEAN NOT NULL DEFAULT FALSE,
    decided_by   UUID REFERENCES users (id) ON DELETE SET NULL,
    decided_at   TIMESTAMPTZ,
    decision_note TEXT,
    -- Set when accepted. The link from signal to system of record.
    record_id    UUID REFERENCES records (id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Re-interpreting a capture supersedes the previous draft rather than racing
-- it, so an approver can never be shown two live drafts of the same signal.
CREATE UNIQUE INDEX capture_proposals_one_pending_per_capture
    ON capture_proposals (capture_id)
    WHERE status = 'pending';

CREATE INDEX capture_proposals_inbox
    ON capture_proposals (tenant_id, project_id, status, created_at DESC);

-- Every model call, costed at the time it was made. Two reasons this is a
-- table and not a log line: pricing is per tenant, and an outcome-priced
-- product needs to know what an outcome cost before it can charge for one.
CREATE TABLE ai_usage (
    id                 BIGSERIAL PRIMARY KEY,
    tenant_id          UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    purpose            TEXT NOT NULL,
    model              TEXT NOT NULL,
    input_tokens       INTEGER NOT NULL DEFAULT 0,
    output_tokens      INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    -- Millionths of a dollar. Integers, because a per-call cost of $0.0043
    -- rounded to cents is zero, and a million of those is not.
    cost_micros        BIGINT NOT NULL DEFAULT 0,
    capture_id         UUID REFERENCES captures (id) ON DELETE SET NULL,
    occurred_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ai_usage_by_tenant ON ai_usage (tenant_id, occurred_at DESC);

-- Same fence as every other tenant-scoped table (see migration 0006). Note
-- what this means for the interpreter: it reads the project's people and the
-- capture through the same policies as a human, so an agent cannot ground
-- itself in data the person it acts for could not see.
DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['captures', 'capture_proposals', 'ai_usage'] LOOP
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

GRANT USAGE, SELECT ON SEQUENCE ai_usage_id_seq TO plumbline_app;

-- The capture tool, so proposals can be permissioned like everything else.
INSERT INTO tools (key, scope, display_name, sort_order) VALUES
    ('capture', 'project', 'Capture', 55);

-- Capture has no 'create' privilege on purpose. Any level above 'none' can
-- capture, because a field worker who is refused a photo stops sending them,
-- and the signal is the asset. Deciding proposals is the restricted half.
INSERT INTO tool_privileges (tool_key, privilege, description) VALUES
    ('capture', 'review', 'Decide proposed records drafted from captures');
