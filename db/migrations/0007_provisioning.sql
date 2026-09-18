-- 0007 · tenant provisioning
--
-- Creating a tenant is the one write that cannot happen inside a tenant
-- context, because the context is the row being created. Rather than grant the
-- application role a blanket exemption on `tenants` (which would also let it
-- read every other tenant's row), provisioning goes through one narrow
-- SECURITY DEFINER function that inserts exactly one row and returns its id.
-- Everything the new account needs after that — its own organization, its
-- first administrator, its permission templates — is written normally, inside
-- the tenant context the returned id establishes.

CREATE FUNCTION provision_tenant(p_name TEXT)
    RETURNS UUID
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public
AS $$
DECLARE
    new_id UUID;
BEGIN
    IF p_name IS NULL OR btrim(p_name) = '' THEN
        RAISE EXCEPTION 'tenant name is required';
    END IF;
    INSERT INTO tenants (name) VALUES (btrim(p_name)) RETURNING id INTO new_id;
    RETURN new_id;
END
$$;

COMMENT ON FUNCTION provision_tenant(TEXT) IS
    'Creates a tenant row and returns its id. The only write in the system that runs outside a tenant context, and it can do nothing else.';

GRANT EXECUTE ON FUNCTION provision_tenant(TEXT) TO plumbline_app;
