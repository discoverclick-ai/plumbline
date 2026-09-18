# Plumbline

A construction management platform, built on one record kernel instead of two dozen hand-built tools.

The research this is built from is in [`docs/procore-teardown.md`](docs/procore-teardown.md): a teardown of Procore, read from its shipping design system and its own documentation, and the architecture blueprint that came out of it. This repository is that blueprint, built.

## The bet

Every tool in the product is the same table. An RFI, a submittal, a punch item, an observation and a daily log differ by a row in `record_types` and by nothing else: their fields, their states, who owes the next action in each state, and what permission each transition demands are all data.

Two consequences, and they are the whole reason for the design.

A new tool is a configuration change rather than a quarter of engineering. Procore built roughly twenty-four tools by hand over fifteen years; the five shipped here cost one migration between them.

More importantly, an agent that can read, propose and transition a `record` can work every tool the product will ever have, including ones shipped after the agent was written. That is the thing a platform designed in 2012 cannot retrofit, and it is where this is meant to win.

## What runs today

Five record types, configured not coded: RFI, Submittal, Punch Item, Observation, Daily Log.

**Ball in court** as a first-class assignment, not a status field. Every open handoff has a holder, an expected action, a due time and a full history, so "who is blocking what, and for how long" is a join rather than a nightly report. `GET /ball-in-court` with no parameters is a field user's home screen.

**Permissions** in the shape the industry expects: per-tool levels of none, read only, standard and admin, assigned through templates at company and project scope, with task-based granular privileges layered on top. Eight default templates ship, from Project Manager to Trade Partner. No project membership means no project tools, full stop. A company administrator is admin everywhere, which is the only escalation in the system.

**Row-level security** on every tenant-scoped table, forced, with the application connecting as a non-superuser role. This matters more here than in ordinary SaaS: everything an agent reads, it must read under the same policies as the human it acts for. The RLS suite proves it with unfiltered queries under a confined role.

**Optimistic concurrency** on every record. Two PMs editing the same RFI from two trailers is the normal case, not the edge case.

**An append-only event log**, written inside the same transaction as the state change. That is the substrate agents will subscribe to, and the record a dispute gets settled from.

**Opaque server-side sessions**, scrypt passwords, revocation effective on the next request.

**The capture pipeline.** The field sends signal — a photo, a voice note, a scanned document, an email — and an agent drafts the record it should become. A human accepts, edits and accepts, or rejects.

One rule holds the whole thing up: an agent may propose anything and may create nothing. Acceptance calls the ordinary `RecordKernel.create` as the approving human, under their permissions, so a confident, well-formed proposal for a tool that person cannot use is refused exactly as hand entry would be. There is no confidence threshold that bypasses the gate and no batch mode that skips it; adding one would mean deleting `CaptureService`, not adding a flag to it.

Three properties worth knowing:

The prompt is generated from the record type registry, so a tool added by a migration next month is interpretable the moment it exists. No new agent, no prompt edit. That is the payoff of the kernel.

Grounding is confined by the same row-level security as a human. The type registry, the project roster and the capture are all read inside the approving user's tenant context, so the model cannot be grounded in data the people involved could not see. That is a property of the transaction, not an instruction in the prompt.

Every model call is costed per tenant at the time it ran, and every accepted proposal records whether the human had to edit it first. `acceptedUnedited / accepted` is the quality metric for the pipeline: an agent whose drafts always need fixing is costing the field time, not saving it.

## Layout

```
db/       Postgres schema and migration runner
shared/   the kernel: types, workflow engine, permissions, repositories
api/      HTTP surface over the kernel
eval/     the capture interpreter's eval suite
docs/     the Procore teardown this is built from
```

`shared/src` is worth reading in this order: `record-type.ts` (what a tool is), `workflow.ts` (the state machine, pure), `permissions.ts` (every authorization rule, in one file), `kernel.ts` (the transaction that ties them together).

## Running it

