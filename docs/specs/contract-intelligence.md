# Contract Intelligence and the Notice Clock

Status: stages A and C are built and tested; stage B is built except for the model that feeds it; D and E are not started.

Built: `contract_documents`, `contract_clauses`, `project_calendars`, `project_holidays` (migration 0030); `contract_obligations`, `obligation_clocks`, `clock_engine_cursor` and the `notice` record type (0031). Deterministic segmentation, the quote gate, the deadline arithmetic with its frozen computation, the event-log clock engine with idempotent firing, promotion, expiry and discharge, obligation review with flow-down, API routes, and the contract profile screen.

Not built: the extraction model behind the screen and extract passes (the seam is there, nothing calls a provider yet), notice drafting, the claim file, and the statutory deadline dataset.

Depends on: the record kernel, ball in court, the capture pipeline and the approval gate, all of which exist.

Two things this document got wrong, corrected in the build rather than here: the notice workflow had `drafted` holding with the assignee, which stranded a drafter who lacked the `issue` privilege while the window ran out (it holds with the approver now), and the clause-text permission was specified as a separate `view_terms` gate on top of instrument visibility, which would have stopped a subcontractor reading the subcontract they signed. Being a party to an instrument is the right to read it; `view_terms` extends that to instruments you are not a party to.

## 1. Why this and not something else

Construction contracts do not just describe the work. They impose deadlines on the act of *complaining* about the work. A delay is compensable only if you gave written notice within the window the contract sets, usually five to twenty-one days, often measured from the moment you became aware rather than the moment the delay occurred. Miss the window and the claim is waived regardless of merit. The same shape governs differing site conditions, weather days, change directives, cure periods, payment applications and lien rights.

That is the most expensive failure mode in the industry and it is not an intelligence problem. It is a bookkeeping problem that nobody does, because doing it means someone reading a 200 page contract, extracting every timed obligation, and then watching the job for the events that start each clock.

The competitive landscape, surveyed 2026-09-18, splits into three camps that all stop short of this. Reality capture (Buildots, OpenSpace, Doxel) knows the site is behind. Schedule forecasting (nPlan, ALICE) knows which activity will slip. Document intelligence (Document Crunch, Trunk Tools) knows what the contract says and cites it to the clause. Not one of them converts a finding into an obligation with a named holder and a deadline, because none of them holds all three inputs at once. This system does, and only because the kernel already carries the third.

Framed for a buyer: every other tool tells you something is wrong. This one tells you what you owe, to whom, by when, and what it costs you to be late.

## 2. The core design decision

**A clock is a record in draft with a due date.**

This is not a new subsystem. The kernel already gives us a record with a typed body, a state machine, an assignment row with `expected_action` and `due_at`, an append-only event log and a permission model. A notice clock is:

1. an event on `record_events` that matches an obligation's trigger,
2. arithmetic over a project calendar to get a deadline,
3. a `notice` record created in `watching`, holding an assignment whose `due_at` is that deadline.

Discharging the clock is the record transitioning to `issued`. Everything else (the "In your court" screen, overdue banners, the audit trail, row-level security) comes along for free. Resist every temptation to build a parallel deadline engine with its own notifications and its own list screen.

Note the existing constraint `record_assignments_one_open_per_record`: one open assignment per record. That is satisfied by this design, because each clock owns exactly one notice record.

## 3. Data model

Four new tables. All tenant-scoped, all under the same forced row-level security as everything else.

### 3.1 `contract_documents`

The paper. One row per executed instrument.

```
id, tenant_id, project_id
kind                 prime_contract | subcontract | purchase_order | general_conditions
                     | supplementary_conditions | amendment | change_order | exhibit
counterparty_org_id  the other side of this instrument
parent_document_id   amendments and exhibits point at what they modify; subcontracts
                     point at the prime when it is incorporated by reference
executed_at, effective_at
storage_key          object storage, same path as record_attachments
status               uploaded | segmented | profiled | active | superseded
version              optimistic concurrency, same pattern as records
```

### 3.2 `contract_clauses`

The citation anchor, and the reason this system can be trusted at all.

```
id, tenant_id, document_id
clause_number        as printed, "8.3.2", nullable for unnumbered prose
heading, text
page, bbox           coordinates on the page, so a citation renders as a highlight
                     on the original PDF rather than as a quotation we retyped
order_index
```

Segmentation is deterministic parsing, not a model. If the parser cannot find clause boundaries the document is flagged for manual segmentation rather than guessed at.

### 3.3 `contract_obligations`

The extracted, machine-actionable rule. This is the valuable object.

