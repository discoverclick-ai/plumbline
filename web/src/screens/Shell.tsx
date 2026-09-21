import { useEffect, useState } from 'react'
import type { ProjectView } from '../api/client.js'
import { Directory } from './Directory.tsx'
import { AppShell } from '../layouts/AppShell.tsx'
import { Portfolio as PortfolioBoard } from './Portfolio.tsx'
import { atLeast, useSession } from '../session/SessionProvider.tsx'
import { Banner, Button, Card, Field, Input, Pill, Spinner, Table, Tabs } from '../ui/index.js'
import { BallInCourt } from './BallInCourt.tsx'
import { Budget } from './Budget.tsx'
import { Contracts } from './Contracts.tsx'
import { Lookahead } from './Lookahead.tsx'
import { Chasing } from './Chasing.tsx'
import { Drawings } from './Drawings.tsx'
import { Photos } from './Photos.tsx'
import { ProjectTeam } from './ProjectTeam.tsx'
import { SearchBox } from './Search.tsx'
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

/**
 * The company level: the portfolio, the directory, and whatever else belongs
 * above a single job.
 *
 * A rail rather than a row of buttons in the header, for the same reason the
 * project level has one: it is where somebody looks for "the other thing this
 * product does", and it has room to grow without the header wrapping.
 */
export function Portfolio({ onOpenProject }: { onOpenProject: (project: ProjectView) => void }) {
  const { api, me, signOut } = useSession()
  const [view, setView] = useState<'projects' | 'directory' | 'new'>('projects')
  const [error, setError] = useState<string | null>(null)
  const [number, setNumber] = useState('')
  const [name, setName] = useState('')
  const [reloadToken, setReloadToken] = useState(0)

  const items = [
    { key: 'projects', label: 'Projects' },
    { key: 'directory', label: 'Directory' },
    { key: 'new', label: 'Start a project' },
  ]

  return (
    <AppShell
      brand={<strong style={{ fontSize: 15 }}>Plumbline</strong>}
      context={<span style={{ color: 'var(--ink-muted)' }}>{me?.user?.organization ?? ''}</span>}
      headerRight={
        <>
          {me?.user ? (
            <span style={{ fontSize: 13, color: 'var(--ink-muted)' }}>{me.user.name}</span>
          ) : null}
          <Button variant="ghost" onClick={() => void signOut()}>
            Sign out
          </Button>
        </>
      }
      items={items}
      active={view}
      onSelect={(key) => setView(key as 'projects' | 'directory' | 'new')}
    >
      <div style={{ padding: 'var(--space-5)', overflowY: 'auto', flex: 1, display: 'grid', gap: 'var(--space-4)', alignContent: 'start' }}>
        {error ? <Banner tone="danger">{error}</Banner> : null}

        {view === 'directory' ? <Directory /> : null}

        {view === 'new' ? (
          <Card title="Start a project">
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--ink-muted)' }}>
                Number
                <Input value={number} onChange={setNumber} placeholder="26-101" />
              </label>
              <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--ink-muted)' }}>
                Name
                <Input value={name} onChange={setName} placeholder="Riverside Depot" />
              </label>
              <Button
                variant="primary"
                disabled={number.trim() === '' || name.trim() === ''}
                onClick={() => {
                  api
                    .startProject({ number: number.trim(), name: name.trim() })
                    .then(() => {
                      setNumber('')
                      setName('')
                      setReloadToken((n) => n + 1)
                      setView('projects')
                    })
                    .catch((err: unknown) =>
                      setError(err instanceof Error ? err.message : 'That project could not be started'),
                    )
                }}
              >
                Start it
              </Button>
            </div>
          </Card>
        ) : null}

        {view === 'projects' ? (
          <PortfolioBoard
            key={reloadToken}
            onOpenProject={(p) => onOpenProject(p as ProjectView)}
          />
        ) : null}
      </div>
    </AppShell>
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
    | 'team'
    | 'inbox'

