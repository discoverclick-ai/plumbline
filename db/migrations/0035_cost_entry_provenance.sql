-- 0035 · where a cost entry came from, said in the row itself
--
-- A budget line rolls up to one number and that number cannot defend itself.
-- "$142,000 actual" against electrical tells a project manager nothing about
-- whether the invoice in their hand is already one of those dollars, and the
-- natural response to not knowing is to enter it, which is how a job ends up
-- looking over budget until an accountant unpicks it three weeks later.
--
-- Two of the three ways a cost entry is born already said so. The posting
-- worker stamps `source_event`. A hand entry names a record in
-- `source_record_id` when there is one. The third way said nothing at all:
-- approving a payment application writes actual cost directly, with a NULL
-- source and the approver in `created_by`, which on screen is exactly what a
-- hand entry looks like. The dollars were right and their provenance was a
-- lie, and provenance is the whole reason anybody trusts the dollars.
--
-- So the invoice is named. The unique index is the part that matters: a
-- payment application posts its cost once, and a second approval of the same
-- invoice cannot quietly double the job's actual cost.

ALTER TABLE cost_entries
    ADD COLUMN source_invoice_id UUID REFERENCES invoices (id) ON DELETE SET NULL;

CREATE UNIQUE INDEX cost_entries_once_per_invoice_line
    ON cost_entries (source_invoice_id, budget_code_id)
    WHERE source_invoice_id IS NOT NULL;

CREATE INDEX cost_entries_by_invoice
    ON cost_entries (source_invoice_id)
    WHERE source_invoice_id IS NOT NULL;