```
id, tenant_id, project_id, document_id
clause_id            NOT NULL. There is no such thing as an uncited obligation.
quote                verbatim text the extraction relied on, which must be
                     findable inside contract_clauses.text or the row is rejected

obligation_type      notice_of_delay | notice_of_change | notice_of_claim
                     | differing_site_conditions | weather_day | cure_period
                     | submittal_turnaround | rfi_response_time
                     | payment_application_window | payment_due | retainage_release
                     | substantial_completion | liquidated_damages
                     | insurance_certificate | safety_reporting | closeout_submission
obligor_party        our_org | counterparty | either
obligee_party        who must receive it

trigger_kind         record_event | schedule_event | calendar_date | manual
trigger_match        JSONB. For record_event: {type_key, event} matched against
                     record_events, e.g. {"type_key":"observation","event":"created"}
trigger_description  the human sentence, for the review screen

duration_value       integer
duration_unit        days | business_days | weeks | months
deadline_basis       from_occurrence | from_awareness | from_written_notice | from_receipt
consequence          waiver_of_claim | liquidated_damages | payment_withheld
                     | default | none_stated
form_requirements    JSONB {written, specific_form, delivery_method, copy_to[]}

confidence           0..1 from the extractor
rationale            why the extractor read it this way
extracted_by         model id
status               proposed | accepted | rejected | superseded
reviewed_by, reviewed_at
```

An obligation with `status = 'proposed'` does not start clocks. It is a proposal like any other, and it goes through the same gate as a capture proposal, for the same reason: a wrong obligation silently mis-times a legal deadline, which is worse than no obligation at all.

### 3.4 `obligation_clocks`

One row per firing.

```
id, tenant_id, project_id, obligation_id
triggering_event_id  the record_events row, so the chain is provable
triggering_record_id
notice_record_id     the record that carries the ball in court

occurred_at          when the condition happened
awareness_at         when we can prove we knew, nullable
started_at           whichever of the two the deadline_basis selects
due_at               computed
warn_at              derived, see 5.3

state                watching | in_court | satisfied | expired | tolled | waived | cancelled
satisfied_at, satisfied_by_record_id
tolled_reason, tolled_at, tolled_by

computation          JSONB snapshot: the basis, the duration, the calendar used,
                     the holidays applied, the resulting arithmetic. Frozen at
                     computation time. A deadline you cannot show your work for
                     is a deadline nobody will rely on.
```

### 3.5 Two new record types (configuration, not code)

`notice` with fields for notice type, clause reference, addressed-to, delivery method, body and proof of delivery, and states `watching -> drafted -> reviewed -> issued -> acknowledged`, plus a terminal `not_required`.

`claim` for when a notice matures into a request for time or money.

Both are JSONB record type definitions in a migration, exactly like the existing five.

## 4. Extraction

Five stages, and only stage three is a model.

1. **Ingest and segment.** PDF to text with layout, then clause segmentation into `contract_clauses` with page and bbox retained.
2. **Screen.** A cheap high-recall pass over each clause: does this create a timed obligation? Tuned for recall, because a missed clause is a silent failure and a false positive is thirty seconds of a reviewer's time.
3. **Extract.** For each candidate, one call returning the `contract_obligations` schema through `output_config.json_schema`, with the verbatim quote required. If the quote is not found in the clause text, the row is discarded before it reaches the database. This runs through the existing provider seam, so it is metered per tenant like every other call.
4. **Resolve.** Supplementary conditions override general conditions; amendments override both; a subcontract that incorporates the prime by reference inherits its obligations, marked as inherited with the chain recorded. Where two instruments conflict and neither clearly governs, the system raises the conflict for a human. It never silently picks.
5. **Review.** The contract profile screen: every extracted obligation, its clause text with the quote highlighted on the original page, accept or edit or reject. This is a one-time cost per contract, probably half an hour, and it is the moment the product either earns trust or loses it. Design it as the centrepiece, not as an admin page.

## 5. The clock engine

### 5.1 Firing

A worker reads `record_events` forward from a durable cursor and matches each event against `trigger_match` on accepted obligations for that project. A match inserts an `obligation_clocks` row and a `notice` record in `watching`.

Idempotency is on `(obligation_id, triggering_event_id)`. Replaying the event log must not double-fire.

### 5.2 Date arithmetic

Deterministic. Never modeled. This is arithmetic and it must be exact.

A project calendar is required: work week, holidays, and the contract's own definition of a day where it gives one. Store it explicitly per project; do not infer it.

`from_awareness` is the interesting one. Contracts commonly say "within five days of becoming aware", and awareness is a fact rather than an event. The default is the timestamp of the earliest capture signal evidencing the condition, which is exactly the thing this product already has: a timestamped, geotagged voice note or photo from the field. That is a stronger evidentiary position than most contractors can construct after the fact, and it is worth saying out loud in the sales conversation.

**Bias early, always.** Where the basis is ambiguous, compute the earliest plausible deadline and record why in `computation`. An early warning is an annoyance. A late one is a waived claim. This asymmetry governs every judgment call in the engine.

### 5.3 Surfacing

A clock in `watching` appears on a dedicated Clocks view immediately, but does not occupy anyone's ball in court yet, because a system that fills a PM's queue with speculative notices will be ignored within a week.

