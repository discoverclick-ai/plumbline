-- 0005 · authentication
--
-- Opaque server-side sessions, not JWTs. The reason is operational: on a
-- construction project people are removed from the team mid-day, and a signed
-- token that stays valid until it expires is a person who still has your
-- drawings. Here, role and active status are re-read from the live user row on
-- every request, so revocation takes effect on the next call.
--
-- Two lookups necessarily happen BEFORE a tenant is known — email to account
-- at sign-in, and token to session on every request — and row-level security
-- (migration 0006) denies everything when no tenant is set. They are handled
-- by two narrow SECURITY DEFINER functions rather than by punching a hole in
-- the policies. Each returns only what the caller needs to establish identity.

CREATE TABLE user_credentials (
    user_id       UUID PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    tenant_id     UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    -- scrypt, stored as "scrypt$N$r$p$<salt-b64>$<hash-b64>".
    password_hash TEXT NOT NULL,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    user_id      UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- Only the hash is stored: a leaked database does not hand over live
    -- sessions.
    token_hash   TEXT NOT NULL UNIQUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ NOT NULL,
    revoked_at   TIMESTAMPTZ
);

CREATE INDEX sessions_by_user ON sessions (tenant_id, user_id);

CREATE FUNCTION auth_find_user_by_email(p_email TEXT)
    RETURNS TABLE (user_id UUID, tenant_id UUID, password_hash TEXT, is_active BOOLEAN)
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = public
AS $$
    SELECT u.id, u.tenant_id, c.password_hash, u.is_active
    FROM users u
    JOIN user_credentials c ON c.user_id = u.id
    WHERE lower(u.email) = lower(p_email)
$$;

COMMENT ON FUNCTION auth_find_user_by_email(TEXT) IS
    'Sign-in lookup, which must run before a tenant context exists. Deliberately narrow: identity and hash only.';

CREATE FUNCTION auth_find_session(p_token_hash TEXT)
    RETURNS TABLE (session_id UUID, tenant_id UUID, user_id UUID, expires_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ)
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = public
AS $$
    SELECT s.id, s.tenant_id, s.user_id, s.expires_at, s.revoked_at
    FROM sessions s
    WHERE s.token_hash = p_token_hash
$$;

COMMENT ON FUNCTION auth_find_session(TEXT) IS
    'Per-request session lookup, which must run before a tenant context exists. Returns no user or session state beyond what identifies the caller.';
