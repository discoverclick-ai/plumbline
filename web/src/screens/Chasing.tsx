import { useEffect, useState } from 'react'
import type { EscalationView } from '../api/client.js'
import { ToolLandingPage } from '../layouts/index.js'
import { useSession } from '../session/SessionProvider.tsx'
import { Banner, Button, Card, EmptyState, Pill, Spinner } from '../ui/index.js'

/**
 * The chase queue.
 *
 * The job a project engineer does with a spreadsheet on a Friday afternoon,
 * badly, everywhere, because it is tedious and the cost of missing one is
 * invisible until it is enormous.
 *
 * This screen is where the product's central promise becomes something a
 * person can see: AN AGENT MAY PROPOSE ANYTHING AND SEND NOTHING. Every row
 * is a message that was written and not sent, and the only two buttons are
 * "send this" and "no". There is no bulk approve, deliberately: approving
 * forty chases with one click is the same as sending forty unread, and the
 * whole value of the gate is that somebody read them.
 *
 * The drafted message is shown in full rather than behind a disclosure.
 * Anything a person is about to put their name on, they should have to look
 * at.
 */

const LEVEL_TONE: Record<string, 'neutral' | 'warn' | 'danger'> = {
  reminder: 'neutral',
  overdue: 'warn',
  escalated: 'danger',
  critical: 'danger',
}

const LEVEL_LABEL: Record<string, string> = {
  reminder: 'Reminder',
  overdue: 'Overdue',
  escalated: 'Escalated',
  critical: 'Critical',
}

/** Who this lands on, said the way it would be said out loud. */
export function audienceLine(chase: EscalationView): string {
  const to = chase.notifiedName ?? 'the person who raised it'
  if (chase.level === 'reminder' || chase.level === 'overdue') {
    return `To ${to}, who is holding it`
  }
  return `To ${to}${chase.holderName ? `, about ${chase.holderName}` : ''}`
}

export function Chasing({ projectId, projectName }: { projectId: string; projectName: string }) {
  const { api } = useSession()
  const [chases, setChases] = useState<EscalationView[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const reload = (): void => {
    api
      .escalations(projectId)
      .then((r) => setChases(r.escalations))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load the queue'))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    setLoading(true)
    reload()
    // reload closes over stable values; re-running on project change is the
    // whole dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, projectId])

  async function decide(chase: EscalationView, verdict: 'approve' | 'dismiss'): Promise<void> {
    setBusy(chase.id)
    setError(null)
    try {
      if (verdict === 'approve') await api.approveEscalation(chase.id)
      else await api.dismissEscalation(chase.id)
      setChases((current) => current.filter((c) => c.id !== chase.id))
      setNote(
        verdict === 'approve'
          ? `${chase.designation} queued to send to ${chase.notifiedName ?? 'them'}.`
          : // The dismissal is kept, not deleted. "Did we chase them, and
            // when" is the question a delay claim turns on, and "we decided
            // not to" is an answer.
            `${chase.designation} stood down. The decision is on the record.`,
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not go through')
    } finally {
      setBusy(null)
    }
  }

  const critical = chases.filter((c) => c.level === 'critical' || c.level === 'escalated')

  return (
    <ToolLandingPage
      title="Chasing"
      subtitle={projectName}
      banner={
        error ? (
          <Banner tone="danger">{error}</Banner>
        ) : critical.length > 0 ? (
          <Banner tone="danger">
            {critical.length} {critical.length === 1 ? 'item has' : 'items have'} gone past the point where a
            reminder is enough.
          </Banner>
        ) : note ? (
          <Banner tone="accent">{note}</Banner>
        ) : undefined
      }
    >
      <Card
        title={`${chases.length} drafted, none sent`}
        actions={
          <Button
            onClick={() => {
              setBusy('sweep')
              setNote(null)
              api
                .sweepEscalations(projectId)
                .then((result) => {
                  setNote(
                    result.drafted === 0
                      ? 'Nothing new worth chasing.'
                      : `${result.drafted} new ${result.drafted === 1 ? 'draft' : 'drafts'}.`,
                  )
                  reload()
                })
                .catch((err: unknown) => setError(err instanceof Error ? err.message : 'The sweep failed'))
                .finally(() => setBusy(null))
            }}
            disabled={busy === 'sweep'}
          >
            {busy === 'sweep' ? 'Working the queue…' : 'Work the queue'}
          </Button>
        }
      >
        {loading ? (
          <Spinner label="Loading the queue" />
        ) : chases.length === 0 ? (
          <EmptyState
            title="Nothing waiting on you"
            detail="Nothing on this job has been sitting long enough to be worth a chase. Work the queue to check again."
          />
        ) : (
          <div style={{ display: 'grid', gap: 12 }}>
            {chases.map((chase) => (
              <article
                key={chase.id}
                style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 14, background: 'var(--surface)' }}
              >
                <header style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
                  <div>
                    <Pill tone={LEVEL_TONE[chase.level] ?? 'neutral'}>{LEVEL_LABEL[chase.level] ?? chase.level}</Pill>{' '}
                    <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{chase.designation}</strong>{' '}
                    <span style={{ color: 'var(--ink-muted)' }}>{chase.title}</span>
                  </div>
                  <span style={{ fontSize: 12, color: 'var(--ink-muted)', whiteSpace: 'nowrap' }}>
                    {chase.daysWaiting} days waiting
                  </span>
                </header>

                <p style={{ margin: '8px 0 0', fontSize: 13, color: 'var(--ink-muted)' }}>{audienceLine(chase)}</p>
                <p style={{ margin: '4px 0 0', fontSize: 13 }}>{chase.reason}</p>

                {/*
                  Shown in full, never behind a disclosure. Anything a person
                  is about to put their name on, they should have to look at.
                */}
                <pre
                  style={{
                    margin: '10px 0 0',
                    padding: '10px 12px',
                    background: 'var(--surface-sunken)',
                    borderRadius: 8,
                    fontSize: 13,
                    lineHeight: 1.55,
                    whiteSpace: 'pre-wrap',
                    fontFamily: 'inherit',
                  }}
                >
                  {chase.message}
                </pre>

                <footer style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
                  <Button variant="ghost" onClick={() => void decide(chase, 'dismiss')} disabled={busy === chase.id}>
                    Stand down
                  </Button>
                  <Button onClick={() => void decide(chase, 'approve')} disabled={busy === chase.id}>
                    {busy === chase.id ? 'Sending…' : 'Send this'}
                  </Button>
                </footer>
              </article>
            ))}
          </div>
        )}
      </Card>
    </ToolLandingPage>
  )
}
