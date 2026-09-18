import { useEffect, useState } from 'react'
import type { BallInCourtEntry } from '@plumbline/shared'
import { ToolLandingPage } from '../layouts/index.js'
import { useSession } from '../session/SessionProvider.tsx'
import { Banner, Card, Initials, Pill, Spinner, Table, Tabs } from '../ui/index.js'

/**
 * The home screen: what you owe, oldest first.
 *
 * In a status-field product this view is a nightly report somebody exports to
 * a spreadsheet. Here ball-in-court is an assignment row with a holder, an
 * expected action and an age, so it is a join — which is why this screen is
 * one request and no client-side aggregation.
 */

export function BallInCourt({
  projectId,
  onOpenRecord,
}: {
  /** Omitted for the cross-project view: your whole workload, every job. */
  projectId?: string
  onOpenRecord: (recordId: string) => void
}) {
  const { api, me } = useSession()
  // Scoping to a project without also scoping to a person answers a different
  // question — "what is open on this job" rather than "what do I owe" — and a
  // screen titled "In your court" that lists other people's work is a lie.
  const [scope, setScope] = useState<'mine' | 'everyone'>('mine')
  const [entries, setEntries] = useState<BallInCourtEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api
      .ballInCourt({
        ...(projectId ? { projectId } : {}),
        ...(scope === 'mine' && me?.user ? { holderUserId: me.user.id } : {}),
      })
      .then((result) => {
        if (!cancelled) setEntries(result.entries)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load your work')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [api, projectId, scope, me?.user?.id])

  const overdue = entries.filter((entry) => entry.overdue).length

  return (
    <ToolLandingPage
      title={scope === 'mine' ? 'In your court' : 'Open across this project'}
      subtitle={me?.user ? `${me.user.name} · ${me.user.organization}` : undefined}
      tabs={
        projectId && (
          <Tabs
            active={scope}
            onSelect={(key) => setScope(key as 'mine' | 'everyone')}
            tabs={[
              { key: 'mine', label: 'Mine' },
              { key: 'everyone', label: 'Everyone' },
            ]}
          />
        )
      }
      banner={
        error ? (
          <Banner tone="danger">{error}</Banner>
        ) : overdue > 0 ? (
          <Banner tone="danger">
            {overdue} {overdue === 1 ? 'item is' : 'items are'} past due.
          </Banner>
        ) : undefined
      }
    >
      <Card>
        {loading ? (
          <Spinner label="Loading your work" />
        ) : (
          <Table
            rows={entries}
            rowKey={(row) => row.recordId}
            onRowClick={(row) => onOpenRecord(row.recordId)}
            empty={
              <p style={{ margin: 0, color: 'var(--ink-muted)' }}>
                Nothing is waiting on you. Everything you have touched is in somebody else&rsquo;s court.
              </p>
            }
            columns={[
              {
                key: 'record',
                header: 'Record',
                width: '160px',
                render: (row) => <strong>{row.designation}</strong>,
              },
              {
                key: 'title',
                header: 'What is needed',
                render: (row) => (
                  <>
                    <div>{row.title}</div>
                    <div style={{ fontSize: 12, color: 'var(--ink-muted)' }}>{row.expectedAction}</div>
                  </>
                ),
              },
              ...(projectId
                ? []
                : [
                    {
                      key: 'project',
                      header: 'Project',
                      width: '180px',
                      render: (row: BallInCourtEntry) => row.projectName,
                    },
                  ]),
              {
                key: 'holder',
                header: 'Holder',
                width: '160px',
                secondary: scope === 'mine',
                render: (row) => (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <Initials name={row.holderName} />
                    {row.holderName}
                  </span>
                ),
              },
              {
                key: 'age',
                header: 'Waiting',
                width: '120px',
                render: (row) => (
                  <Pill tone={row.overdue ? 'danger' : row.ageDays >= 3 ? 'warn' : 'neutral'}>
                    {row.ageDays === 0 ? 'today' : `${row.ageDays}d`}
                  </Pill>
                ),
              },
            ]}
          />
        )}
      </Card>
    </ToolLandingPage>
  )
}
