-- 0037 · the words a machine heard, kept apart from the words a person typed
--
-- A voice memo from a jobsite and a photograph of a handwritten field ticket
-- both reached the capture inbox and stopped there: "This capture has no text
-- to interpret yet". The two kinds of signal a phone is actually good at
-- producing were the two the pipeline could not read.
--
-- The transcript goes in its own column rather than into `text`. They are not
-- the same kind of fact. `text` is what a person typed and meant; a transcript
-- is a machine's best reading of a recording, and "no rebar" and "know rebar"
-- sound identical. Merged into one column the distinction is gone by the time
-- anybody reviews the proposal, and what a person is asked to approve looks
-- like something they wrote.
--
-- Both are handed to the interpreter together, because a voice memo with a
-- typed note attached is both, and the typed note usually carries the names
-- and the jargon the transcript got wrong.

ALTER TABLE captures
    ADD COLUMN transcript       TEXT,
    -- What produced it, frozen. A transcript read back in a claim two years
    -- from now needs to say what heard it.
    ADD COLUMN transcript_model TEXT,
    ADD COLUMN transcribed_at   TIMESTAMPTZ;
