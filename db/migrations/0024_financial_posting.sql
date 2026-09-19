-- 0024 · connecting the site to the money
--
-- Two record types already carry a cost and have no way to reach the budget:
-- a change event that has been executed, and a T&M ticket that has been
-- signed. Both are somebody agreeing to pay, and both currently stop at a
-- workflow state.
--
-- Rather than teaching the kernel about finance, the posting worker reads the
-- event log forward and posts what it finds, the same shape as notifications.
-- The kernel stays a kernel, finance stays finance, and the seam between them
-- is a durable cursor over an append-only log, which is also the only seam
-- that survives a replay.
--
-- What both types were missing is a budget code. A change event with a cost
-- impact and no code is a number nobody can file, which is exactly how it
-- ends up in a spreadsheet.
--
-- One code per record, deliberately. A change that spans several cost codes
-- is several change events, or it is a commitment change order with its own
-- lines. Letting one record carry a split invites a percentage allocation
-- field, and then nobody can say what the split was when the numbers are
-- questioned a year later.

UPDATE record_types SET version = 2, definition = jsonb_set(
    definition,
    '{fields}',
    (definition -> 'fields') || jsonb_build_array(
        jsonb_build_object('key', 'budget_code', 'label', 'Budget Code', 'type', 'text')
    )
) WHERE key = 'change_event';

-- The ticket needs an extended amount as well as a code. Hours alone cannot
-- reach a budget, because the rates that turn hours into dollars live in the
-- subcontract and not in this record. A worker that multiplied by a rate it
-- had guessed would be inventing the number the whole claim rests on.
UPDATE record_types SET version = 2, definition = jsonb_set(
    definition,
    '{fields}',
    (definition -> 'fields') || jsonb_build_array(
        jsonb_build_object('key', 'budget_code', 'label', 'Budget Code', 'type', 'text'),
        jsonb_build_object('key', 'cost_impact', 'label', 'Extended Amount', 'type', 'number')
    )
) WHERE key = 't_and_m_ticket';

INSERT INTO record_type_versions (type_key, version, definition, note)
SELECT key, version, definition, 'Added budget_code so an executed change can reach the budget'
  FROM record_types WHERE key IN ('change_event', 't_and_m_ticket');

CREATE TABLE financial_posting_cursor (
    name          TEXT PRIMARY KEY,
    last_event_id BIGINT NOT NULL DEFAULT 0,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO financial_posting_cursor (name, last_event_id) VALUES ('financial_posting', 0);

-- Every posting traces back to the event that caused it, and the unique index
-- is what makes a replay safe. Rewinding the cursor is what happens when a
-- bug in the poster is fixed, so it has to be free.
ALTER TABLE cost_entries ADD COLUMN source_event BIGINT;
ALTER TABLE budget_revisions ADD COLUMN source_event BIGINT;

CREATE UNIQUE INDEX cost_entries_once_per_event
    ON cost_entries (source_event) WHERE source_event IS NOT NULL;
CREATE UNIQUE INDEX budget_revisions_once_per_event
    ON budget_revisions (source_event) WHERE source_event IS NOT NULL;
