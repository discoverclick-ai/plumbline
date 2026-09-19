-- 0029 · chasing
--
-- The most valuable thing an agent can do on a construction project is not
-- drafting. It is noticing that RFI-014 has been sitting with the architect
-- for eleven days against a seven day contract turnaround, that the steel it
-- blocks is being erected on Thursday, and that nobody has said anything.
--
-- That job is currently done by a project engineer with a spreadsheet and a
-- Friday afternoon, and it is done badly everywhere, because it is tedious and
-- the cost of missing one is invisible until it is enormous.
--
-- Three decisions that keep this from becoming spam.
--
-- An escalation is a RECORD of a decision, not a message. It is written when
-- the system decides somebody should be chased, and it carries why. A system
-- that only sends emails cannot answer "did we chase them, and when", which is
-- the question a delay claim turns on.
--
-- Escalations are ONCE per level per record. A daily nag is a filter rule
-- inside a week, and after that nothing the system sends is ever read again.
--
-- And the ladder is explicit. Reminder to the holder, then their manager, then
-- the person who raised it. Nobody is escalated to their boss by surprise.

CREATE TYPE escalation_level AS ENUM ('reminder', 'overdue', 'escalated', 'critical');

CREATE TABLE escalations (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    project_id    UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    record_id     UUID NOT NULL REFERENCES records (id) ON DELETE CASCADE,
    -- The assignment this is about. An escalation outlives it, which is the
    -- point: the record of the chase has to survive the ball moving on.
    assignment_id UUID REFERENCES record_assignments (id) ON DELETE SET NULL,
    level         escalation_level NOT NULL,
    -- Who is being chased, and who is being told.
    holder_id     UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    notified_id   UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    days_waiting  INTEGER NOT NULL,
    due_at        TIMESTAMPTZ,
    -- Written by the agent, read by a person. The whole value is here: not
    -- "RFI-014 is overdue" but what it blocks and what happens if it stays
    -- that way.
    reason        TEXT NOT NULL,
    drafted_message TEXT,
    -- Nothing is sent until somebody approves it, same gate as every other
    -- agent in this system.
    approved_by   UUID REFERENCES users (id) ON DELETE SET NULL,
    approved_at   TIMESTAMPTZ,
    dismissed_by  UUID REFERENCES users (id) ON DELETE SET NULL,
    dismissed_at  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Once per level per record. A daily nag becomes a filter rule inside a week.
CREATE UNIQUE INDEX escalations_once_per_level ON escalations (record_id, level);

CREATE INDEX escalations_open
    ON escalations (tenant_id, project_id, created_at DESC)
    WHERE approved_at IS NULL AND dismissed_at IS NULL;

ALTER TABLE escalations ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON escalations
    USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON escalations TO plumbline_app;
