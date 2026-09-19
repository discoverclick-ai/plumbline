-- 0017 · telling people, and letting them reply
--
-- Ball in court is worthless if nobody is told they are holding it. Up to now
-- the product has assumed somebody opens the app, which is the assumption that
-- kills field adoption: a superintendent does not open your app, your app
-- reaches them or it does not exist.
--
-- Two halves.
--
-- Outbound. Notifications are rows before they are emails, generated from the
-- event log by a worker rather than inline with the write. A transition that
-- fails because a mail server is slow is a transition that should have
-- succeeded, and a notification the recipient has already dealt with in the
-- app should not arrive an hour later anyway.
--
-- Inbound. Every record gets its own reply address. Replying to a notification
-- lands a comment on the record it came from, which is the single cheapest
-- adoption win available: the sub who will never log in still replies to
-- email, and right now that reply is invisible to the project.
--
-- The reply address carries a token, not the record id. An address you can
-- guess by counting is an address anybody can post a comment to, and these
-- arrive with no session to check.

CREATE TYPE notification_channel AS ENUM ('email', 'push', 'digest');

CREATE TYPE notification_state AS ENUM ('pending', 'sent', 'suppressed', 'failed');

CREATE TABLE notifications (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    project_id    UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    record_id     UUID REFERENCES records (id) ON DELETE CASCADE,
    recipient_id  UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    channel       notification_channel NOT NULL DEFAULT 'email',
    -- What happened, in the event log's own vocabulary.
    reason        TEXT NOT NULL,
    subject       TEXT NOT NULL,
    body          TEXT NOT NULL,
    state         notification_state NOT NULL DEFAULT 'pending',
    -- The event this came from, so a replayed log cannot notify twice.
    source_event  BIGINT,
    error         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at       TIMESTAMPTZ
);

CREATE UNIQUE INDEX notifications_once_per_event_and_person
    ON notifications (source_event, recipient_id)
    WHERE source_event IS NOT NULL;

CREATE INDEX notifications_pending ON notifications (state, created_at) WHERE state = 'pending';
CREATE INDEX notifications_for_recipient ON notifications (tenant_id, recipient_id, created_at DESC);

-- Where the worker got to. One row, same shape as any durable cursor.
CREATE TABLE notification_cursor (
    name            TEXT PRIMARY KEY,
    last_event_id   BIGINT NOT NULL DEFAULT 0,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO notification_cursor (name, last_event_id) VALUES ('notifications', 0);

-- Per person, per project: the people who want every RFI and the people who
-- want only what lands in their court are the same product with one row
-- different.
CREATE TABLE notification_preferences (
    tenant_id     UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    user_id       UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    project_id    UUID REFERENCES projects (id) ON DELETE CASCADE,
    -- 'ball_in_court' is the default and the only one worth defaulting to.
    -- 'all' is for the coordinator who reads everything; 'none' is for the
    -- person who would otherwise filter you into a folder and stop looking.
    scope         TEXT NOT NULL DEFAULT 'ball_in_court'
                  CHECK (scope IN ('all', 'ball_in_court', 'none')),
    PRIMARY KEY (tenant_id, user_id, project_id)
);

-- One address per record per person, so a forwarded email cannot be used to
-- post as somebody else.
CREATE TABLE record_reply_addresses (
    token       TEXT PRIMARY KEY,
    tenant_id   UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    record_id   UUID NOT NULL REFERENCES records (id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at  TIMESTAMPTZ,
    UNIQUE (record_id, user_id)
);

CREATE INDEX record_reply_addresses_by_record ON record_reply_addresses (tenant_id, record_id);

DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['notifications', 'notification_preferences', 'record_reply_addresses'] LOOP
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
