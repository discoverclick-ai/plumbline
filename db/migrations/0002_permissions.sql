-- 0002 · tools and permissions
--
-- The permission model is the thing that makes a construction platform
-- multi-party: the sub sees their own commitments, the architect answers RFIs
-- and sees nothing financial, the owner watches progress and cannot touch a
-- punch item. Procore's shape (per-tool levels of None / Read Only / Standard
-- / Admin, assigned through templates, with task-based granular privileges
-- layered on top) is the right shape and this is our version of it.
--
-- Two levels, deliberately:
--   * company templates govern company-level tools (directory, projects,
--     admin) and are attached to the user.
--   * project templates govern project-level tools and are attached to the
--     project membership, so the same person can be an admin on one job and
--     read-only on the next.
--
-- One escalation rule, deliberately: a user whose COMPANY template grants
-- 'admin' on the `directory` tool is a company administrator and is treated as
-- admin everywhere. That single rule is what stops an account from locking
-- itself out, and it is enforced in one place (resolvePermissions in
-- @plumbline/shared) rather than sprinkled through route handlers.

CREATE TYPE permission_scope AS ENUM ('company', 'project');

CREATE TYPE permission_level AS ENUM ('none', 'read_only', 'standard', 'admin');

-- Global (not tenant-scoped): the catalogue of tools the product ships.
-- Adding a tool is a migration, not a customer-data change, which is what
-- keeps permission templates comparable across tenants.
CREATE TABLE tools (
    key          TEXT PRIMARY KEY,
    scope        permission_scope NOT NULL,
    display_name TEXT NOT NULL,
    sort_order   INTEGER NOT NULL DEFAULT 0
);

-- The task-based privileges that can be granted ON TOP of a 'read_only' or
-- 'standard' level. Keeping them in a table means a template cannot grant a
-- privilege that does not exist.
CREATE TABLE tool_privileges (
    tool_key    TEXT NOT NULL REFERENCES tools (key) ON DELETE CASCADE,
    privilege   TEXT NOT NULL,
    description TEXT NOT NULL,
    PRIMARY KEY (tool_key, privilege)
);

CREATE TABLE permission_templates (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    scope      permission_scope NOT NULL,
    name       TEXT NOT NULL,
    -- The template handed to a new user or membership when none is named.
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, scope, name)
);

CREATE UNIQUE INDEX permission_templates_one_default_per_scope
    ON permission_templates (tenant_id, scope)
    WHERE is_default;

-- A template row says nothing about tools it does not mention: absence is
-- 'none'. Storing only what is granted keeps templates small and makes the
-- default deny obvious at the query, not just in the code.
CREATE TABLE template_tool_permissions (
    template_id UUID NOT NULL REFERENCES permission_templates (id) ON DELETE CASCADE,
    tool_key    TEXT NOT NULL REFERENCES tools (key) ON DELETE CASCADE,
    level       permission_level NOT NULL,
    PRIMARY KEY (template_id, tool_key)
);

CREATE TABLE template_granular_permissions (
    template_id UUID NOT NULL REFERENCES permission_templates (id) ON DELETE CASCADE,
    tool_key    TEXT NOT NULL,
    privilege   TEXT NOT NULL,
    PRIMARY KEY (template_id, tool_key, privilege),
    FOREIGN KEY (tool_key, privilege) REFERENCES tool_privileges (tool_key, privilege) ON DELETE CASCADE
);

ALTER TABLE users
    ADD COLUMN company_permission_template_id UUID REFERENCES permission_templates (id) ON DELETE SET NULL;

ALTER TABLE project_memberships
    ADD CONSTRAINT project_memberships_template_fk
        FOREIGN KEY (permission_template_id) REFERENCES permission_templates (id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Tool catalogue
-- ---------------------------------------------------------------------------

INSERT INTO tools (key, scope, display_name, sort_order) VALUES
    ('directory',   'company', 'Directory',          10),
    ('projects',    'company', 'Projects',           20),
    ('admin',       'company', 'Company Admin',      30),
    ('rfis',        'project', 'RFIs',               10),
    ('submittals',  'project', 'Submittals',         20),
    ('punch_list',  'project', 'Punch List',         30),
    ('observations','project', 'Observations',       40),
    ('daily_log',   'project', 'Daily Log',          50),
    ('documents',   'project', 'Documents',          60),
    ('project_team','project', 'Project Directory',  70);

INSERT INTO tool_privileges (tool_key, privilege, description) VALUES
    ('directory',    'create_and_edit_users',  'Add people to the company directory and edit their records'),
    ('projects',     'create_projects',        'Create new projects'),
    ('rfis',         'create',                 'Create RFIs'),
    ('rfis',         'respond',                'Provide the official response to an RFI'),
    ('rfis',         'close',                  'Close an answered RFI'),
    ('submittals',   'create',                 'Create submittals'),
    ('submittals',   'review',                 'Record a review decision on a submittal'),
    ('punch_list',   'create',                 'Create punch items'),
    ('punch_list',   'verify',                 'Accept or reject completed punch work'),
    ('observations', 'create',                 'Create observations'),
    ('observations', 'close',                  'Close an observation'),
    ('daily_log',    'create',                 'Create daily log entries'),
    ('project_team', 'manage_members',         'Add and remove project team members');
