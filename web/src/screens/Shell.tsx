import { useEffect, useState } from 'react'
import type { ProjectView } from '../api/client.js'
import { ToolLandingPage } from '../layouts/index.js'
import { atLeast, useSession } from '../session/SessionProvider.tsx'
import { Banner, Button, Card, Field, Input, Pill, Spinner, Table, Tabs } from '../ui/index.js'
import { BallInCourt } from './BallInCourt.tsx'
import { Budget } from './Budget.tsx'
import { Contracts } from './Contracts.tsx'
import { Lookahead } from './Lookahead.tsx'
import { Chasing } from './Chasing.tsx'
import { Drawings } from './Drawings.tsx'
import { Photos } from './Photos.tsx'
import { SubmittalRegister } from './SubmittalRegister.tsx'
import { SyncConflicts } from './SyncConflicts.tsx'
import { CaptureInbox } from './CaptureInbox.tsx'
import { RecordDetail } from './RecordDetail.tsx'
import { ToolLanding } from './ToolLanding.tsx'

/**
 * Sign-in, the portfolio, and the project shell.
 *
 * Navigation is two levels, which is the mental model the industry already
 * has: a company level that lists projects, and a project level with the tools
 * on it. There is nowhere above the company and nothing below a record.
 */

export function SignIn() {
  const { signIn } = useSession()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      await signIn(email, password)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign you in')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', padding: 'var(--space-5)' }}>
      <div style={{ width: 'min(380px, 100%)', display: 'grid', gap: 'var(--space-4)' }}>
        <h1 style={{ margin: 0, fontSize: 24 }}>Plumbline</h1>
        <Card>
          <form
            style={{ display: 'grid', gap: 'var(--space-4)' }}
            onSubmit={(event) => {
              event.preventDefault()
              void submit()
            }}
          >
            {error && <Banner tone="danger">{error}</Banner>}
            <Field label="Email">
              <Input value={email} onChange={setEmail} type="email" name="email" />
            </Field>
            <Field label="Password">
              <Input value={password} onChange={setPassword} type="password" name="password" />
            </Field>
            <Button type="submit" variant="primary" busy={busy}>
              Sign in
            </Button>
          </form>
        </Card>
      </div>
    </div>
  )
}

