-- 0034 · photographs, and the difference between an illustration and evidence
--
-- Every construction product has a photos tab and almost none of them is
-- worth anything, for one reason: they re-encode on upload and throw away the
-- EXIF. What is left is a picture with an upload date, which proves nothing
-- about when the work was in that condition.
--
-- So the original bytes are stored untouched and what the camera recorded
-- travels with them: the moment the shutter opened, and the point it opened
-- at. Those two facts are what make the claim file's evidence section
-- possible, and they are why this table exists separately from attachments.
--
-- Three decisions.
--
-- TAKEN AT IS NOT UPLOADED AT, and both are kept. A phone in a basement
-- uploads six hours later; a camera left in a truck uploads on Monday. The
-- photograph belongs to the day the work happened, and the gap between the
-- two is itself sometimes the point.
--
-- A photo BELONGS TO THE JOB, not to a record. Albums and record links are
-- both many-to-many on top, because the photograph of a cracked weld is
-- evidence in an observation, in a notice, on a punch item and in a claim,
-- and copying it four times means four things to keep in step.
--
-- And there is no album hierarchy. Every product that has built one has
-- ended up with photographs filed in three places and findable in none;
-- dates, locations and links are better index than a folder tree a different
-- person made.

CREATE TABLE photos (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    project_id    UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    storage_key   TEXT NOT NULL,
    content_type  TEXT NOT NULL,
    byte_size     BIGINT NOT NULL,
    -- Of the original bytes, so a re-upload of the same photograph is
    -- recognised rather than duplicated. Two crews photograph the same crack.
    sha256        TEXT NOT NULL,
    filename      TEXT,

    -- What the camera recorded. Local time with no zone, because EXIF does
    -- not record one and inventing UTC would shift every photograph on a job
    -- by up to a day. The project calendar turns it into an instant.
    taken_at_local TIMESTAMP,
    latitude      NUMERIC(9, 6),
    longitude     NUMERIC(9, 6),
    altitude_m    NUMERIC(8, 2),
    orientation   SMALLINT,
    camera_make   TEXT,
    camera_model  TEXT,
    width         INTEGER,
    height        INTEGER,
    -- True when the file carried no EXIF at all. Stored rather than inferred
    -- from nulls, because "the camera did not say" and "nobody has looked"
    -- are different and only one of them is worth chasing.
    metadata_read BOOLEAN NOT NULL DEFAULT FALSE,

    caption       TEXT,
    taken_by      UUID REFERENCES users (id) ON DELETE SET NULL,
    uploaded_by   UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Where it came from, when it came through the capture pipeline.
    capture_id    UUID REFERENCES captures (id) ON DELETE SET NULL,
    UNIQUE (project_id, sha256)
);

CREATE INDEX photos_by_date ON photos (tenant_id, project_id, taken_at_local DESC NULLS LAST);
CREATE INDEX photos_located ON photos (tenant_id, project_id) WHERE latitude IS NOT NULL;
CREATE INDEX photos_undated ON photos (tenant_id, project_id) WHERE taken_at_local IS NULL;

CREATE TABLE photo_albums (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    project_id  UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    description TEXT,
    created_by  UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, name)
);

CREATE TABLE photo_album_members (
    album_id  UUID NOT NULL REFERENCES photo_albums (id) ON DELETE CASCADE,
    photo_id  UUID NOT NULL REFERENCES photos (id) ON DELETE CASCADE,
    tenant_id UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    added_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (album_id, photo_id)
);

CREATE TABLE photo_record_links (
    photo_id  UUID NOT NULL REFERENCES photos (id) ON DELETE CASCADE,
    record_id UUID NOT NULL REFERENCES records (id) ON DELETE CASCADE,
    tenant_id UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    linked_by UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (photo_id, record_id)
);

CREATE INDEX photo_record_links_by_record ON photo_record_links (tenant_id, record_id);

-- A photograph pinned to a point on a drawing. Same shape as drawing_pins for
-- records, and for the same reason: "where on the building" is the question
-- everybody actually asks.
CREATE TABLE photo_drawing_pins (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    photo_id    UUID NOT NULL REFERENCES photos (id) ON DELETE CASCADE,
    revision_id UUID NOT NULL REFERENCES drawing_revisions (id) ON DELETE CASCADE,
    x           NUMERIC(6, 5) NOT NULL,
    y           NUMERIC(6, 5) NOT NULL,
    created_by  UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (photo_id, revision_id)
);

ALTER TABLE photo_drawing_pins
    ADD CONSTRAINT photo_drawing_pins_on_the_sheet CHECK (x BETWEEN 0 AND 1 AND y BETWEEN 0 AND 1);

INSERT INTO tools (key, scope, display_name, sort_order) VALUES
    ('photos', 'project', 'Photos', 36);

INSERT INTO tool_privileges (tool_key, privilege, description) VALUES
    ('photos', 'upload', 'Add photographs'),
    ('photos', 'organise', 'Create albums and link photographs to records'),
    ('photos', 'delete', 'Remove a photograph');

ALTER TABLE photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE photos FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON photos
    USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON photos TO plumbline_app;

ALTER TABLE photo_albums ENABLE ROW LEVEL SECURITY;
ALTER TABLE photo_albums FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON photo_albums
    USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON photo_albums TO plumbline_app;

ALTER TABLE photo_album_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE photo_album_members FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON photo_album_members
    USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON photo_album_members TO plumbline_app;

ALTER TABLE photo_record_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE photo_record_links FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON photo_record_links
    USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON photo_record_links TO plumbline_app;

ALTER TABLE photo_drawing_pins ENABLE ROW LEVEL SECURITY;
ALTER TABLE photo_drawing_pins FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON photo_drawing_pins
    USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON photo_drawing_pins TO plumbline_app;
