import { useState } from 'react'
import type { ProjectView } from './api/client.js'
import { SessionProvider, useSession } from './session/SessionProvider.tsx'
import { Portfolio, ProjectShell, SignIn } from './screens/Shell.tsx'
import { Spinner } from './ui/index.js'

/**
 * The whole app is three states: signed out, the portfolio, or inside a
 * project. No router dependency — the navigation really is this shallow, and a
 * URL scheme can be layered on later without touching any screen.
 */
function Routes() {
  const { token, me, loading } = useSession()
  const [project, setProject] = useState<ProjectView | null>(null)

  if (!token) return <SignIn />
  if (loading && !me) return <Spinner label="Signing you in" />
  if (project) return <ProjectShell project={project} onLeave={() => setProject(null)} />
  return <Portfolio onOpenProject={setProject} />
}

export function App({ baseUrl, initialToken }: { baseUrl: string; initialToken?: string | null }) {
  return (
    <SessionProvider baseUrl={baseUrl} initialToken={initialToken ?? null}>
      <Routes />
    </SessionProvider>
  )
}
