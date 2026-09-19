-- 0033 · statutory deadlines, and why they are a different animal
--
-- A contract deadline is a term two parties agreed. A statutory deadline is
-- law. Lien rights, bond claim rights, prompt payment: the legislature sets
-- the window, it varies by state and by where you sit in the contract chain,
-- and missing one does not waive a claim you might have won. It removes the
-- security for money you have already earned and spent.
--
-- Three things make these a better problem than contract extraction.
--
-- They are PUBLIC. There is no document to read and no citation to fabricate;
-- the statute is a citation anybody can check.
--
-- They are DETERMINISTIC. Once you know the state, the party's role, and the
-- date of first or last furnishing, the deadline is arithmetic. No model is
-- involved at any point, which is why this subsystem has no provider seam.
--
-- And they are the same shape as everything else here, so the clock engine,
-- the notice record and the ball in court all apply unchanged.
--
-- The dangerous part is the DATA. A wrong statutory deadline in front of a
-- contractor is worse than no deadline at all, because they will rely on it
-- and lose money they have already earned. So the rule this schema enforces
-- is the one that matters: a rule that has not been verified by a named
-- person against the statute starts NO clocks, ever, and the product ships
-- with every rule unverified. The reference data is a starting point for a
-- customer's counsel, not an answer.

CREATE TYPE statutory_deadline_type AS ENUM (
    'preliminary_notice',
    'notice_of_intent_to_lien',
    'mechanics_lien',
    'lien_foreclosure',
    'bond_claim_notice',
    'bond_claim_suit',
    'stop_notice',
    'prompt_payment_demand'
);

-- Where in the chain the claimant sits, which changes the deadline in most
-- states and removes it entirely in some.
CREATE TYPE claimant_role AS ENUM (
    'general_contractor',
    'first_tier_subcontractor',
    'second_tier_subcontractor',
    'supplier_to_gc',
    'supplier_to_sub',
    'design_professional',
    'equipment_lessor'
);

-- What starts the clock. All facts about the job, none of them opinions.
CREATE TYPE statutory_trigger AS ENUM (
    'first_furnishing',
    'last_furnishing',
    'project_completion',
    'notice_of_completion',
    'notice_of_termination',
    'lien_recorded',
    'payment_due',
    'contract_execution'
);

CREATE TABLE statutory_rules (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Two-letter state, or a federal scheme such as 'US-MILLER' for the
    -- Miller Act on federal work. Not tenant-scoped: the law is the law, and
    -- a per-tenant copy would mean a correction has to be made a hundred
    -- times.
    jurisdiction   TEXT NOT NULL,
    project_type   TEXT NOT NULL DEFAULT 'private',
    deadline_type  statutory_deadline_type NOT NULL,
    claimant_role  claimant_role NOT NULL,
    trigger        statutory_trigger NOT NULL,
    duration_value INTEGER NOT NULL,
    duration_unit  duration_unit NOT NULL,
    -- Some states count to a fixed day of a month ("the 15th day of the third
    -- month after"), which no number of days expresses. Where this is set the
    -- engine uses it and ignores the duration.
    month_offset   INTEGER,
    day_of_month   INTEGER,

    -- The statute, as anybody would cite it. This is the whole trust model:
    -- a deadline a contractor's attorney can look up in thirty seconds is one
    -- they will act on.
    citation       TEXT NOT NULL,
    citation_url   TEXT,
    summary        TEXT NOT NULL,
    -- What happens if it is missed, in the contractor's own terms.
    consequence    TEXT NOT NULL,

    -- The gate. Unverified rules are reference material and start no clocks.
    verified_by    TEXT,
    verified_at    DATE,
    verified_note  TEXT,
    -- When the rule stopped being the law. Kept rather than deleted: a
    -- deadline computed under last year's statute has to stay explicable.
    superseded_on  DATE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (jurisdiction, project_type, deadline_type, claimant_role, trigger)
);

ALTER TABLE statutory_rules
    ADD CONSTRAINT statutory_rules_verification_is_named
        CHECK ((verified_by IS NULL) = (verified_at IS NULL)),
    ADD CONSTRAINT statutory_rules_day_of_month_sane
        CHECK (day_of_month IS NULL OR day_of_month BETWEEN 1 AND 31);

CREATE INDEX statutory_rules_live
    ON statutory_rules (jurisdiction, project_type, claimant_role)
    WHERE verified_at IS NOT NULL AND superseded_on IS NULL;

-- Readable by the application; never written by it. Corrections are a
-- migration or an operator task, because a rule edited through the product by
-- whoever was logged in is a rule nobody can vouch for.
GRANT SELECT ON statutory_rules TO plumbline_app;

-- ---------------------------------------------------------------------------
-- The facts a project has to supply
-- ---------------------------------------------------------------------------
--
-- Dates, not judgements. Every one of these is something a person looked up
-- and typed, and each is recorded with who said so, because "when did you
-- first furnish labour or materials" is a question answered under oath later.

CREATE TABLE project_statutory_facts (
    project_id        UUID PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
    tenant_id         UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    jurisdiction      TEXT NOT NULL,
    project_type      TEXT NOT NULL DEFAULT 'private',
    -- Our own company's position in the chain on THIS job, which is not a
    -- property of the company: the same contractor is a GC on one job and a
    -- second tier sub on the next.
    claimant_role     claimant_role NOT NULL,
    first_furnishing  DATE,
    last_furnishing   DATE,
    completion_date   DATE,
    notice_of_completion_recorded DATE,
    contract_executed DATE,
    updated_by        UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE project_statutory_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_statutory_facts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON project_statutory_facts
    USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON project_statutory_facts TO plumbline_app;

-- ---------------------------------------------------------------------------
-- The clocks themselves
-- ---------------------------------------------------------------------------
--
-- A separate table from obligation_clocks rather than a nullable column on
-- it. The two look alike and are not: a contract clock cites a clause in a
-- document this tenant uploaded, a statutory clock cites a statute nobody
-- uploaded, and jamming both through one foreign key would make every query
-- in either subsystem check which kind it was holding.

CREATE TABLE statutory_clocks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    project_id      UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    rule_id         UUID NOT NULL REFERENCES statutory_rules (id) ON DELETE RESTRICT,
    triggered_by    statutory_trigger NOT NULL,
    started_on      DATE NOT NULL,
    due_on          DATE NOT NULL,
    warn_on         DATE NOT NULL,
    state           clock_state NOT NULL DEFAULT 'watching',
    notice_record_id UUID REFERENCES records (id) ON DELETE SET NULL,
    satisfied_at    TIMESTAMPTZ,
    dismissed_reason TEXT,
    dismissed_by    UUID REFERENCES users (id) ON DELETE SET NULL,
    -- The arithmetic and the citation, frozen. A correction to the rule next
    -- year must not silently change a deadline somebody already acted on.
    computation     JSONB NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, rule_id, started_on)
);

