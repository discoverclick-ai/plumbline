-- 0028 · offline that is not a lie
--
-- Procore's offline caches what you already opened. If you did not open the
-- drawing while you had signal, you do not have the drawing, and you are in a
-- basement. That is not a limitation, it is a design failure, and it is the
-- most winnable gap in the product category.
--
-- Real offline needs three things nobody builds together.
--
-- PREDICTIVE SYNC. The device pulls what this person will need on this job
-- before they lose signal: their court, the current sheets for their
-- discipline, the records they touched this week. Caching on open is caching
-- the past.
--
-- FIELD LEVEL MERGE. Two people editing one record offline is normal on a
-- job, and last-write-wins throws away somebody's afternoon. Merging per field
-- keeps both unless they touched the same one.
--
-- A CONFLICT LOG A HUMAN CAN READ. When two people did change the same field,
-- the answer is not to pick. It is to keep both, apply one, and tell somebody
-- which was dropped, because on a jobsite the dropped one is sometimes the
-- one that mattered.
--
-- The device identity matters more than it looks: the same person on a phone
-- and a tablet is two sync states, and treating them as one is how a change
-- made on the tablet vanishes when the phone catches up.

CREATE TABLE sync_devices (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    user_id       UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- Chosen by the client and stable across reinstalls where the platform
    -- allows it. A phone and a tablet are two devices and two sync states.
    device_key    TEXT NOT NULL,
    label         TEXT,
    -- Where this device has read up to in the event log. The whole sync
    -- protocol is this number.
    last_event_id BIGINT NOT NULL DEFAULT 0,
    last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, device_key)
);

CREATE INDEX sync_devices_by_tenant ON sync_devices (tenant_id, user_id);

CREATE TYPE sync_outcome AS ENUM ('applied', 'merged', 'conflicted', 'rejected', 'duplicate');

/*
 * Every change a device pushed, and what happened to it.
 *
 * Append-only and kept, including the ones that were rejected. "My change did
 * not save" is the single most corrosive thing a field tool can do, and the
 * only answer that helps is being able to show the person exactly what arrived
 * and what became of it.
 */
CREATE TABLE sync_operations (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    device_id      UUID NOT NULL REFERENCES sync_devices (id) ON DELETE CASCADE,
    -- Generated on the device. The idempotency key: a phone that pushes,
    -- loses signal before the response, and pushes again must not double.
    client_op_id   TEXT NOT NULL,
    record_id      UUID REFERENCES records (id) ON DELETE SET NULL,
    kind           TEXT NOT NULL,
    payload        JSONB NOT NULL,
    -- The record version the device was working from, which is what makes a
    -- three-way merge possible rather than a guess.
    base_version   INTEGER,
    outcome        sync_outcome NOT NULL,
    -- Fields the server kept from the device, and fields it did not.
    applied_fields TEXT[] NOT NULL DEFAULT '{}',
    dropped_fields TEXT[] NOT NULL DEFAULT '{}',
    detail         TEXT,
    -- When the device says it happened, which is not when it arrived. On a
    -- job those can be eight hours apart and the first one is the true one.
    occurred_at    TIMESTAMPTZ NOT NULL,
    received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (device_id, client_op_id)
);

CREATE INDEX sync_operations_by_record ON sync_operations (tenant_id, record_id, received_at);
CREATE INDEX sync_operations_conflicts
    ON sync_operations (tenant_id, outcome, received_at DESC) WHERE outcome = 'conflicted';

DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['sync_devices', 'sync_operations'] LOOP
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
