-- 0015 · distribution, so a record reaches people who do not hold the ball
--
-- Ball in court answers "who owes the next action". It deliberately does not
-- answer "who needs to know", and conflating the two is how construction
-- software ends up either notifying nobody or notifying everybody. The
-- project executive does not owe anything on an RFI and still wants to see
-- the ones about structural steel. The owner's rep is never in anybody's
-- court and reads everything.
--
-- The participant roles for this already exist (`distribution`, `watcher`).
-- What was missing is that participants could only be set when the record was
-- created, which meant the distribution was whatever the person raising it
-- happened to remember at 6am on a phone. That is not a list, it is a guess.
--
-- Two things here. A per-project, per-type default list, which is how anybody
-- gets copied without somebody remembering them. And the ability to change a
-- record's participants afterwards, because people join and leave jobs.

CREATE TABLE project_distribution_defaults (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    -- NULL means every record type on this project: the owner's rep who reads
    -- everything is one row, not one row per tool.
    type_key   TEXT REFERENCES record_types (key) ON DELETE CASCADE,
    user_id    UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role       participant_role NOT NULL DEFAULT 'distribution',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One rule per person per type. The partial indexes are two halves of the
-- same constraint, because NULL type_key would otherwise slip past a plain
-- unique index as many times as you like.
CREATE UNIQUE INDEX project_distribution_defaults_typed
    ON project_distribution_defaults (project_id, type_key, user_id)
    WHERE type_key IS NOT NULL;

CREATE UNIQUE INDEX project_distribution_defaults_all_types
    ON project_distribution_defaults (project_id, user_id)
    WHERE type_key IS NULL;

CREATE INDEX project_distribution_defaults_lookup
    ON project_distribution_defaults (tenant_id, project_id, type_key);

ALTER TABLE project_distribution_defaults ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_distribution_defaults FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON project_distribution_defaults
    USING (tenant_id = app_current_tenant())
    WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON project_distribution_defaults TO plumbline_app;