export function Portfolio({ onOpenProject }: { onOpenProject: (project: ProjectView) => void }) {
  const { api, me, signOut } = useSession()
  const [projects, setProjects] = useState<ProjectView[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .projects()
      .then((result) => setProjects(result.projects))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load projects'))
      .finally(() => setLoading(false))
  }, [api])

  return (
    <ToolLandingPage
      title="Projects"
      subtitle={me?.user ? `${me.user.organization}` : undefined}
      actions={<Button onClick={() => void signOut()}>Sign out</Button>}
      banner={error && <Banner tone="danger">{error}</Banner>}
    >
      <Card>
        {loading ? (
          <Spinner />
        ) : (
          <Table
            rows={projects}
            rowKey={(row) => row.id}
            onRowClick={onOpenProject}
            empty={
              <p style={{ margin: 0, color: 'var(--ink-muted)' }}>
                You are not on any projects yet. Someone with directory access can add you.
              </p>
            }
            columns={[
              { key: 'number', header: 'Number', width: '120px', render: (row) => <strong>{row.number}</strong> },
              { key: 'name', header: 'Project', render: (row) => row.name },
              {
                key: 'stage',
                header: 'Stage',
                width: '200px',
                render: (row) => <Pill>{row.stage.replace(/_/g, ' ')}</Pill>,
              },
              {
                key: 'value',
                header: 'Contract',
                width: '140px',
                render: (row) =>
                  row.contract_value
                    ? `$${Number(row.contract_value).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                    : '—',
              },
            ]}
          />
        )}
      </Card>
    </ToolLandingPage>
  )
}

type ProjectTab =
    | 'work'
    | 'records'
    | 'drawings'
    | 'specs'
    | 'lookahead'
    | 'photos'
    | 'budget'
    | 'contracts'
    | 'chasing'
    | 'field'
    | 'inbox'

export function ProjectShell({ project, onLeave }: { project: ProjectView; onLeave: () => void }) {
  const { scopeToProject, loading, level } = useSession()
  const [tab, setTab] = useState<ProjectTab>('work')
  const [openRecordId, setOpenRecordId] = useState<string | null>(null)

  useEffect(() => {
    void scopeToProject(project.id)
    // Re-scoping on project change only; the session decides what the UI may
    // offer for THIS project, and the server re-checks all of it anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id])

  if (loading) return <Spinner label="Loading project" />

  const tabs: { key: ProjectTab; label: string }[] = [
    { key: 'work', label: 'In your court' },
    { key: 'records', label: 'Records' },
  ]
  // Most people on a job hold `none` here, and a tab that opens onto a
  // permission error is worse than no tab.
  if (atLeast(level('drawings'), 'read_only')) tabs.push({ key: 'drawings', label: 'Drawings' })
  if (atLeast(level('specifications'), 'read_only')) tabs.push({ key: 'specs', label: 'Submittal register' })
  if (atLeast(level('schedule'), 'read_only')) tabs.push({ key: 'lookahead', label: 'Lookahead' })
  if (atLeast(level('photos'), 'read_only')) tabs.push({ key: 'photos', label: 'Photos' })
  if (atLeast(level('budget'), 'read_only')) tabs.push({ key: 'budget', label: 'Budget' })
  // Either half earns the tab. A superintendent holds `notices` and not
  // `contracts`: they need to see a deadline is running without being handed
  // the prime's indemnity language, and the screen shows each half only to
  // whoever the server will serve it to.
  if (atLeast(level('contracts'), 'read_only') || atLeast(level('notices'), 'read_only'))
    tabs.push({ key: 'contracts', label: 'Contracts' })
  // The chase queue is the project team's, not the trade partners'. Somebody
  // being chased does not need a screen listing the chases about them.
  if (atLeast(level('project_team'), 'read_only') && atLeast(level('rfis'), 'standard')) {
    tabs.push({ key: 'chasing', label: 'Chasing' })
  }
  if (atLeast(level('capture'), 'read_only')) tabs.push({ key: 'inbox', label: 'Capture inbox' })
  // Same audience as chasing: this is the office's screen, about what the
  // field typed and the server could not keep.
  if (atLeast(level('project_team'), 'read_only') && atLeast(level('rfis'), 'standard')) {
    tabs.push({ key: 'field', label: 'From the field' })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      <nav
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-4)',
          padding: '0 var(--space-4)',
          borderBottom: '1px solid var(--line)',
          background: 'var(--surface)',
          // At 390px the tabs do not fit. Scrolling sideways is honest; the
          // alternative is a project number wrapped over two lines and a tab
          // sliced in half at the edge.
          overflowX: 'auto',
          whiteSpace: 'nowrap',
        }}
      >
        <span style={{ flexShrink: 0 }}>
          <Button variant="ghost" onClick={onLeave}>
            ← {project.number}
          </Button>
        </span>
        <Tabs
          active={openRecordId ? '' : tab}
          onSelect={(key) => {
            setOpenRecordId(null)
            setTab(key as ProjectTab)
          }}
          tabs={tabs}
        />
      </nav>

      {/*
        A record opens underneath the project nav rather than replacing it.
        Taking the tabs away leaves the Back button as the only way out, which
        is how people end up using the browser's back button on a single-page
        app and losing their place.
      */}
      {openRecordId ? (
        <RecordDetail recordId={openRecordId} onBack={() => setOpenRecordId(null)} />
      ) : (
        <>
          {tab === 'work' && <BallInCourt projectId={project.id} onOpenRecord={setOpenRecordId} />}
          {tab === 'records' && (
            <ToolLanding projectId={project.id} projectName={project.name} onOpenRecord={setOpenRecordId} />
          )}
          {tab === 'drawings' && <Drawings projectId={project.id} projectName={project.name} />}
          {tab === 'specs' && <SubmittalRegister projectId={project.id} projectName={project.name} />}
          {tab === 'lookahead' && <Lookahead projectId={project.id} projectName={project.name} />}
          {tab === 'photos' && <Photos projectId={project.id} projectName={project.name} />}
          {tab === 'chasing' && <Chasing projectId={project.id} projectName={project.name} />}
          {tab === 'field' && <SyncConflicts projectId={project.id} projectName={project.name} />}
          {tab === 'budget' && <Budget projectId={project.id} projectName={project.name} />}
          {tab === 'contracts' && <Contracts projectId={project.id} projectName={project.name} />}
          {tab === 'inbox' && <CaptureInbox projectId={project.id} projectName={project.name} />}
        </>
      )}
    </div>
  )
}
