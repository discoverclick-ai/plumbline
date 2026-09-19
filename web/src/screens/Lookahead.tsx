import { useEffect, useState } from 'react'
import type { ActivityView, ExposureView } from '../api/client.js'
import { ToolLandingPage } from '../layouts/index.js'
import { useSession } from '../session/SessionProvider.tsx'
import { Banner, Card, EmptyState, Pill, Spinner, Table, Tabs } from '../ui/index.js'
import { UploadPanel } from './UploadPanel.tsx'

/**
 * The morning meeting, as a page.
 *
 * Every scheduling screen in this industry is a Gantt chart, and a Gantt
 * chart is a picture of a plan. Nobody standing in a trailer at seven in the
 * morning needs a picture of the plan. They need the list of things that are
 * going to stop them and the name of the person sitting on each one, ordered
 * by how little room is left.
 *
 * So there is no Gantt here, on purpose. Float and waiting-time sit in the
 * same row, because that pairing is the entire argument: an RFI eleven days
 * out against an activity with two days of float is not a paperwork problem,
 * it is a delay that has already happened and nobody has said so out loud.
 */

/** Float as a person says it, which is never "0.00". */
export function floatText(days: string | null): string {
  if (days === null) return 'no float shown'
  const n = Number(days)
  if (!Number.isFinite(n)) return 'no float shown'
  if (n <= 0) return 'critical path'
  const rounded = Math.round(n * 10) / 10
  return `${rounded} day${rounded === 1 ? '' : 's'} of float`
}

/**
 * How alarmed to be.
 *
 * Driven by float MINUS the longest wait, not by float alone. An activity
 * with twenty days of float and an RFI that has been sitting twenty-two days
 * is already late, and a screen that showed it in grey because the schedule
 * says twenty would be actively misleading.
 */
export function exposureTone(row: ExposureView): 'danger' | 'warn' | 'neutral' {
  const remaining = row.floatRemainingDays
  if (remaining !== null) {
    if (remaining <= 0) return 'danger'
    if (remaining <= 5) return 'warn'
    return 'neutral'
  }
  if (row.isCritical) return 'danger'
  const float = row.totalFloatDays === null ? null : Number(row.totalFloatDays)
  return float !== null && float <= 5 ? 'warn' : 'neutral'
}

export function startsIn(startAt: string | null, now: Date = new Date()): string {
  if (!startAt) return 'unscheduled'
  const [y, m, d] = startAt.split('-').map(Number) as [number, number, number]
  const days = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / 86_400_000)
  if (days < 0) return `started ${Math.abs(days)}d ago`
  if (days === 0) return 'starts today'
  if (days === 1) return 'starts tomorrow'
  return `starts in ${days}d`
}