```bash
npm install
npm test                       # boots its own Postgres, applies every migration, 121 tests

# a real deployment
OWNER_DATABASE_URL=postgres://<owner>@host/plumbline npm run migrate
OWNER_DATABASE_URL=postgres://<owner>@host/plumbline npm run provision:app-role
npm start                      # the API on :8080
```

The test suites need no database of their own: they boot an embedded Postgres and apply `db/migrations` from scratch, so a clean clone runs green with no setup. See `.env.example` for what a real deployment needs.

### Do not skip `provision:app-role`

Migrations run as the database owner, because they need DDL and `CREATE ROLE`. The application must **not**: it runs as `plumbline_app`, a non-superuser role created by migration `0006_rls.sql` and deliberately left `NOLOGIN`, because issuing a credential is a deployment decision and no password belongs in a migration file.

Connect the application as an owner role instead and every row-level security policy is skipped silently. No error, nothing looks wrong, and reads simply return other tenants' rows. Managed Postgres platforms hand you owner roles that carry `BYPASSRLS` as a matter of course — Neon's `neondb_owner` does.

`provision:app-role` gives the role a login and then refuses to hand back a connection string until that role has demonstrated confinement in both directions: nothing visible with no tenant context, and exactly one tenant's rows visible with one. The second half is what separates "row-level security is working" from "this role cannot read anything at all", and both look identical if you only check the first.

## The API shape

The routes reflect the architecture: `/projects/:id/records?type=rfi`, not `/rfis`. A client written today keeps working against tools that do not exist yet, and `GET /record-types` hands it the fields, states and transitions needed to render one it has never seen.

```
POST   /auth/sign-in
GET    /me?projectId=…            level and privileges per tool, for the UI
GET    /record-types              the registry: fields, states, transitions
GET    /projects
GET    /projects/:id/records      ?type= &status= &open=true
POST   /projects/:id/records
GET    /records/:id               includes only the transitions YOU may run
PATCH  /records/:id
POST   /records/:id/transitions
POST   /records/:id/comments
GET    /records/:id/history
GET    /ball-in-court             ?projectId= &holderUserId= &overdue=true

POST   /projects/:id/captures     signal in; the cheapest call in the system
GET    /captures/:id
POST   /captures/:id/interpret    draft the record this signal should become
GET    /projects/:id/proposals    the approval inbox
POST   /proposals/:id/accept      THE GATE: creates the record as you
POST   /proposals/:id/reject
GET    /projects/:id/capture-stats
```

**The eval harness.** The interpreter is the one place in the product where a model decides something, so it has a number attached. 24 cases covering every record type plus the failures that matter — hallucination probes, an injection attempt, an observation/punch boundary, captures with nothing usable in them — graded programmatically on five metrics that trade against each other, so a prompt change that lifts field recall by inventing values shows up as `no_invention` falling.

It scores the real code path: the prompt is built by the same functions the product calls, from types loaded out of the database, so a migration that changes a record type changes the eval too. Every run prints its own noise floor, and the regression gate uses it as the default tolerance. And `--export` turns proposals a human edited before accepting into new cases whose gold answer is the human's correction, which is how the suite keeps matching real traffic. See [`eval/README.md`](eval/README.md).

## What is deliberately not here yet

In blueprint order: the entity graph and scoped retrieval, the financial spine (a configurable budget code of named segments), offline predictive sync, and the web client.

One gap inside the capture pipeline: transcription and OCR are not wired. A capture arrives with its `text` already extracted, and the step that turns audio and pixels into text is a separate provider call in front of the interpreter.

## Adding a tool

Write a row in `record_types` with a definition holding `fields` and a `workflow`. Add its tool key to `tools` and any granular privileges to `tool_privileges`. Nothing else: no table, no service, no endpoint, no client release.

Definitions are validated at load by `parseRecordTypeDefinition`, including dangling state references, because a transition pointing at a state that does not exist would otherwise strand records in a status nothing can act on.
