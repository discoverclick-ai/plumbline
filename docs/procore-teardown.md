# Procore Teardown and AI-Native Blueprint

Research date: 2026-09-18. Purpose: understand what actually makes Procore work, what it looks and feels like, and what an AI-native platform in the same shape should be architected like today.

## 0. Research constraints (read this first)

Every `*.procore.com` domain is blocked by this session's egress policy (403 on CONNECT for `www`, `support`, `learn`, and `developers`). So is Wikipedia, YouTube, G2, Capterra and the rest of the review sites. Video walkthroughs were not reachable at all.

Two channels did work, and both were productive. Web search returned substantive indexed content from Procore's own support and press pages. More usefully, `registry.npmjs.org` is on the proxy bypass list, so Procore's actual design system, `@procore/core-react@12.53.3`, was downloaded and inspected directly. Everything in section 3 about the page grammar comes from reading their shipped component API, not from marketing copy.

To finish the picture, unblock `procore.com`, `support.procore.com`, `developers.procore.com` and `core.procore.com` in the environment's network policy, or run the video research from an unrestricted session.

## 1. What Procore actually is

A construction operating system sold to the general contractor, with the owner and the specialty contractor pulled in behind them. FY26 Q2 revenue was $375.2M, up 15.8% year over year, with full-year guidance around $1.51B. Gross retention 95%. ARR splits 59% general contractors, 26% owners, 15% specialty contractors. 2,871 customers above $100k ARR make up 68% of ARR.

Read that last number carefully. This is an enterprise land-and-expand business whose product surface exists to justify seven-figure-adjacent contracts, not a tool that wins on elegance.

## 2. The commercial model drives the architecture

Procore charges by Annual Construction Volume, roughly 0.1% to 0.2% of hard construction costs, or about $700 to $1,000 per $1M of volume. Real contracts land between $4,500 and $60,000+ per year. Users are unlimited, storage is unlimited, support is included.

Unlimited users is the single most important product decision they ever made, and it is an architectural constraint, not a pricing gimmick. It means every subcontractor, architect, inspector and owner rep gets an account for free, which makes Procore the shared system of record for the whole project, which is the actual moat. Nobody rips out the place where all the other parties already are.

The consequence: permissions and multi-party access are load-bearing infrastructure, not a settings page. And per-seat pricing is off the table for anyone trying to copy the shape.

## 3. The look and feel, decoded from the shipping code

`@procore/core-react` is 103 components built on styled-components, with React Aria for accessibility primitives, `react-virtuoso` and `react-window` for virtualized lists, TinyMCE for rich text, and Atlassian's pragmatic drag-and-drop. Tokens are organized as colors, spacing, borderRadius, shadows, media, mixins, arrows.

The important find is not the component count. It is that the entire product is four page archetypes, and every one of the 24-odd tools is an instance of one of them.

| Archetype | Composition | Used for |
|---|---|---|
| `ToolLandingPage` | Main, Header (Title, Tabs), Banner, Body, Aside | The landing view of every tool. Replaced the older `ListPage` as of 12.9.0. |
| `DetailPage` | Main, Header (Breadcrumbs, Banner, Title, Tabs), Body (Card, Section, nested Section), Footer (Notation, Actions) | One selected record. Fixed width variants. |
| `SettingsPage` | Same spine as DetailPage | Configuration of a tool. |
| `PageLayout` | The shared primitive all three compose from | Everything else. |

Add `Tearsheet` (the slide-over panel), `SplitViewCard`, `Table` with `TableShelf`, `ToolHeader`, and the filter vocabulary (`FilterToken`, `Pill`, `Token`, `SuperSelect`, `TieredSelect`), and you have essentially the whole visual language.

That is the real lesson for anyone building in this shape. Procore does not look coherent because they have 103 components. It looks coherent because a record list, a record, and a settings screen have exactly one layout each across 24 tools, and every team is forced to compose from those three. You can reproduce 90% of the feel with roughly fifteen components and three page templates.

Navigation is two levels, and this is the mental model users actually carry:

