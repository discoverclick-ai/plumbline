import { useEffect, useMemo, useState } from 'react'
import type { PortfolioProjectView } from '../api/client.js'
import { useSession } from '../session/SessionProvider.tsx'
import { Banner, Button, Card, Input, Pill, Spinner } from '../ui/index.js'
import { formatMoney } from './Budget.tsx'

/**
 * The company view.
 *
 * This replaced a table of project names and contract values. A project
 * manager running six jobs already knows what they are called; the question
 * they have when they sign in is which one is on fire, and a list that cannot
 * answer it is a list they scroll past on the way to somewhere else.
 *
 * So the row leads with what is overdue and what is sitting in their own
 * court, and the screen leads with the same two numbers across every job. The
 * money is on the row where the person may see it and absent where they may
 * not, resolved per project rather than for the whole screen: the same person
 * is routinely cleared for the numbers on their own jobs and not on the one
 * they were added to for a single inspection.
 */

type Sort = 'attention' | 'number' | 'name' | 'activity'

function stageLabel(stage: string): string {
  return stage.replace(/_/g, ' ')
}

/** Most recent first, in the words somebody would use out loud. */
function ago(iso: string | null): string {
  if (!iso) return 'no activity yet'
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 14) return `${days} days ago`
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`
  return `${Math.floor(days / 30)} months ago`
}

/**
 * One number, big, with what it means under it.
 *
 * Deliberately not a chart. Nobody opens a portfolio to look at a donut; they
 * open it to find out whether anything needs them this morning.
 */
function Stat({
  value,
  label,
  tone = 'neutral',
}: {
  value: number | string
  label: string
  tone?: 'neutral' | 'danger' | 'warn' | 'accent'
}) {
  const colour =
    tone === 'danger'
      ? 'var(--danger)'
      : tone === 'warn'
        ? 'var(--warn-ink, var(--ink))'
        : tone === 'accent'
          ? 'var(--accent)'
          : 'var(--ink)'
  return (
    <div style={{ minWidth: 120 }}>
      <div style={{ fontSize: 30, fontWeight: 650, lineHeight: 1.1, color: colour, fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </div>
      <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginTop: 2 }}>{label}</div>
    </div>
  )
}

export function Portfolio({ onOpenProject }: { onOpenProject: (project: { id: string; number: string; name: string }) => void }) {
  const { api, me } = useSession()
  const [projects, setProjects] = useState<PortfolioProjectView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<Sort>('attention')

  useEffect(() => {
    let cancelled = false
    api
      .portfolio()
      .then((r) => {
        if (!cancelled) setProjects(r.projects)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load your projects')
      })
    return () => {
      cancelled = true
    }
  }, [api])

  const rows = useMemo(() => {
    const all = projects ?? []
    const needle = query.trim().toLowerCase()
    const matched = needle
      ? all.filter(
          (p) =>
            p.number.toLowerCase().includes(needle) ||
            p.name.toLowerCase().includes(needle) ||
            (p.city ?? '').toLowerCase().includes(needle),
        )
      : all
    const sorted = [...matched]
    if (sort === 'attention') {
      // Overdue first, then what is yours, then what is due soon. This is the
      // default because it is the question the screen exists to answer.
      sorted.sort((a, b) => b.overdue - a.overdue || b.mine - a.mine || b.dueSoon - a.dueSoon)
    } else if (sort === 'number') {
      sorted.sort((a, b) => a.number.localeCompare(b.number))
    } else if (sort === 'name') {
      sorted.sort((a, b) => a.name.localeCompare(b.name))
    } else {
      sorted.sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''))
    }
    return sorted
  }, [projects, query, sort])

  const totals = useMemo(() => {
    const all = projects ?? []
    return {
      jobs: all.length,
      overdue: all.reduce((n, p) => n + p.overdue, 0),
      mine: all.reduce((n, p) => n + p.mine, 0),
      open: all.reduce((n, p) => n + p.openRecords, 0),
    }
  }, [projects])

  if (error) return <Banner tone="danger">{error}</Banner>
  if (projects === null) return <Spinner label="Loading your projects" />

  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)', alignContent: 'start' }}>
      <Card>
        <div style={{ display: 'flex', gap: 'var(--space-5)', flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <Stat value={totals.overdue} label="overdue across every job" tone={totals.overdue > 0 ? 'danger' : 'neutral'} />
          <Stat value={totals.mine} label="waiting on you" tone={totals.mine > 0 ? 'accent' : 'neutral'} />
          <Stat value={totals.open} label="open records" />
          <Stat value={totals.jobs} label={totals.jobs === 1 ? 'job' : 'jobs'} />
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', minWidth: 240 }}>
            <Input value={query} onChange={setQuery} placeholder="Find a job by number, name or city" />
          </div>
        </div>
      </Card>

      <div style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 13 }}>
        <span style={{ color: 'var(--ink-muted)', marginRight: 4 }}>Sort</span>
        {(
          [
            ['attention', 'Needs attention'],
            ['number', 'Number'],
            ['name', 'Name'],
            ['activity', 'Recently active'],
          ] as const
        ).map(([key, label]) => (
          <Button key={key} variant={sort === key ? 'secondary' : 'ghost'} onClick={() => setSort(key)}>
            {label}
          </Button>
        ))}
      </div>

      {rows.length === 0 ? (
        <Card>
          <p style={{ margin: 0, color: 'var(--ink-muted)' }}>
            {projects.length === 0
              ? 'You are not on any projects yet. Someone with directory access can add you.'
              : `Nothing matches “${query}”.`}
          </p>
        </Card>
      ) : null}

      <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
        {rows.map((project) => (
          <ProjectCard key={project.id} project={project} onOpen={() => onOpenProject(project)} />
        ))}
      </div>

      {me?.user ? (
        <p style={{ margin: 0, fontSize: 12, color: 'var(--ink-faint)' }}>
          {me.user.name} · {me.user.organization}
        </p>
      ) : null}
    </div>
  )
}

function ProjectCard({ project, onOpen }: { project: PortfolioProjectView; onOpen: () => void }) {
  const over = project.projectedOverUnder
  // Negative means over budget, which is the only direction anybody reacts to.
  const overBudget = over !== null && over.startsWith('-')

  return (
    <button
      type="button"
      onClick={onOpen}
      style={{
        appearance: 'none',
        textAlign: 'left',
        font: 'inherit',
        cursor: 'pointer',
        background: 'var(--surface)',
        border: '1px solid var(--line)',
        // A red edge on a job that is overdue, so the list is scannable
        // without reading a single number.
        borderLeft: `4px solid ${project.overdue > 0 ? 'var(--danger)' : project.mine > 0 ? 'var(--accent)' : 'var(--line)'}`,
        borderRadius: 10,
        padding: 'var(--space-4)',
        display: 'flex',
        gap: 'var(--space-4)',
        alignItems: 'center',
        flexWrap: 'wrap',
        width: '100%',
      }}
    >
      <div style={{ minWidth: 260, flex: '1 1 260px' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
          <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{project.number}</strong>
          <span style={{ fontWeight: 600 }}>{project.name}</span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginTop: 4, display: 'flex', gap: 8, alignItems: 'center' }}>
          <Pill>{stageLabel(project.stage)}</Pill>
          {project.city ? <span>{[project.city, project.stateCode].filter(Boolean).join(', ')}</span> : null}
          <span>· {ago(project.lastActivityAt)}</span>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
        <Stat
          value={project.overdue}
          label="overdue"
          tone={project.overdue > 0 ? 'danger' : 'neutral'}
        />
        <Stat value={project.mine} label="in your court" tone={project.mine > 0 ? 'accent' : 'neutral'} />
        <Stat value={project.dueSoon} label="due this week" />
        <Stat value={project.openRecords} label="open" />
      </div>

      <div style={{ marginLeft: 'auto', textAlign: 'right', minWidth: 150 }}>
        {project.currentBudget === null ? (
          // Said rather than left blank. A blank column reads as a job with no
          // budget on it, which is a different and more alarming thing than
          // not being cleared to see one.
          <div style={{ fontSize: 12, color: 'var(--ink-faint)' }}>
            {project.contractValue
              ? `${formatMoney(project.contractValue)} contract`
              : 'Cost figures are not part of your access'}
          </div>
        ) : (
          <>
            <div style={{ fontSize: 16, fontWeight: 650, fontVariantNumeric: 'tabular-nums' }}>
              {formatMoney(project.currentBudget)}
            </div>
            <div style={{ fontSize: 12, color: overBudget ? 'var(--danger)' : 'var(--ink-muted)', marginTop: 2 }}>
              {over === null
                ? 'current budget'
                : overBudget
                  ? `${formatMoney(over.slice(1))} over`
                  : `${formatMoney(over)} under`}
            </div>
          </>
        )}
      </div>
    </button>
  )
}
