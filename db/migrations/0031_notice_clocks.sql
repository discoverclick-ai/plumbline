-- 0031 · the notice clock
--
-- The core design decision, and the one worth defending: A CLOCK IS A RECORD
-- IN DRAFT WITH A DUE DATE.
--
-- The kernel already gives us a record with a typed body, a state machine, an
-- assignment row carrying expected_action and due_at, an append-only event log
-- and a permission model. A notice clock is an event that matches a trigger,
-- arithmetic over the project calendar, and a notice record created in
-- `watching` whose assignment is due at the deadline. Discharging it is that
-- record reaching `issued`.
--
-- Everything else comes along for free: the "In your court" screen, overdue
-- banners, escalation, the audit trail, row-level security. The temptation is
-- to build a parallel deadline engine with its own notifications and its own
-- list screen, and the result of that is a second inbox nobody reads.
--
-- An obligation is `proposed` until a human accepts it, and a proposed
-- obligation starts no clocks. Same gate as capture, for a sharper reason: a
-- wrong obligation silently mis-times a legal deadline, which is worse than
-- no obligation at all.
--
-- And an expired clock is never deleted. The fact that a deadline passed
-- unanswered is itself evidence, and a system that tidied it away would be
-- destroying the record of its own failure.

CREATE TYPE obligation_type AS ENUM (
    'notice_of_delay', 'notice_of_change', 'notice_of_claim', 'differing_site_conditions',
    'weather_day', 'cure_period', 'submittal_turnaround', 'rfi_response_time',
    'payment_application_window', 'payment_due', 'retainage_release',
    'substantial_completion', 'liquidated_damages', 'insurance_certificate',
    'safety_reporting', 'closeout_submission'
);

CREATE TYPE obligation_party AS ENUM ('our_org', 'counterparty', 'either');
CREATE TYPE obligation_trigger_kind AS ENUM ('record_event', 'schedule_event', 'calendar_date', 'manual');
CREATE TYPE duration_unit AS ENUM ('days', 'business_days', 'weeks', 'months');

-- Which moment the count runs from. `from_awareness` is the interesting one:
-- contracts routinely say "within five days of becoming aware", and awareness
-- is a fact rather than an event. This product happens to hold the best
-- evidence of it anybody has — a timestamped, geotagged note from the field.
CREATE TYPE deadline_basis AS ENUM ('from_occurrence', 'from_awareness', 'from_written_notice', 'from_receipt');

CREATE TYPE obligation_consequence AS ENUM (
    'waiver_of_claim', 'liquidated_damages', 'payment_withheld', 'default', 'none_stated'
);

CREATE TYPE obligation_status AS ENUM ('proposed', 'accepted', 'rejected', 'superseded');

CREATE TABLE contract_obligations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    project_id          UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    document_id         UUID NOT NULL REFERENCES contract_documents (id) ON DELETE CASCADE,
    -- NOT NULL, and it is the most important word in this file. There is no
    -- such thing as an uncited obligation: a deadline nobody can trace to a
    -- clause is one nobody will act on, and one nobody can defend if they do.
    clause_id           UUID NOT NULL REFERENCES contract_clauses (id) ON DELETE RESTRICT,
    -- Verbatim from the clause. Checked against contract_clauses.text before
    -- the row is written; a quote that is not found is discarded, not flagged.
    quote               TEXT NOT NULL,

    obligation_type     obligation_type NOT NULL,
    obligor_party       obligation_party NOT NULL,
    obligee_party       obligation_party NOT NULL,

    trigger_kind        obligation_trigger_kind NOT NULL,
    -- For record_event: {"type_key": "observation", "event": "created"},
    -- matched against record_events by the engine.
    trigger_match       JSONB NOT NULL DEFAULT '{}'::jsonb,
    trigger_description TEXT NOT NULL,

    duration_value      INTEGER NOT NULL,
    duration_unit       duration_unit NOT NULL,
    deadline_basis      deadline_basis NOT NULL,
    -- Whether the day of the event counts, and whether a deadline landing on
    -- a Saturday moves. Both are contract questions and neither is guessed:
    -- absent an express term the engine takes the reading that produces the
    -- EARLIER deadline, because an early warning is an annoyance and a late
    -- one is a waived claim.
    counts_start_day    BOOLEAN NOT NULL DEFAULT FALSE,
    rolls_forward       BOOLEAN NOT NULL DEFAULT FALSE,

    consequence         obligation_consequence NOT NULL DEFAULT 'none_stated',
    form_requirements   JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Where this obligation came from when it was not written in this
    -- instrument: a subcontract that incorporates the prime by reference
    -- inherits the prime's obligations, and the chain has to be provable.
    inherited_from_id   UUID REFERENCES contract_obligations (id) ON DELETE SET NULL,

    confidence          NUMERIC(3, 2),
    rationale           TEXT,
    extracted_by        TEXT,
    status              obligation_status NOT NULL DEFAULT 'proposed',
    reviewed_by         UUID REFERENCES users (id) ON DELETE SET NULL,
    reviewed_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE contract_obligations
    ADD CONSTRAINT contract_obligations_duration_sane CHECK (duration_value >= 0 AND duration_value <= 3650),
    ADD CONSTRAINT contract_obligations_confidence_range
        CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    -- Accepting an obligation is a named act by a person. An accepted row with
    -- nobody's name on it means the gate was bypassed somewhere.
    ADD CONSTRAINT contract_obligations_review_is_named
        CHECK (status IN ('proposed', 'rejected') OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL));

