-- 0006 · row-level security
--
-- Tenant isolation enforced by the database, not by application care. A query
-- that forgets `WHERE tenant_id = …` must still be unable to read another
-- tenant's rows.
--
-- This matters more here than in an ordinary SaaS app, because this platform
-- is built to be read by agents. A retrieval layer that queries on a user's
-- behalf through a service account with unrestricted access is a data breach
-- waiting for its first prompt injection. Everything an agent can read, it
-- reads under the same policies as the human it is acting for.
--
-- WHO RLS ACTUALLY APPLIES TO
--   * Superusers ALWAYS bypass RLS. It cannot be turned off for them.
--   * A table's owner bypasses it too unless FORCE ROW LEVEL SECURITY is set,
--     which is why every table below gets FORCE.
-- Managed Postgres platforms routinely hand you an owner role carrying
-- BYPASSRLS. Connect as that role and every policy here is skipped silently:
-- no errors, nothing looks wrong, and reads simply return other tenants' rows.
-- Run migrations as the owner; run the application as `plumbline_app`.

CREATE FUNCTION app_current_tenant() RETURNS UUID
    LANGUAGE sql
    STABLE
    PARALLEL SAFE
AS $$
    SELECT NULLIF(current_setting('app.current_tenant', true), '')::uuid
$$;

COMMENT ON FUNCTION app_current_tenant() IS
    'Current tenant from the app.current_tenant GUC. NULL when unset, and `tenant_id = NULL` is never true, so an unscoped session sees nothing. Fails closed.';

-- Roles are cluster-wide, so guard against re-creation when several databases
-- in one cluster run these migrations.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plumbline_app') THEN
        CREATE ROLE plumbline_app NOLOGIN;
    END IF;
END
$$;

DO $$
DECLARE
    t TEXT;
    tenant_scoped TEXT[] := ARRAY[
        'organizations',
        'users',
        'projects',
        'project_memberships',
        'permission_templates',
        'records',
        'record_number_sequences',
        'record_participants',
        'record_assignments',
        'record_state_history',
        'record_comments',
        'record_attachments',
        'record_events',
        'audit_log',
        'user_credentials',
        'sessions'
    ];
BEGIN
    FOREACH t IN ARRAY tenant_scoped LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())',
            t
        );
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO plumbline_app', t);
    END LOOP;
END
$$;

-- The tenants row itself: a tenant may read and update only its own record.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants
    USING (id = app_current_tenant())
    WITH CHECK (id = app_current_tenant());
GRANT SELECT, UPDATE ON tenants TO plumbline_app;

-- Global catalogues: readable by everyone, writable only by migrations.
GRANT SELECT ON tools, tool_privileges, record_types TO plumbline_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO plumbline_app;

-- The two template child tables carry no tenant_id of their own. Rather than
-- denormalize one onto them, or trust the repository layer to always join,
-- their policies reach through to the parent template. Bare `SELECT * FROM
-- template_tool_permissions` therefore returns this tenant's rows and nothing
-- else, which is what the RLS integration test asserts.
DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['template_tool_permissions', 'template_granular_permissions'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format($p$
            CREATE POLICY tenant_isolation ON %I
                USING (EXISTS (
                    SELECT 1 FROM permission_templates pt
                    WHERE pt.id = template_id AND pt.tenant_id = app_current_tenant()
                ))
                WITH CHECK (EXISTS (
                    SELECT 1 FROM permission_templates pt
                    WHERE pt.id = template_id AND pt.tenant_id = app_current_tenant()
                ))
        $p$, t);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO plumbline_app', t);
    END LOOP;
END
$$;