Company level holds Portfolio (list, thumbnail, overview and map views of every project), Directory, company Admin, permission templates, Workflows, Analytics, ERP Integrations. Project level holds Home and the tool menu. You navigate up from a project to the company with a single arrow; from the company there is nowhere further up.

As of 21 July 2026, the project landing is the Hubs-powered Project Overview, a card-based layout where users drag, resize, reorder and remove cards. Company admins can revert to legacy Project Home. Directionally: the fixed dashboard is dying, personalized card surfaces are the new default, and that is the surface AI output will get injected into.

## 4. The product surface

Project-level tools: Home, Directory, Documents, Drawings, Specifications, Photos, Emails, RFIs, Submittals, Transmittals, Meetings, Schedule, Daily Log, Punch List, Observations, Inspections, Incidents, Coordination Issues, Forms, Tasks, Timesheets, Reports, Prime Contract, Direct Costs.

Grouped commercially into Preconstruction (tendering, planroom, prequalification, specs), Project Management, Quality and Safety (checklists, inspection forms, incident reporting), Project Financials, Resource Management, and Analytics.

Two primitives hold the whole thing together.

**Ball in Court.** Every workflow item, RFI, submittal, change order, carries a single explicit answer to "who owes the next action right now." It is the backbone of the system and the reason the tools feel like one product rather than 24 CRUD apps. If you build nothing else from this teardown, build this.

**Work Breakdown Structure.** The financial spine. A budget code is composed of segments: cost code (CSI MasterFormat by default), cost type, optional sub job, plus up to ten custom segments that the company names and orders itself. Budget line items are one per budget code. Everything financial, commitments, change orders, direct costs, invoices, forecasts, tags to this structure, which is why their ERP sync to Sage 300, Sage 100, Sage Intacct and Viewpoint Vista can exist at all.

Permissions are per-tool levels of None, Read Only, Standard, Admin, assigned through permission templates at both company and project level, with task-based granular permissions layered on top (a Standard user who additionally may "create and edit users"). It is coarse-grained by default with escape hatches, and it is enforced at the tool boundary.

Workflows are a global engine with a self-serve builder: conditions, roles, groups, routing, notifications, plus quickstart templates for common finance flows. Customers configure approval chains without custom development.

## 5. The platform

REST with OAuth 2.0 is the primary surface, versioned, rate limited per `client_id` on a rolling per-minute window, returning 429 with `X-Rate-Limit-Limit`, `-Remaining` and `-Reset`. GraphQL exists mainly to collapse chatty REST calls. Webhooks fire on resource events, configured per company. Public apps are listed on the App Marketplace after partner vetting. Analytics ships as Power BI content packs (Analytics 2.0, with incremental refresh), and Cloud Connector shares data out over the Delta Sharing open protocol to Snowflake, BigQuery, Databricks, Fabric and friends.

Stack, from their own engineering writing and hiring: Ruby on Rails, Node.js, Java, React and TypeScript, PostgreSQL, AWS, Kubernetes, with GraphQL BFFs fronting the mobile apps and at least one Elixir service ("Quota Minder") doing API rate limiting. A Rails monolith being carved into services, in other words, with all the seams that implies.

Acquisition pattern worth noting because it is deliberate: they buy their own marketplace partners. Levelset (payments and lien rights, $500M), LaborChart (workforce), Esticom (estimating), INDUS.AI (computer vision), Honest Buildings (owners), Unearth (GIS), Novorender ($44.3M, BIM rendering), Intelliwave ($29.8M, materials), and Datagrid (agentic AI, closed 20 Jan 2026). The marketplace is a farm team.

## 6. Where it is weak (this is the wedge)

Price versus consumption. Mid-market GCs pay enterprise rates and use a fraction of the surface. This is the most consistent complaint across every review source.

Time to value. Three to six months for a standard rollout, and users commonly report not seeing value until month five or six. During that window your best PM is doing migration instead of running jobs.

Field adoption. Roughly 43% of construction software implementations fail on field adoption. The office loves it, the field tolerates it, and every record in the system is bought with somebody's manual data entry.

Offline is fake. Mobile caches what you already viewed. If you did not open the drawing while you had signal, you do not have the drawing. For a product whose users work in basements and on steel decks, that is a design failure, not a limitation.

