import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ApiClient, type MeView, type RecordTypeView } from '../api/client.js'

/**
 * Who is signed in, what they may do, and what tools exist.
 *
 * Two things are loaded once and shared by every screen: the record type
 * registry and the permission map for the project in scope. The registry is
 * what makes the UI config-driven; the permission map is what stops it
 * offering buttons the server would refuse. Neither is ever treated as
 * authority — the server checks everything again — but rendering a button that
 * always fails is its own kind of broken.
 */

export interface SessionValue {
  api: ApiClient
  token: string | null
  me: MeView | null
  types: Map<string, RecordTypeView>
  /** Which project the permission map currently describes, if any. */
  scopedProjectId: string | null
  /** Reloads `me` for a project, which changes what the UI offers. */
  scopeToProject: (projectId: string | null) => Promise<void>
  signIn: (email: string, password: string) => Promise<void>
  signOut: () => Promise<void>
  /** Level and privileges for one tool, defaulting to no access. */
  can: (toolKey: string, privilege?: string) => boolean
  level: (toolKey: string) => string
  loading: boolean
  error: string | null
}

const SessionContext = createContext<SessionValue | null>(null)

const LEVELS = ['none', 'read_only', 'standard', 'admin']

export function SessionProvider({
  baseUrl,
  children,
  initialToken = null,
}: {
  baseUrl: string
  children: ReactNode
  /** Tests hand in a token minted by the API rather than typing a password. */
  initialToken?: string | null
}) {
  const api = useMemo(() => new ApiClient(baseUrl, initialToken), [baseUrl, initialToken])
  const [token, setToken] = useState<string | null>(initialToken)
  const [me, setMe] = useState<MeView | null>(null)
  const [types, setTypes] = useState<Map<string, RecordTypeView>>(new Map())
  const [loading, setLoading] = useState<boolean>(initialToken !== null)
  const [error, setError] = useState<string | null>(null)
  const [scopedProjectId, setScopedProjectId] = useState<string | null>(null)

  // Two loads can be in flight at once — the initial unscoped one on sign-in
  // and a project scope requested by the first screen that mounts. Without a
  // sequence guard the slower response wins, and if that is the unscoped one
  // the permission map silently describes no project: every project tool reads
  // 'none', the screen renders an empty shell, and it looks like a permissions
  // bug rather than a race.
  const requestSeq = useRef(0)

  const load = useCallback(
    async (projectId: string | null) => {
      const seq = ++requestSeq.current
      setLoading(true)
      setError(null)
      try {
        const [profile, registry] = await Promise.all([
          api.me(projectId ?? undefined),
          types.size > 0 ? Promise.resolve({ types: [...types.values()] }) : api.recordTypes(),
        ])
        if (seq !== requestSeq.current) return
        setMe(profile)
        setScopedProjectId(projectId)
        setTypes(new Map(registry.types.map((type) => [type.key, type])))
      } catch (err) {
        if (seq !== requestSeq.current) return
        setError(err instanceof Error ? err.message : 'Could not load your session')
      } finally {
        if (seq === requestSeq.current) setLoading(false)
      }
    },
    [api, types],
  )

  // React runs a child's effects before its parent's, so a project screen
  // mounted underneath this provider asks to be scoped BEFORE this effect
  // fires. Without this flag the unscoped load would always land second and
  // quietly undo the scope, leaving every project tool reading 'none'.
  const scopeRequested = useRef(false)

  useEffect(() => {
    if (token && !scopeRequested.current) void load(null)
    // Deliberately only on token change: re-scoping is explicit, via
    // scopeToProject, so a project screen controls when permissions change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  const value: SessionValue = {
    api,
    token,
    me,
    types,
    loading,
    error,
    scopedProjectId,
    scopeToProject: (projectId) => {
      scopeRequested.current = projectId !== null
      return load(projectId)
    },
    signIn: async (email, password) => {
      setError(null)
      const result = await api.signIn(email, password)
      api.setToken(result.token)
      setToken(result.token)
    },
    signOut: async () => {
      try {
        await api.signOut()
      } finally {
        api.setToken(null)
        setToken(null)
        setMe(null)
      }
    },
    level: (toolKey) => me?.tools[toolKey]?.level ?? 'none',
    can: (toolKey, privilege) => {
      const tool = me?.tools[toolKey]
      if (!tool) return false
      if (!privilege) return LEVELS.indexOf(tool.level) >= LEVELS.indexOf('standard')
      if (tool.privileges === '*') return true
      return tool.privileges.includes(privilege)
    },
  }

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext)
  if (!value) throw new Error('useSession must be used inside a SessionProvider')
  return value
}

/**
 * Scope the session to a project and report when the permission map describes
 * it.
 *
 * Project tools are 'none' until the session has been scoped, so a screen that
 * renders before that shows an empty shell and looks broken. Every
 * project-level screen calls this rather than relying on whoever mounted it to
 * have scoped first — it makes each screen usable on its own, which is also
 * what lets them be tested one at a time.
 */
export function useProjectScope(projectId: string): boolean {
  const { scopedProjectId, scopeToProject, token } = useSession()
  const requested = useRef<string | null>(null)

  useEffect(() => {
    if (!token) return
    if (scopedProjectId === projectId) return
    if (requested.current === projectId) return
    requested.current = projectId
    void scopeToProject(projectId)
  }, [projectId, scopedProjectId, scopeToProject, token])

  return scopedProjectId === projectId
}

/** True when `level` meets or exceeds `required`. */
export function atLeast(level: string, required: string): boolean {
  return LEVELS.indexOf(level) >= LEVELS.indexOf(required)
}