export function ProjectShell({ project, onLeave }: { project: ProjectView; onLeave: () => void }) {
  const { api, scopeToProject, loading, level, me, signOut } = useSession()
  const [tab, setTab] = useState<ProjectTab>('work')
  const [openRecordId, setOpenRecordId] = useState<string | null>(null)
  // Counts on the rail. A badge beside "In your court" is the single most
  // useful pixel on this screen, and a tab strip had nowhere to put one.
  const [counts, setCounts] = useState<{ mine: number; overdue: number; inbox: number }>({
    mine: 0,
    overdue: 0,
    inbox: 0,
  })

  useEffect(() => {
    void scopeToProject(project.id)
    // Re-scoping on project change only; the session decides what the UI may
    // offer for THIS project, and the server re-checks all of it anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id])

  useEffect(() => {
    let cancelled = false
    // Both are permissioned and both may refuse, which is not an error here:
    // a rail with no badge is correct for somebody who may not see the thing
    // the badge would count.
    void Promise.all([
      api.ballInCourt({ projectId: project.id }).catch(() => ({ entries: [] })),
      api.proposals(project.id).catch(() => ({ proposals: [] })),
    ]).then(([court, inbox]) => {
      if (cancelled) return
      const entries = court.entries ?? []
      setCounts({
        mine: entries.filter((e) => e.holderUserId === me?.user?.id).length,
        overdue: entries.filter((e) => e.overdue).length,
        inbox: (inbox.proposals ?? []).length,
      })
    })
    return () => {
      cancelled = true
    }
  }, [api, project.id, me?.user?.id, openRecordId])

  if (loading) return <Spinner label="Loading project" />

  const tabs: { key: ProjectTab; label: string; badge?: number; urgent?: boolean }[] = [
    {
      key: 'work',
      label: 'In your court',
      badge: counts.mine || undefined,
      urgent: counts.overdue > 0,
    },
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
  if (atLeast(level('capture'), 'read_only')) {
    tabs.push({ key: 'inbox', label: 'Capture inbox', badge: counts.inbox || undefined })
  }
  if (atLeast(level('project_team'), 'read_only')) tabs.push({ key: 'team', label: 'Team' })
  // Same audience as chasing: this is the office's screen, about what the
  // field typed and the server could not keep.
  if (atLeast(level('project_team'), 'read_only') && atLeast(level('rfis'), 'standard')) {
    tabs.push({ key: 'field', label: 'From the field' })
  }

  return (
    <AppShell
      brand={
        <button
          type="button"
          onClick={onLeave}
          style={{
            appearance: 'none',
            border: 'none',
            background: 'transparent',
            font: 'inherit',
            fontWeight: 650,
            fontSize: 15,
            cursor: 'pointer',
            padding: 0,
            color: 'var(--ink)',
          }}
        >
          Plumbline
        </button>
      }
      context={
        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'baseline' }}>
          <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{project.number}</strong>
          <span style={{ color: 'var(--ink-muted)' }}>{project.name}</span>
        </span>
      }
      headerRight={
        <>
          {/*
            In the header rather than on a screen of its own, because searching
            is something people do in the middle of doing something else. It
            looks across every job they are on, not just this one.
          */}
          <div style={{ display: 'flex', minWidth: 220 }}>
            <SearchBox onOpenRecord={(recordId) => setOpenRecordId(recordId)} />
          </div>
          <Button variant="ghost" onClick={onLeave}>
            All projects
          </Button>
          <Button variant="ghost" onClick={() => void signOut()}>
            Sign out
          </Button>
        </>
      }
      items={tabs}
      active={openRecordId ? '' : tab}
      onSelect={(key) => {
        setOpenRecordId(null)
        setTab(key as ProjectTab)
      }}
    >
      {/*
        A record opens inside the frame rather than replacing it. Taking the
        rail away leaves the Back button as the only way out, which is how
        people end up using the browser's back button on a single-page app and
        losing their place.
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
          {tab === 'team' && <ProjectTeam projectId={project.id} projectName={project.name} />}
          {tab === 'budget' && <Budget projectId={project.id} projectName={project.name} />}
          {tab === 'contracts' && <Contracts projectId={project.id} projectName={project.name} />}
          {tab === 'inbox' && <CaptureInbox projectId={project.id} projectName={project.name} />}
        </>
      )}
    </AppShell>
  )
}
