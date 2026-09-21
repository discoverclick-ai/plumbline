-- 0038 · the same photograph, sent twice, is one photograph
--
-- Capture is about to be retried routinely rather than exceptionally. A
-- superintendent takes a photograph in a basement with no signal; it sits in
-- a queue on the phone and goes up when the signal comes back, which on a
-- jobsite means on the drive out, through a tunnel, in a lift. Half of those
-- attempts end ambiguously: the request reached the server, the response did
-- not reach the phone.
--
-- A queue that retries an ambiguous send is correct. A server that accepts
-- the retry as a second capture is not, and the failure is quiet: the inbox
-- fills with pairs, the interpreter is paid twice for each, and somebody
-- reviewing a daily log sees the same observation listed two and three times
-- and stops trusting the log.
--
-- So the phone names the capture and the server honours the name. The key is
-- scoped to the person as well as the tenant, because two phones generating
-- keys independently must not be able to collide into one another's work.

ALTER TABLE captures ADD COLUMN client_key TEXT;

CREATE UNIQUE INDEX captures_one_per_client_key
    ON captures (tenant_id, captured_by, client_key)
    WHERE client_key IS NOT NULL;
