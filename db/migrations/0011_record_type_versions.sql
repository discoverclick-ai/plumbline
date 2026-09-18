-- 0011 · definition history, so changing a tool is a migration and not a bet
--
-- The whole architectural claim is that a tool is configuration: a record type
-- plus a state machine plus a permission template, editable without a deploy.
-- That claim is only safe if editing one cannot strand the records already
-- running under it. A removed state leaves records with a status the product
-- can no longer label. A narrowed dropdown leaves records holding a value the
-- product can no longer offer. A removed transition can leave a record in a
-- state it has no way out of, which is worse than a bug: it is a job stopped.
--
-- Records already stamp `type_version`. This gives that stamp something to
-- point at, so a record created two definitions ago can always be read back
-- under the definition it was created under.

CREATE TABLE record_type_versions (
    type_key     TEXT NOT NULL REFERENCES record_types (key) ON DELETE CASCADE,
    version      INTEGER NOT NULL,
    definition   JSONB NOT NULL,
    note         TEXT,
    published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (type_key, version)
);

COMMENT ON TABLE record_type_versions IS
    'Append-only history of every definition a record type has had. Nothing updates or deletes from this table.';

-- Whatever ships today becomes version 1's history entry, so the table is
-- never missing the version a live record points at.
INSERT INTO record_type_versions (type_key, version, definition, note)
SELECT key, version, definition, 'Initial definition, backfilled by migration 0011'
  FROM record_types;

GRANT SELECT ON record_type_versions TO plumbline_app;
