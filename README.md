# Plumbline

A construction management platform, built on one record kernel instead of two dozen hand-built tools.

The research this is built from is in [`docs/procore-teardown.md`](../docs/procore-teardown.md). This is the first vertical slice of the blueprint in section 8 of that document.

> Codename only. Plumbline lives inside the `smartbox-x` repository because that is where the work started; it shares no code, no schema and no database with the vending platform, and it should graduate to its own repository before it grows further.

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

## Layout

```
plumbline/
  db/         Postgres schema and migration runner
  shared/     the kernel: types, workflow engine, permissions, repositories
  api/        HTTP surface over the kernel
```

`shared/src` is worth reading in this order: `record-type.ts` (what a tool is), `workflow.ts` (the state machine, pure), `permissions.ts` (every authorization rule, in one file), `kernel.ts` (the transaction that ties them together).

## Running it

```bash
npm install
DATABASE_URL=postgres://…/plumbline npm run migrate:plumbline
npm test -w @plumbline/shared
npm test -w @plumbline/api
```

Migrations run as the database owner. The application must run as `plumbline_app`, a non-superuser role created by migration `0006_rls.sql`; connect as an owner role carrying `BYPASSRLS` and every policy is skipped silently, with no error and no sign anything is wrong.

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
```

## What is deliberately not here yet

In blueprint order: the capture pipeline (photo, voice and document in, proposed record out, human approval gate), the entity graph and scoped retrieval, the first agents with their eval harness, the financial spine (a configurable budget code of named segments), offline predictive sync, and the web client.

The capture pipeline is the one that matters. Everything above is table stakes that Procore already has; inverting data entry so the field produces signal and agents draft the records is the part they cannot retrofit.

## Adding a tool

Write a row in `record_types` with a definition holding `fields` and a `workflow`. Add its tool key to `tools` and any granular privileges to `tool_privileges`. Nothing else: no table, no service, no endpoint, no client release.

Definitions are validated at load by `parseRecordTypeDefinition`, including dangling state references, because a transition pointing at a state that does not exist would otherwise strand records in a status nothing can act on.