CREATE INDEX statutory_clocks_live
    ON statutory_clocks (tenant_id, project_id, due_on)
    WHERE state IN ('watching', 'in_court');

ALTER TABLE statutory_clocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE statutory_clocks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON statutory_clocks
    USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON statutory_clocks TO plumbline_app;

INSERT INTO tool_privileges (tool_key, privilege, description) VALUES
    ('contracts', 'manage_statutory', 'Record the dates that start statutory deadlines');

-- ---------------------------------------------------------------------------
-- Reference data
-- ---------------------------------------------------------------------------
--
-- Every row below is UNVERIFIED and starts no clocks. That is not caution
-- theatre: statutes are amended, they differ for public and private work, and
-- several states change the answer depending on whether a notice of
-- completion was recorded. A row here is a prompt for a customer's counsel to
-- confirm or correct, and the product will not act on one until a named
-- person has done so and said when.
--
-- The summaries below deliberately describe the SHAPE of each deadline rather
-- than asserting a number as settled law.

INSERT INTO statutory_rules
    (jurisdiction, project_type, deadline_type, claimant_role, trigger, duration_value, duration_unit,
     citation, summary, consequence)
VALUES
    ('US-MILLER', 'federal', 'bond_claim_notice', 'first_tier_subcontractor', 'last_furnishing', 90, 'days',
     '40 U.S.C. § 3133(b)(2)',
     'On a federal project a claimant without a direct contract with the prime must give written notice to the prime contractor within the statutory window measured from the last day labour or materials were supplied.',
     'Loss of the right to sue on the payment bond, which on federal work is the only security there is: there are no mechanics lien rights against federal property.'),

    -- Expressed in months rather than years, because `duration_unit` has no
    -- 'years' and adding one would change a type the contract engine shares
    -- for the sake of a unit that months already express exactly.
    ('US-MILLER', 'federal', 'bond_claim_suit', 'first_tier_subcontractor', 'last_furnishing', 12, 'months',
     '40 U.S.C. § 3133(b)(4)',
     'Suit on a Miller Act payment bond must be brought within the statutory period after the claimant last supplied labour or materials.',
     'The bond claim is time-barred regardless of merit.');

-- Intentionally two rows, and intentionally federal. Seeding fifty states of
-- lien law from memory would be the single most dangerous thing this
-- repository could contain: fifty confident numbers, each one relied upon,
-- none checked. The mechanism is the deliverable here. The dataset is a
-- procurement decision, and the schema is built so that buying a verified one
-- is an INSERT.
