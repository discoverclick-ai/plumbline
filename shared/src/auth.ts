import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from 'node:crypto'
import { withTenant, type Db } from './db.js'
import { AuthenticationError } from './errors.js'

// promisify() picks the overload without options, so the cost parameters are
// wired up by hand rather than silently falling back to node's defaults.
function scrypt(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (err, derived) => {
      if (err) reject(err)
      else resolve(derived)
    })
  })
}

/**
 * Passwords and sessions.
 *
 * Sessions are opaque and server-side. The token the client holds is random;
 * only its SHA-256 is stored, so a leaked database does not hand over live
 * sessions. Identity is re-read from the live user row on every request, which
 * is what makes removing someone from the project take effect on their next
 * call rather than whenever a signed token happens to expire.
 */

const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_BYTES = 32
const SESSION_TTL_HOURS = 12

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scrypt(password, salt, KEY_BYTES, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${key.toString('base64')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const n = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  const salt = Buffer.from(parts[4] ?? '', 'base64')
  const expected = Buffer.from(parts[5] ?? '', 'base64')
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p) || expected.length === 0) return false

  const actual = await scrypt(password, salt, expected.length, { N: n, r, p })
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export interface SessionIdentity {
  sessionId: string
  tenantId: string
  userId: string
}

/**
 * Authenticate an email and password, and open a session.
 *
 * The lookup runs through `auth_find_user_by_email`, a narrow SECURITY DEFINER
 * function, because the tenant is not known until the user is found and RLS
 * denies everything without one. The failure message never distinguishes an
 * unknown account from a wrong password.
 */
export async function signIn(
  db: Db,
  input: { email: string; password: string },
): Promise<{ token: string; identity: SessionIdentity; expiresAt: Date }> {
  const { rows } = await db.query<{
    user_id: string
    tenant_id: string
    password_hash: string
    is_active: boolean
  }>('SELECT user_id, tenant_id, password_hash, is_active FROM auth_find_user_by_email($1)', [input.email])

  const found = rows[0]
  // Always run a verification, even with no account, so a missing user and a
  // wrong password take the same time.
  const stored = found?.password_hash ?? (await hashPassword(randomBytes(16).toString('hex')))
  const ok = await verifyPassword(input.password, stored)
  if (!found || !ok || !found.is_active) throw new AuthenticationError('Email or password is incorrect')

  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 60 * 60 * 1000)

  // The tenant is only known now, and `sessions` is fenced by RLS like every
  // other tenant-scoped table, so the insert runs inside a tenant context.
  const session = await withTenant(db, found.tenant_id, async (tx) => {
    const { rows: sessionRows } = await tx.query<{ id: string }>(
      `INSERT INTO sessions (tenant_id, user_id, token_hash, expires_at)
            VALUES ($1, $2, $3, $4)
         RETURNING id`,
      [found.tenant_id, found.user_id, hashToken(token), expiresAt],
    )
    return sessionRows[0]
  })
  if (!session) throw new Error('session insert returned no row')

  return {
    token,
    expiresAt,
    identity: { sessionId: session.id, tenantId: found.tenant_id, userId: found.user_id },
  }
}

/** Resolve a bearer token to an identity, or throw. */
export async function authenticate(db: Db, token: string): Promise<SessionIdentity> {
  const { rows } = await db.query<{
    session_id: string
    tenant_id: string
    user_id: string
    expires_at: Date
    revoked_at: Date | null
  }>('SELECT session_id, tenant_id, user_id, expires_at, revoked_at FROM auth_find_session($1)', [hashToken(token)])

  const session = rows[0]
  if (!session) throw new AuthenticationError('Session not found')
  if (session.revoked_at) throw new AuthenticationError('Session revoked')
  if (session.expires_at.getTime() <= Date.now()) throw new AuthenticationError('Session expired')

  return { sessionId: session.session_id, tenantId: session.tenant_id, userId: session.user_id }
}

export async function signOut(db: Db, identity: SessionIdentity): Promise<void> {
  await withTenant(db, identity.tenantId, async (tx) => {
    await tx.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [identity.sessionId])
  })
}
