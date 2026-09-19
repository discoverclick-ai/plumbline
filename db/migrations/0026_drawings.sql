-- 0026 · drawings
--
-- The first subsystem that is honestly not the record kernel. A drawing is not
-- a record with a state machine, it is a sheet that gets reissued, and the
-- question the whole tool exists to answer is "which revision is current for
-- S-401, and was the crew looking at it?" Getting that wrong is rework, and
-- rework is the most expensive word on a jobsite.
--
-- Three shapes, and the third is the one nobody builds properly.
--
-- A SET is an issuance: "100% CD", "Bulletin 3", "ASI 12". Sheets arrive in
-- sets and a set has a date, because "when did we receive this" is the first
-- question in every delay claim.
--
-- A SHEET has a number that never changes (S-401 is S-401 for the life of the
-- job) and many revisions. The current revision is derived from the
-- revisions, not stored on the sheet, for the same reason the budget derives
-- its totals: two places for one fact is one place too many.
--
-- A PIN ties a record to a coordinate on a sheet. This is where most tools
-- give up, because a pin belongs to the revision it was placed on, and the
-- sheet it was placed on stops being current the moment a new one arrives. An
-- RFI pinned to revision 2 of S-401 has to still be findable when revision 3
-- is issued, AND it has to still be honest about which drawing the person was
-- looking at when they raised it. Those are both true and most products pick
-- one: either the pin follows the sheet and silently lies about what was
-- asked, or it stays on the old revision and quietly disappears.
--
-- Here the pin stores the revision it was placed on and the sheet it belongs
-- to. The current sheet shows every pin from every revision, each marked with
-- where it came from.

CREATE TYPE drawing_set_status AS ENUM ('draft', 'published', 'superseded');

CREATE TABLE drawing_sets (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    project_id  UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    -- The date on the transmittal, which is not the date somebody uploaded it.
    -- Delay claims turn on the difference.
    issued_on   DATE NOT NULL,
    received_on DATE,
    status      drawing_set_status NOT NULL DEFAULT 'draft',
    published_at TIMESTAMPTZ,
    created_by  UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, name)
);

CREATE TABLE drawings (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    project_id  UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    -- S-401. Never changes for the life of the job.
    number      TEXT NOT NULL,
    title       TEXT NOT NULL,
    discipline  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, number)
);

CREATE INDEX drawings_by_project ON drawings (tenant_id, project_id, discipline, number);

CREATE TABLE drawing_revisions (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    drawing_id     UUID NOT NULL REFERENCES drawings (id) ON DELETE CASCADE,
    set_id         UUID NOT NULL REFERENCES drawing_sets (id) ON DELETE RESTRICT,
    -- As printed in the revision block: "0", "1", "A", "Bulletin 3".
    revision_label TEXT NOT NULL,
    -- Monotonic within a sheet, so "which is newer" never depends on parsing
    -- a label somebody typed.
    sequence       INTEGER NOT NULL,
    storage_key    TEXT NOT NULL,
    content_type   TEXT NOT NULL,
    byte_size      BIGINT NOT NULL,
    uploaded_by    UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (drawing_id, sequence),
    UNIQUE (drawing_id, revision_label)
);

CREATE INDEX drawing_revisions_by_drawing ON drawing_revisions (drawing_id, sequence DESC);

/*
 * Current revision, derived. Only from a PUBLISHED set: a sheet sitting in a
 * draft set is one somebody is still checking, and a crew building from it is
 * the exact accident this table exists to prevent.
 */
CREATE VIEW current_drawings AS
SELECT DISTINCT ON (d.id)
    d.id           AS drawing_id,
    d.tenant_id,
    d.project_id,
    d.number,
    d.title,
    d.discipline,
    r.id           AS revision_id,
    r.revision_label,
    r.sequence,
    r.storage_key,
    r.content_type,
    s.name         AS set_name,
    s.issued_on,
    (SELECT COUNT(*) FROM drawing_revisions dr WHERE dr.drawing_id = d.id) AS revision_count
FROM drawings d
JOIN drawing_revisions r ON r.drawing_id = d.id
JOIN drawing_sets s ON s.id = r.set_id AND s.status IN ('published', 'superseded')
ORDER BY d.id, r.sequence DESC;

-- A record, tied to a spot on a sheet.
CREATE TABLE drawing_pins (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    drawing_id   UUID NOT NULL REFERENCES drawings (id) ON DELETE CASCADE,
    -- The revision the person was actually looking at. Kept forever, because
    -- "which drawing were you working from" is the question a claim turns on.
    revision_id  UUID NOT NULL REFERENCES drawing_revisions (id) ON DELETE CASCADE,
    record_id    UUID NOT NULL REFERENCES records (id) ON DELETE CASCADE,
    page         INTEGER NOT NULL DEFAULT 1,
    -- Fractions of the page, so a pin survives a sheet being rescanned at a
    -- different resolution. Storing pixels would move every pin on the job the
    -- first time somebody re-exported the PDF at 300dpi.
    x            NUMERIC(6,5) NOT NULL,
    y            NUMERIC(6,5) NOT NULL,
    placed_by    UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (x >= 0 AND x <= 1),
    CHECK (y >= 0 AND y <= 1),
    UNIQUE (revision_id, record_id)
);

CREATE INDEX drawing_pins_by_drawing ON drawing_pins (tenant_id, drawing_id);
CREATE INDEX drawing_pins_by_record ON drawing_pins (record_id);

DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['drawing_sets', 'drawings', 'drawing_revisions', 'drawing_pins'] LOOP
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

GRANT SELECT ON current_drawings TO plumbline_app;

INSERT INTO tools (key, scope, display_name, sort_order) VALUES
    ('drawings', 'project', 'Drawings', 12);

INSERT INTO tool_privileges (tool_key, privilege, description) VALUES
    ('drawings', 'upload',  'Upload drawing sets and revisions'),
    ('drawings', 'publish', 'Publish a drawing set to the project'),
    ('drawings', 'pin',     'Pin records to a location on a sheet');