Scheduling is a passenger. Primavera P6 integration is a one-way upload through Procore Drive. Edit in P6, re-upload. The schedule, which is the thing the whole project actually runs on, is not really live in the platform.

Weight. Feature bloat, slow navigation, clunky ERP configuration, reporting that fights you. The classic profile of a fifteen-year-old platform carrying every customer it ever signed.

## 7. What Procore is shipping in AI, and why it is still bolted on

They are moving fast and with real money. Procore AI now embeds Datagrid. Agents update records, generate documents, and respond to project events such as new RFIs, submittals and change orders. The packaging is three Digital Coworker tiers: Starter with five agents (Deep Search, Submittal Review, RFI, Daily Log, Contract Review), Pro with a library of 20, and Enterprise adding Agent Studio for building custom agents with natural-language instructions, custom triggers and schedules. Procore Skills lets a company teach the AI its own SOPs from plain-language prompts or uploaded standards documents.

That is a serious roadmap, and it is also the tell. Agents are a purchased tier sitting on top of a record system designed in 2012 for humans to fill in by hand. The data model was never built to be an agent's working memory, the permissions were never built to constrain a retrieval layer, and there is no reason to think a Rails monolith's tool boundaries make good agent tool boundaries.

The opening is not "add AI to a Procore clone." It is that the record is the wrong center of gravity. In Procore, a human produces a record and AI reads it afterward. Invert that.

## 8. The blueprint

### 8.1 The one architectural bet

**Capture first, records are derived, humans approve.**

Field users produce raw signal: photos, voice notes, video walks, scanned paper, emails, texts, sensor and telemetry data. Agents turn signal into proposed records (a daily log, an RFI, an observation, a change event, a timesheet). Humans approve or edit at a gate. Nobody types a form on a phone in the rain.

This attacks Procore's two deepest costs at once, the manual data entry burden and the field adoption failure, and it is only buildable if AI is in the architecture from the first migration rather than sold as a tier.

Worth saying plainly: `smartbox-x` already has the hard half of this built. The event bus over an append-only `bus_events` log with durable per-subscriber cursors, six agents that only ever write `pending` proposals, an `ApprovalProcessor` that executes approved or edited actions idempotently, a `ModelRouter` with per-tenant cost metering, an offline sync engine with field-level merge and a conflict log, and forced row-level security with a non-bypassing app role. That is a better foundation for agentic operations than the one Procore is retrofitting.

### 8.2 The record kernel

Procore hand-built two dozen tools. Do not do that. Build one kernel and instantiate tools as configuration.

Every record in the system, whatever the vertical, is the same envelope: identity and tenant scope, a typed body defined by a schema, a state machine, a ball-in-court holder, participants, attachments, a thread, an immutable audit trail, permission bindings, and a stream of events. A "tool" is then a record type plus a state machine plus a view config plus a permission template. RFIs, submittals, punch items, incidents, work orders, service tickets, restock exceptions: all the same kernel.

Two consequences. A new module is a config change, not a quarter of engineering. And every agent gets one uniform interface to the entire business instead of 24 bespoke APIs.

### 8.3 Ball in court as a first-class scheduler

Do not model it as a status field. Model it as an assignment with an owner, an expected action, a due time, and an escalation path, emitted onto the bus. Then "who is blocking what, and for how long" becomes a query rather than a report, and an agent can chase, escalate, draft the follow-up, and surface the whole portfolio's blocked set without anyone building a dashboard.

### 8.4 Permissions are the retrieval boundary

The single most dangerous thing about bolting AI onto an enterprise record system is that UI-level permissions leak the moment a retrieval layer reads the database on the user's behalf.

Rule: agents and retrieval run under a scoped identity with the same row-level security as the human they act for, or a narrower one. No service account with god access feeding a vector index. Every embedding carries its scope; every retrieval filters at the database, not in the prompt. Every agent action is attributed to an agent identity, lands as a proposal, and is auditable to the approving human.

This is where the existing `smartbox_app` role work and the `provision:app-role` refusal-to-trust check already pay for themselves.

### 8.5 The graph, not the modules