CREATE INDEX contract_obligations_live
    ON contract_obligations (tenant_id, project_id, trigger_kind)
    WHERE status = 'accepted';

CREATE INDEX contract_obligations_by_document ON contract_obligations (tenant_id, document_id, status);
CREATE INDEX contract_obligations_trigger_match ON contract_obligations USING GIN (trigger_match);

CREATE TYPE clock_state AS ENUM (
    'watching', 'in_court', 'satisfied', 'expired', 'tolled', 'waived', 'cancelled'
);

CREATE TABLE obligation_clocks (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    project_id           UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    obligation_id        UUID NOT NULL REFERENCES contract_obligations (id) ON DELETE RESTRICT,

    -- The row in the event log that started this. The chain from "a foreman
    -- photographed standing water" to "notice of differing site conditions was
    -- due on the 14th" has to be provable end to end, or it is worth nothing
    -- in the only conversation that matters.
    triggering_event_id  BIGINT REFERENCES record_events (id) ON DELETE SET NULL,
    triggering_record_id UUID REFERENCES records (id) ON DELETE SET NULL,
    -- The record that carries the ball in court. This is the whole design.
    notice_record_id     UUID REFERENCES records (id) ON DELETE SET NULL,

    occurred_at          TIMESTAMPTZ NOT NULL,
    awareness_at         TIMESTAMPTZ,
    started_at           TIMESTAMPTZ NOT NULL,
    due_at               TIMESTAMPTZ NOT NULL,
    warn_at              TIMESTAMPTZ NOT NULL,

    state                clock_state NOT NULL DEFAULT 'watching',
    promoted_at          TIMESTAMPTZ,
    satisfied_at         TIMESTAMPTZ,
    satisfied_by_record_id UUID REFERENCES records (id) ON DELETE SET NULL,
    tolled_reason        TEXT,
    tolled_at            TIMESTAMPTZ,
    tolled_by            UUID REFERENCES users (id) ON DELETE SET NULL,
    dismissed_reason     TEXT,
    dismissed_by         UUID REFERENCES users (id) ON DELETE SET NULL,

    -- The arithmetic, frozen. Holidays get edited and work weeks get
    -- corrected; the deadline a notice was served against must stay the one
    -- the system actually showed at the time. A deadline you cannot show your
    -- work for is a deadline nobody will rely on.
    computation          JSONB NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Replaying the event log must not double-fire. This is the idempotency key
-- and the reason the engine can be restarted without a reconciliation pass.
CREATE UNIQUE INDEX obligation_clocks_once_per_event
    ON obligation_clocks (obligation_id, triggering_event_id)
    WHERE triggering_event_id IS NOT NULL;

CREATE INDEX obligation_clocks_live
    ON obligation_clocks (tenant_id, project_id, due_at)
    WHERE state IN ('watching', 'in_court');

-- What the promotion sweep reads: everything still watching whose warning has
-- come due.
CREATE INDEX obligation_clocks_to_promote
    ON obligation_clocks (warn_at) WHERE state = 'watching';

ALTER TABLE obligation_clocks
    ADD CONSTRAINT obligation_clocks_tolling_is_explained
        CHECK (state <> 'tolled' OR (tolled_reason IS NOT NULL AND tolled_by IS NOT NULL)),
    -- Dismissal is a human act with a recorded reason. Never an auto-close.
    ADD CONSTRAINT obligation_clocks_waiver_is_explained
        CHECK (state <> 'waived' OR (dismissed_reason IS NOT NULL AND dismissed_by IS NOT NULL));

-- The engine's durable cursor over record_events, same pattern as financial
-- posting and notifications.
CREATE TABLE clock_engine_cursor (
    id              INTEGER PRIMARY KEY DEFAULT 1,
    last_event_id   BIGINT NOT NULL DEFAULT 0,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT clock_engine_cursor_single_row CHECK (id = 1)
);

INSERT INTO clock_engine_cursor (id, last_event_id) VALUES (1, 0);

ALTER TABLE contract_obligations ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_obligations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON contract_obligations
    USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON contract_obligations TO plumbline_app;

ALTER TABLE obligation_clocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE obligation_clocks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON obligation_clocks
    USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON obligation_clocks TO plumbline_app;

GRANT SELECT, UPDATE ON clock_engine_cursor TO plumbline_app;

INSERT INTO tool_privileges (tool_key, privilege, description) VALUES
    ('contracts', 'accept_obligation', 'Accept an extracted obligation, which is what lets it start clocks'),
    ('contracts', 'toll_clock',        'Pause or dismiss a running clock, with a reason');

-- ---------------------------------------------------------------------------
-- The notice record type
-- ---------------------------------------------------------------------------
--
-- Configuration, not code. It is a record type like the other twelve, which is
-- the point: a clock inherits the kernel's whole apparatus by being an
-- ordinary record rather than a special one.
--
-- `watching` holds with the creator on purpose. A clock that filled a PM's
-- queue the moment it fired would have the whole feature switched off inside a
-- week, so nothing lands in anybody's court until a human confirms the trigger
-- or the warning time arrives, whichever is first.

INSERT INTO tools (key, scope, display_name, sort_order) VALUES
    ('notices', 'project', 'Notices', 47);

INSERT INTO tool_privileges (tool_key, privilege, description) VALUES
    ('notices', 'create',      'Raise a notice'),
    ('notices', 'issue',       'Serve a notice on the other party'),
    ('notices', 'stand_down',  'Mark a notice as not required, with a reason');

INSERT INTO record_types (key, tool_key, display_name, display_name_plural, number_prefix, definition) VALUES

('notice', 'notices', 'Notice', 'Notices', 'NOT', $json$
{
  "fields": [
    { "key": "notice_type", "label": "Type of Notice", "type": "select", "required": true,
      "options": ["Delay", "Change in the Work", "Claim", "Differing Site Conditions", "Weather Day",
                  "Cure", "Suspension", "Termination", "Other"] },
    { "key": "clause_reference", "label": "Contract Clause", "type": "text", "required": true },
    { "key": "addressed_to", "label": "Addressed To", "type": "text", "required": true },
    { "key": "event_date", "label": "Date of the Event", "type": "date", "required": true },
    { "key": "awareness_date", "label": "Date We Became Aware", "type": "date" },
    { "key": "description", "label": "What Happened", "type": "multiline", "required": true },
    { "key": "relief_sought", "label": "Relief Sought", "type": "select",
      "options": ["Time Only", "Cost Only", "Time and Cost", "Reservation of Rights", "None Stated"] },
    { "key": "delivery_method", "label": "Delivery Method", "type": "select",
      "options": ["Certified Mail", "Email", "Hand Delivery", "Courier", "Portal"] },
    { "key": "delivered_on", "label": "Delivered On", "type": "date" },
    { "key": "proof_of_delivery", "label": "Proof of Delivery", "type": "text" },
    { "key": "not_required_reason", "label": "Why No Notice Is Required", "type": "multiline" }
  ],
  "workflow": {
    "initial": "watching",
    "states": [
      { "//": "Nobody's court yet. A system that fills a PM's queue with speculative notices is one that gets ignored inside a week, so a clock waits here until a human confirms it or the warning time arrives.",
        "key": "watching", "label": "Clock Running", "ballInCourt": "creator" },
      { "//": "The ball goes to whoever may serve it. Only the `issue` privilege can move a notice past here, so a drafter who does not hold it would otherwise sit on a record they cannot advance while the window runs out.",
        "key": "drafted", "label": "Drafted", "ballInCourt": "approver" },
      { "key": "reviewed", "label": "Reviewed", "ballInCourt": "approver" },
      { "key": "issued", "label": "Issued", "ballInCourt": "none" },
      { "key": "acknowledged", "label": "Acknowledged", "terminal": true, "ballInCourt": "none" },
      { "//": "Terminal, and it keeps the reason. A notice nobody served is a decision somebody made, and eighteen months later that decision is the whole conversation.",
        "key": "not_required", "label": "Not Required", "terminal": true, "ballInCourt": "none" }
    ],
    "transitions": [
      { "key": "draft", "label": "Draft the Notice", "from": ["watching"], "to": "drafted",
        "expectedAction": "Review the drafted notice and the clause it relies on", "dueInDays": 2,
        "requiresFields": ["description", "clause_reference", "addressed_to"],
        "requires": { "level": "standard", "privilege": "create" } },
      { "key": "review", "label": "Approve for Issue", "from": ["drafted"], "to": "reviewed",
        "expectedAction": "Serve this notice and record the delivery", "dueInDays": 1,
        "requires": { "level": "standard", "privilege": "issue" } },
      { "key": "return_for_edit", "label": "Return for Editing", "from": ["drafted", "reviewed"], "to": "watching",
        "expectedAction": "Revise this notice", "requires": { "level": "standard", "privilege": "create" } },
      { "//": "Issuing is always a human act. An agent may draft anything here and serve nothing, and that line does not move: a system that mailed a client's architect unsupervised is one incident away from being switched off entirely.",
        "key": "issue", "label": "Record as Served", "from": ["reviewed"], "to": "issued",
        "requiresFields": ["delivery_method", "delivered_on"],
        "requires": { "level": "standard", "privilege": "issue" } },
      { "key": "acknowledge", "label": "Record Acknowledgement", "from": ["issued"], "to": "acknowledged",
        "requires": { "level": "standard", "privilege": "issue" } },
      { "//": "A reason is required. Standing a clock down without one is how a waived claim becomes nobody's fault.",
        "key": "stand_down", "label": "Mark Not Required", "from": ["watching", "drafted"], "to": "not_required",
        "requiresFields": ["not_required_reason"],
        "requires": { "level": "standard", "privilege": "stand_down" } }
    ]
  }
}
$json$);
