-- 0032 · the schedule, and the only question anybody asks it
--
-- Every scheduling tool in this industry is built to answer "when does the
-- job finish". Nobody on site asks that. What they ask, every morning, is
-- some version of: what is going to stop us this week, and who is sitting on
-- it.
--
-- That question needs two things joined, and no product joins them. The
-- schedule knows that Install Curtain Wall starts Thursday with two days of
-- float. The RFI log knows that RFI-014 has been with the architect for
-- eleven days. Nothing anywhere knows that they are the same problem, because
-- the link between an activity and the paperwork blocking it lives in a
-- project engineer's head and leaves when they do.
--
-- So the valuable table here is `activity_links`, and everything else exists
-- to give it something to point at.
--
-- Three decisions.
--
-- A SCHEDULE IS A VERSION, never a live document. Every import is a new row
-- and the old one is kept. "The schedule said we had four days of float when
-- we raised this" is the sentence a delay claim is built on, and a schema
-- that overwrites cannot say it.
--
-- FLOAT IS STORED AS IMPORTED, never recalculated. This system does not run
-- CPM and will not pretend to. P6 computed it under that job's calendar and
-- constraints, and a number we recomputed differently is a number the
-- scheduler will not defend in a meeting.
--
-- And activities are NOT record types. An activity has no workflow, no ball
-- in court and no state anybody transitions; it is a fact about a plan.
-- Forcing it into the kernel would give it a state machine nobody uses.

CREATE TYPE schedule_source AS ENUM ('primavera_xer', 'msproject_xml', 'csv', 'manual');