export function Lookahead({ projectId, projectName }: { projectId: string; projectName: string }) {
  const { api } = useSession()
  const [tab, setTab] = useState<'exposure' | 'lookahead' | 'import'>('exposure')
  const [exposure, setExposure] = useState<ExposureView[]>([])
  const [activities, setActivities] = useState<ActivityView[]>([])
  const [weeks, setWeeks] = useState(3)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    Promise.all([api.exposure(projectId), api.lookahead(projectId, weeks)])
      .then(([e, l]) => {
        if (cancelled) return
        setExposure(e.exposure)
        setActivities(l.activities)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load the schedule')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [api, projectId, weeks])

  const alarming = exposure.filter((row) => exposureTone(row) === 'danger')

  return (
    <ToolLandingPage
      title="Lookahead"
      subtitle={projectName}
      tabs={
        <Tabs
          active={tab}
          onSelect={(key) => setTab(key as 'exposure' | 'lookahead' | 'import')}
          tabs={[
            { key: 'exposure', label: 'What is in the way', badge: exposure.length },
            { key: 'lookahead', label: `${weeks} week lookahead`, badge: activities.length },
            { key: 'import', label: 'Import an update' },
          ]}
        />
      }
      banner={
        error ? (
          <Banner tone="danger">{error}</Banner>
        ) : alarming.length > 0 ? (
          <Banner tone="danger">
            {alarming.length} {alarming.length === 1 ? 'activity has' : 'activities have'} run out of float while
            waiting on something. These are delays that have already happened.
          </Banner>
        ) : undefined
      }
    >
      {loading ? (
        <Card>
          <Spinner label="Loading the schedule" />
        </Card>
      ) : tab === 'import' ? (
        <UploadPanel
          title="Import a schedule update"
          description="A Primavera P6 .xer export. Every import is kept: the old schedule is never overwritten, because 'the schedule said we had four days of float when we raised this' is the sentence a delay claim is built on."
          accept=".xer,text/plain"
          nameLabel="What to call this update"
          namePlaceholder="Update 4"
          onUpload={async ({ name, text }) => {
            const result = await api.importSchedule(projectId, name, text)
            setWeeks((w) => w) // force the effect to re-read the new current schedule
            return {
              ok: true,
              headline: `${result.imported} activities imported${result.dataDate ? `, data date ${result.dataDate}` : ''}.`,
              detail: [
                // Both lists, always. A row the parser refused and a link that
                // now points at nothing are the two things somebody has to
                // know about before they run a meeting off this.
                ...result.rejected.map((r) => `Refused: ${r.row} — ${r.reason}`),
                ...result.orphanedLinks.map(
                  (o) => `${o.recordDesignation} was linked to ${o.activityCode}, which is not in this update.`,
                ),
              ],
            }
          }}
        />
      ) : tab === 'exposure' ? (
        <Card title="Ordered by how little room is left">
          <Table
            rows={exposure}
            rowKey={(row) => row.activityCode}
            empty={
              <EmptyState
                title="Nothing in the way"
                detail="No activity on the current schedule has an open record blocking it. Link an RFI or a submittal to an activity from the record itself."
              />
            }
            columns={[
              {
                key: 'activity',
                header: 'Activity',
                render: (row) => (
                  <>
                    <strong>{row.activityName}</strong>
                    <div style={{ fontSize: 12, color: 'var(--ink-muted)', fontVariantNumeric: 'tabular-nums' }}>
                      {row.activityCode} · {startsIn(row.startAt)}
                    </div>
                  </>
                ),
              },
              {
                key: 'float',
                header: 'Room left',
                width: '180px',
                render: (row) => (
                  <>
                    <Pill tone={exposureTone(row)}>{floatText(row.totalFloatDays)}</Pill>
                    {row.longestWaitDays !== null ? (
                      <div style={{ fontSize: 12, color: 'var(--ink-muted)' }}>
                        {/*
                          Stated as two facts, not as one subtracted number.
                          The subtraction is a judgement a scheduler would not
                          sign, and the reader does it in their head anyway.
                        */}
                        waiting {row.longestWaitDays}d
                      </div>
                    ) : null}
                  </>
                ),
              },
              {
                key: 'blocking',
                header: 'Waiting on',
                render: (row) => (
                  <div style={{ display: 'grid', gap: 4 }}>
                    {row.records.map((record) => (
                      <div key={record.recordId} style={{ fontSize: 13 }}>
                        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{record.designation}</span>{' '}
                        <span style={{ color: 'var(--ink-muted)' }}>{record.title}</span>
                        {record.holderName ? (
                          // By name. "With the design team" is not something
                          // anybody can act on.
                          <div style={{ color: 'var(--ink-muted)' }}>with {record.holderName}</div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ),
              },
            ]}
          />
        </Card>
      ) : (
        <Card
          title="What starts next"
          actions={
            <div style={{ display: 'flex', gap: 4 }}>
              {[2, 3, 6].map((n) => (
                <button
                  key={n}
                  onClick={() => setWeeks(n)}
                  style={{
                    border: '1px solid var(--line)',
                    background: n === weeks ? 'var(--accent-soft)' : 'transparent',
                    borderRadius: 6,
                    padding: '4px 10px',
                    cursor: 'pointer',
                    font: 'inherit',
                  }}
                >
                  {n}w
                </button>
              ))}
            </div>
          }
        >
          <Table
            rows={activities}
            rowKey={(row) => row.activityCode}
            empty={
              <EmptyState
                title="Nothing scheduled in this window"
                detail="Either the lookahead is genuinely clear, or no schedule has been imported for this project yet."
              />
            }
            columns={[
              {
                key: 'activity',
                header: 'Activity',
                render: (row) => (
                  <>
                    <strong>{row.name}</strong>
                    <div style={{ fontSize: 12, color: 'var(--ink-muted)' }}>
                      {row.activityCode}
                      {row.wbsPath ? ` · ${row.wbsPath}` : ''}
                    </div>
                  </>
                ),
              },
              { key: 'start', header: 'Starts', width: '150px', render: (row) => startsIn(row.startAt) },
              {
                key: 'float',
                header: 'Float',
                width: '160px',
                render: (row) => (
                  <Pill tone={row.isCritical ? 'danger' : Number(row.totalFloatDays ?? 99) <= 5 ? 'warn' : 'neutral'}>
                    {floatText(row.totalFloatDays)}
                  </Pill>
                ),
              },
              {
                key: 'preds',
                header: 'After',
                width: '160px',
                render: (row) =>
                  row.predecessors.length === 0 ? (
                    '—'
                  ) : (
                    <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
                      {row.predecessors.slice(0, 3).join(', ')}
                      {row.predecessors.length > 3 ? ` +${row.predecessors.length - 3}` : ''}
                    </span>
                  ),
              },
            ]}
          />
        </Card>
      )}
    </ToolLandingPage>
  )
}
