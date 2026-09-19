-- 0016 · finding a record again
--
-- Every construction platform has a search box and almost none of them work,
-- because they search titles. The thing people actually type is a fragment of
-- something somebody said eight weeks ago: "the rock at the north footing",
-- "anchor bolt embedment", "the one about the ceiling tiles". That text lives
-- in the body, which is JSONB, which is exactly the shape nothing indexes by
-- default.
--
-- So the index covers the designation, the title and every string value in the
-- body, weighted. A designation match beats a title match beats something
-- buried in a description, which is the order a person means when they type
-- "RFI 14".
--
-- Generated and stored rather than maintained by a trigger: a trigger is a
-- second place the rule lives and a first place it drifts.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE records ADD COLUMN search_vector tsvector
    GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(designation, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
        setweight(jsonb_to_tsvector('english', coalesce(body, '{}'::jsonb), '["string"]'), 'B')
    ) STORED;

CREATE INDEX records_search ON records USING GIN (search_vector);

-- Trigram on the designation as well, because "RFI 14", "rfi-014" and "RFI014"
-- are the same thing to a superintendent and three different strings to a
-- tokenizer.
CREATE INDEX records_designation_trigram ON records USING GIN (designation gin_trgm_ops);

COMMENT ON COLUMN records.search_vector IS
    'Designation and title weighted A, every string in the body weighted B. Generated, never written to.';