The defensible asset is not the feature list, it is the resolved entity graph: people, organizations, sites, assets, contracts, cost codes, documents, and the relationships between them, with the same real-world thing resolved across email, PDF, ERP and field capture. Agents are only as good as that grounding, which is precisely what horizontal AI tools cannot replicate and what Procore is buying companies to accelerate.

Design it as a first-class layer with entity resolution, provenance on every assertion, and confidence, not as an afterthought view over normalized tables.

### 8.6 Skills, evaluated

Match Procore Skills, then beat it on rigor. Tenant-scoped instruction corpora, versioned, retrievable, attached to agent runs. The part they are not talking about is evaluation: when an agent drafts a contractually significant record, you need golden sets, regression suites per agent, and per-tenant quality telemetry, or the first bad change order kills the account. Build the eval harness alongside the first agent, not after the tenth.

### 8.7 Financial spine

Copy the WBS idea and keep it configurable: a code composed of named segments, defaults for the vertical, up to ~10 custom segments, ordered by the customer. It is the thing that makes external accounting sync possible. Get it wrong and every financial integration is bespoke forever.

### 8.8 Offline for real

Offline-first, not cache-on-view. Predictive sync of the working set based on today's assignment and location, a durable local change queue, explicit conflict surfacing rather than silent last-write-wins, and capture that always succeeds regardless of connectivity. The `SyncQueue` plus `SyncMergeService` design already in the repo is the right shape; the gap is predictive prefetch.

### 8.9 Frontend

Tokens plus three page templates plus about fifteen components. Tool landing, record detail, settings, a slide-over panel, and one seriously good virtualized table with a filter-token vocabulary. Resist the 103-component library until you have five real tools shipping.

Then the AI-native addition Procore does not have: a persistent assistant surface that is scoped to the current record and the current user's permissions, and card-based home surfaces (their Hubs direction) where the cards are agent output, not static widgets.

### 8.10 Platform from day one

REST plus OAuth 2.0, webhooks per tenant, per-client rate limits with standard headers, and a data-out path over an open sharing protocol. Add the thing that is now table stakes and was not in 2012: an MCP server over the record kernel, so customers' own agents can work your system. Procore's marketplace is a farm team for acquisitions; yours should be a distribution channel from the start.

### 8.11 Pricing

Do not copy ACV pricing, it is a tax on your customer's success and it is the number one complaint. Unlimited humans (the multi-party network is the moat, never charge for it), priced on outcomes or agent work performed. The model router's per-tenant cost metering already in the repo is the metering substrate for this.

## 9. Build order

1. Record kernel plus ball-in-court plus the audit and event spine. One vertical slice, end to end.
2. Three page templates and the table. Two record types rendered entirely from config.
3. Capture pipeline: photo, voice, document in, proposal out, approval gate, record created.
4. Entity graph and scoped retrieval, with permissions enforced at the database.
5. First three agents against real work, with the eval harness in the same commit.
6. Financial spine and one external accounting sync.
7. Offline predictive sync in the field app.
8. Public API, webhooks, MCP server.

## 10. The uncomfortable part

Procore's moat is not the software. It is that every party on the project is already in it, funded by pricing that makes adding the eightieth user free, defended by fifteen years of construction-specific edge cases and a $300M-scale R&D budget. Cloning the look and feel buys nothing. Nobody switches systems of record because your tables are prettier.

What actually wins is being unarguably better at one job that Procore is structurally bad at, then expanding on the kernel. The capture-to-record inversion is the strongest candidate, because their weakness there (manual entry, failed field adoption, fake offline) is not a bug they can patch, it is the shape of a product designed before this was possible.

The second candidate is a vertical Procore serves badly, where the same kernel plus a different record-type config gets you a product without a decade of construction edge cases.

That choice is the one open question in this document.

---

**Build status.** Step 1 of the build order (record kernel, ball in court, audit and event spine) plus the permission model and the HTTP surface are implemented in [`plumbline/`](../plumbline/README.md). Five record types run as configuration, 62 tests cover the workflow engine, permission resolution, definition validation, the kernel against a real Postgres, and tenant isolation under a confined non-superuser role.