CREATE TABLE schedules (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    project_id   UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    source       schedule_source NOT NULL,
    -- The date the schedule was calculated to, which is not the date it was
    -- imported. A month-old update imported today describes last month.
    data_date    DATE,
    -- Marks the contract baseline. Exactly one per project, enforced below:
    -- a job with two baselines has no baseline.
    is_baseline  BOOLEAN NOT NULL DEFAULT FALSE,
    -- The current working schedule. Also exactly one, for the same reason.
    is_current   BOOLEAN NOT NULL DEFAULT FALSE,
    imported_by  UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    imported_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- What the file said about itself: the exporting tool, its version, the
    -- project id inside it. Kept because the first question about a strange
    -- number is always "which tool wrote this".
    source_meta  JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX schedules_one_baseline ON schedules (project_id) WHERE is_baseline;
CREATE UNIQUE INDEX schedules_one_current ON schedules (project_id) WHERE is_current;
CREATE INDEX schedules_by_project ON schedules (tenant_id, project_id, imported_at DESC);

CREATE TABLE schedule_activities (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    schedule_id   UUID NOT NULL REFERENCES schedules (id) ON DELETE CASCADE,
    -- The id the scheduling tool uses, e.g. "A1010". This is what a
    -- superintendent says out loud and what links survive an import on.
    activity_code TEXT NOT NULL,
    name          TEXT NOT NULL,
    wbs_path      TEXT,
    start_at      DATE,
    finish_at     DATE,
    actual_start  DATE,
    actual_finish DATE,
    duration_days NUMERIC(8, 2),
    remaining_days NUMERIC(8, 2),
    percent_complete NUMERIC(5, 2),
    -- As imported, never recalculated. See the header.
    total_float_days NUMERIC(8, 2),
    free_float_days  NUMERIC(8, 2),
    is_critical   BOOLEAN NOT NULL DEFAULT FALSE,
    is_milestone  BOOLEAN NOT NULL DEFAULT FALSE,
    -- Activity codes of what must finish first. Stored as text rather than as
    -- foreign keys because a schedule routinely references activities that
    -- were filtered out of the export, and a dangling predecessor is a fact
    -- about the file rather than a reason to reject it.
    predecessors  TEXT[] NOT NULL DEFAULT '{}',
    responsible   TEXT,
    order_index   INTEGER NOT NULL,
    UNIQUE (schedule_id, activity_code)
);

CREATE INDEX schedule_activities_window
    ON schedule_activities (tenant_id, schedule_id, start_at)
    WHERE actual_finish IS NULL;

CREATE INDEX schedule_activities_critical
    ON schedule_activities (tenant_id, schedule_id, total_float_days)
    WHERE actual_finish IS NULL;

CREATE INDEX schedule_activities_by_code ON schedule_activities (tenant_id, activity_code);

-- ---------------------------------------------------------------------------
-- The table this migration exists for
-- ---------------------------------------------------------------------------
--
-- Links point at an ACTIVITY CODE and a project, not at a
-- `schedule_activities` row. That is deliberate and it is the whole design.
-- A schedule is reimported weekly; a link to a row would die every Monday,
-- and a feature that silently forgets its own data every week is one nobody
-- uses twice. The activity code is what survives, because it is also what a
-- superintendent says out loud.

CREATE TYPE activity_link_kind AS ENUM ('blocks', 'informs', 'delivers', 'documents');

CREATE TABLE activity_links (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    project_id    UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    record_id     UUID NOT NULL REFERENCES records (id) ON DELETE CASCADE,
    activity_code TEXT NOT NULL,
    kind          activity_link_kind NOT NULL DEFAULT 'blocks',
    note          TEXT,
    created_by    UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (record_id, activity_code, kind)
);

CREATE INDEX activity_links_by_activity ON activity_links (tenant_id, project_id, activity_code);
CREATE INDEX activity_links_by_record ON activity_links (tenant_id, record_id);

INSERT INTO tools (key, scope, display_name, sort_order) VALUES
    ('schedule', 'project', 'Schedule', 48);

INSERT INTO tool_privileges (tool_key, privilege, description) VALUES
    ('schedule', 'import', 'Import a schedule update'),
    ('schedule', 'set_baseline', 'Mark a schedule as the contract baseline'),
    ('schedule', 'link', 'Link a record to an activity');

ALTER TABLE schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedules FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON schedules
    USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON schedules TO plumbline_app;

ALTER TABLE schedule_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_activities FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON schedule_activities
    USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON schedule_activities TO plumbline_app;

ALTER TABLE activity_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_links FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON activity_links
    USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON activity_links TO plumbline_app;

-- ---------------------------------------------------------------------------
-- What is going to stop us this week
-- ---------------------------------------------------------------------------
--
-- One activity per row on the current schedule, with the open records linked
-- to it and how long each has been sitting. This is the view the morning
-- meeting is run off, and the reason the whole subsystem is here.

CREATE VIEW schedule_exposure AS
SELECT s.tenant_id,
       s.project_id,
       a.activity_code,
       a.name AS activity_name,
       a.start_at,
       a.finish_at,
       a.total_float_days,
       a.is_critical,
       count(l.id) FILTER (WHERE r.id IS NOT NULL) AS linked_records,
       count(l.id) FILTER (WHERE rt.id IS NULL AND r.id IS NOT NULL) AS open_records,
       max(EXTRACT(DAY FROM now() - asg.assigned_at)::int) FILTER (WHERE asg.released_at IS NULL)
         AS longest_wait_days
  FROM schedules s
  JOIN schedule_activities a ON a.schedule_id = s.id
  LEFT JOIN activity_links l
         ON l.tenant_id = s.tenant_id AND l.project_id = s.project_id
        AND l.activity_code = a.activity_code AND l.kind = 'blocks'
  LEFT JOIN records r ON r.id = l.record_id
  LEFT JOIN record_types rt_all ON rt_all.key = r.type_key
  -- A record is "open" when its status is not a terminal state of its type.
  -- Read out of the type definition rather than duplicated here, because a
  -- second list of terminal states is a second list that goes stale.
  LEFT JOIN LATERAL (
      SELECT 1 AS id
        FROM jsonb_array_elements(rt_all.definition -> 'workflow' -> 'states') AS state
       WHERE state ->> 'key' = r.status AND (state ->> 'terminal')::boolean IS TRUE
  ) rt ON TRUE
  LEFT JOIN record_assignments asg ON asg.record_id = r.id AND asg.released_at IS NULL
 WHERE s.is_current
 GROUP BY s.tenant_id, s.project_id, a.activity_code, a.name, a.start_at, a.finish_at,
          a.total_float_days, a.is_critical;

GRANT SELECT ON schedule_exposure TO plumbline_app;
