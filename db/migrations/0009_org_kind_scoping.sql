-- 0009 · organization kind as a first-class dimension
--
-- Reading Procore's certification catalogue made two gaps obvious.
--
-- First, their curriculum is cut by role AND by company type: "Project
-- Manager" exists three times over, for an owner, a general contractor and a
-- specialty contractor, because the same job title does a different job
-- depending which side of the contract you sit on. Our permission templates
-- were cut by role alone, which meant one "Project Manager" template had to
-- be wrong for two thirds of the people who would be handed it.
--
-- Second, the specialty contractor curriculum is the only one that teaches
-- T&M Tickets, because subs bill time and materials and general contractors
-- do not. So a record type is not merely permissioned per user, some record
-- types only exist for one kind of company at all.
--
-- Both are modelled the same way: an array of organization kinds, where EMPTY
-- MEANS EVERY KIND. Empty rather than null, so the containment checks below
-- never have to reason about three-valued logic.

-- ---------------------------------------------------------------------------
-- Templates that know who they are for
-- ---------------------------------------------------------------------------

ALTER TABLE permission_templates
    ADD COLUMN applies_to_org_kinds organization_kind[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN permission_templates.applies_to_org_kinds IS
    'Organization kinds this template is written for. Empty means every kind.';

-- A name is now unique per (scope, audience) rather than per scope, which is
-- what lets "Project Manager" exist once for a GC and once for an owner
-- without either being renamed into something nobody says out loud.
ALTER TABLE permission_templates DROP CONSTRAINT permission_templates_tenant_id_scope_name_key;

CREATE UNIQUE INDEX permission_templates_unique_name
    ON permission_templates (tenant_id, scope, name, applies_to_org_kinds);

-- One default per audience, plus one universal default as the fallback.
DROP INDEX permission_templates_one_default_per_scope;

CREATE UNIQUE INDEX permission_templates_one_default_per_audience
    ON permission_templates (tenant_id, scope, applies_to_org_kinds)
    WHERE is_default;

-- ---------------------------------------------------------------------------
-- Record types that only some companies may raise
-- ---------------------------------------------------------------------------

-- Deliberately about CREATION, not visibility. A general contractor must be
-- able to read, review and dispute a T&M ticket; they just cannot raise one,
-- because raising one is a claim about your own labour. Visibility stays where
-- it already lives, in the permission model.
ALTER TABLE record_types
    ADD COLUMN creatable_by_org_kinds organization_kind[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN record_types.creatable_by_org_kinds IS
    'Organization kinds whose users may create this type. Empty means every kind.';