It becomes `in_court` when either a human confirms the trigger, or `warn_at` arrives, whichever is first. `warn_at` defaults to half the window elapsed, floored at one business day before `due_at`. The automatic promotion is what stops an unconfirmed clock from expiring quietly.

On promotion the notice record's assignment is opened against the obligation holder for that project and type, with `expected_action` reading in the contract's own terms ("Give written notice of delay under 8.3.2") and `due_at` set to the deadline. From there it is an ordinary overdue item in a screen that already exists.

### 5.4 Discharge

`satisfied` when the notice record reaches `issued` with delivery recorded. `not_required` when a human dismisses it, with a reason, which is retained. `tolled` pauses accrual, audited. `expired` when the deadline passes unsatisfied, and an expired clock is never deleted, because the fact that it expired is itself evidence.

## 6. The claim file

Not a table. A query and an export that assembles, for a given clock or claim record: the triggering event, the capture evidence with its citations and geotags, the obligation and the clause text as printed, the notice record with delivery proof, the schedule impact, the cost impact, and the correspondence thread.

Construction disputes are decided on documentation. A file assembled continuously by the system, rather than reconstructed by a project engineer eighteen months later, is worth more than the software fee on its own.

## 7. Permissions

Contract terms are the most sensitive data in the system. A trade partner must not read the prime contract's terms, and usually must not read another sub's.

A new `contracts` tool key with the standard none / read_only / standard / admin levels, plus granular privileges for uploading an instrument, accepting an extracted obligation, and tolling or dismissing a clock. Obligations are visible to the parties to their instrument.

One specific requirement: the ball-in-court row must be visible to its holder without necessarily exposing the clause text. A superintendent needs to know a notice is due today. They do not need the prime's indemnity language. Add a `citation_visible` flag on the assignment rendering.

## 8. Evaluation

Three separate things, measured separately.

**Extraction quality.** Precision and recall per `obligation_type` against a labeled corpus: AIA A201, ConsensusDocs, DBIA, and a set of owner-custom forms, which are the hard case and the realistic one. Runs through the existing eval harness with its noise floor and regression gate.

**Citation accuracy.** Does the quote actually appear at the cited locus. Binary, deterministic, and it should be 100%, because anything less means the system fabricated a citation, which is the one failure that destroys the product.

**Clock correctness.** Unit tests on date arithmetic against a holiday calendar. Deterministic.

The metric that matters most: **late-deadline error rate**, weighted far above every other number. A deadline computed earlier than truth is noise. A deadline computed later than truth is the thing we exist to prevent. Track it separately, publish it, and gate releases on it.

## 9. What this system will not do

- **It will not send a notice.** Issuing is always a human transition. An agent may draft anything and serve nothing.
- **It will not give legal advice.** The framing is always "your contract says this, at this clause, here is the text." Never "you are entitled to" or "you should claim."
- **It will not resolve conflicting clauses silently.** Conflicts surface as conflicts.
- **It will not delete or auto-close a clock.** Dismissal is a human act with a recorded reason.
- **It will not hide its arithmetic.** Every deadline renders its computation on demand.

Each of these is a product decision, not timidity. The buyer is a general contractor's risk function, and the thing that sells to them is a system that is obviously conservative.

## 10. Build order

**A. Paper and citations, no AI.** `contract_documents`, `contract_clauses`, ingestion, segmentation, and a viewer that renders a clause highlighted on the original page. Proves documents are addressable before anything reads them.

**B. Extraction behind the gate.** `contract_obligations`, the screen and extract passes, the resolution rules, and the contract profile review screen. Nothing fires yet.

**C. The engine.** `obligation_clocks`, the project calendar, the event-log worker, the deterministic date arithmetic and the ball-in-court promotion. This is where the tests get serious.

**D. Notices.** The `notice` record type, a drafting agent that writes the letter from the clause and the evidence, delivery tracking.

**E. The claim file.** Assembly and export.

A is a week. C is the one that decides whether the product is trustworthy, and it is mostly arithmetic and tests rather than AI.

## 11. Open questions

- **Which contract forms first.** AIA A201 is the most common and the best documented. Owner-custom forms are where the money is and where extraction is hardest. Starting with A201 risks building for the easy case.
- **Statutory deadlines are a separate, better problem.** Lien and bond claim deadlines are set by state statute, not by contract. They vary by state and by party role, they are public, and blowing one costs the money outright rather than merely the claim. That is a curated reference dataset plus the same clock engine, with no extraction risk at all. It may be worth building before contract extraction, because it is deterministic and the consequence is larger.
- **Whether counsel review belongs in the product.** A "send this profile to our attorney" path is plausible and would raise trust considerably.
- **Subcontract flow-down depth.** A prime incorporated into a subcontract incorporated into a purchase order is three levels of inheritance, and real projects do this.
