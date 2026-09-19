import { useEffect, useMemo, useState } from 'react'
import type { ClauseView, ClockView, ContractDocumentView, ObligationView } from '../api/client.js'
import { ToolLandingPage } from '../layouts/index.js'
import { useSession } from '../session/SessionProvider.tsx'
import { Banner, Button, Card, EmptyState, Pill, Spinner, Table, Tabs } from '../ui/index.js'

/**
 * The contract profile, and the clocks it produces.
 *
 * The review screen is the centrepiece of this subsystem, not an admin page.
 * It is a one-time cost of maybe half an hour per contract, and it is the
 * moment a general contractor's risk function either decides this system can
 * be trusted with a deadline or decides it cannot.
 *
 * So the design rule here is that nothing is asserted without its evidence
 * next to it. Every proposed obligation shows the clause it came from and the
 * quote it relied on, highlighted in that clause's actual text. A reviewer
 * accepting forty of these in a sitting must be able to check any one of them
 * in two seconds without leaving the row.
 *
 * And every deadline renders its arithmetic on demand. A date nobody can
 * check by hand is a date nobody will act on.
 */

const OBLIGATION_LABELS: Record<string, string> = {
  notice_of_delay: 'Notice of delay',
  notice_of_change: 'Notice of a change',
  notice_of_claim: 'Notice of claim',
  differing_site_conditions: 'Differing site conditions',
  weather_day: 'Weather day',
  cure_period: 'Cure period',
  submittal_turnaround: 'Submittal turnaround',
  rfi_response_time: 'RFI response time',
  payment_application_window: 'Payment application window',
  payment_due: 'Payment due',
  retainage_release: 'Retainage release',
  substantial_completion: 'Substantial completion',
  liquidated_damages: 'Liquidated damages',
  insurance_certificate: 'Insurance certificate',
  safety_reporting: 'Safety reporting',
  closeout_submission: 'Closeout submission',
}

const CONSEQUENCE_LABELS: Record<string, string> = {
  waiver_of_claim: 'Claim is waived',
  liquidated_damages: 'Liquidated damages',
  payment_withheld: 'Payment withheld',
  default: 'Default',
  none_stated: 'None stated',
}

const KIND_LABELS: Record<string, string> = {
  prime_contract: 'Prime contract',
  subcontract: 'Subcontract',
  purchase_order: 'Purchase order',
  general_conditions: 'General conditions',
  supplementary_conditions: 'Supplementary conditions',
  amendment: 'Amendment',
  change_order: 'Change order',
  exhibit: 'Exhibit',
}

const BASIS_LABELS: Record<string, string> = {
  from_occurrence: 'from the event',
  from_awareness: 'from when we became aware',
  from_written_notice: 'from written notice',
  from_receipt: 'from receipt',
}

/** "five days from when we became aware", as a person would say it. */
export function windowText(o: Pick<ObligationView, 'durationValue' | 'durationUnit' | 'deadlineBasis'>): string {
  const unit = o.durationUnit === 'business_days' ? 'business days' : o.durationUnit
  const singular = o.durationValue === 1 ? unit.replace(/s$/, '') : unit
  return `${o.durationValue} ${singular} ${BASIS_LABELS[o.deadlineBasis] ?? ''}`.trim()
}

/**
 * Splits a clause into the run before the quote, the quote, and the run
 * after.
 *
 * Matching is done on whitespace-normalised text but the ORIGINAL characters
 * are returned, because the thing on screen has to be the contract as
 * printed. Returns null when the quote is not found, and the caller shows the
 * clause plain rather than inventing a highlight — a highlight that lands on
 * the wrong words is worse than none.
 */
export function highlight(clauseText: string, quote: string): [string, string, string] | null {
  const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase()
  const needle = norm(quote)
  if (needle.length < 12) return null

  // Walk the original text, building the normalised form and remembering
  // where each normalised character came from.
  const map: number[] = []
  let normalised = ''
  let lastWasSpace = true
  for (let i = 0; i < clauseText.length; i += 1) {
    const ch = clauseText[i]!
    if (/\s/.test(ch)) {
      if (lastWasSpace) continue
      map.push(i)
      normalised += ' '
      lastWasSpace = true
      continue
    }
    map.push(i)
    normalised += ch.toLowerCase()
    lastWasSpace = false
  }
  const trimmedStart = normalised.length - normalised.trimStart().length
  const at = normalised.trim().indexOf(needle)
  if (at < 0) return null

  const from = map[at + trimmedStart]!
  const toIndex = at + trimmedStart + needle.length - 1
  const to = (map[toIndex] ?? clauseText.length - 1) + 1
  return [clauseText.slice(0, from), clauseText.slice(from, to), clauseText.slice(to)]
}

/**
 * Whole days between now and the deadline, counted on the JOB'S calendar.
 *
 * Not on the viewer's. A deadline is end of day in the project's timezone,
 * and an earlier version diffed the raw timestamps: a notice due at six this
 * evening came out as 0.25 days, rounded up, and read "Due tomorrow". Worse,
 * a viewer in a zone east of the job would have seen every deadline a day
 * later than the crew standing on it. Everybody on a job sees the job's
 * countdown.
 */
function daysUntil(iso: string, now: Date, timeZone: string): number {
  const civil = (at: Date): number => {
    const [y, m, d] = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .format(at)
      .split('-')
      .map(Number) as [number, number, number]
    return Date.UTC(y, m - 1, d)
  }
  return Math.round((civil(new Date(iso)) - civil(now)) / 86_400_000)
}

export function dueText(iso: string, timeZone = 'UTC', now: Date = new Date()): string {
  const days = daysUntil(iso, now, timeZone)
  if (days < 0) return `${Math.abs(days)} ${Math.abs(days) === 1 ? 'day' : 'days'} past due`
  if (days === 0) return 'Due today'
  if (days === 1) return 'Due tomorrow'
  return `${days} days left`
}

/** The job's timezone, as frozen into this clock's own arithmetic. */
export function zoneOf(clock: ClockView): string {
  const zone = clock.computation['timeZone']
  return typeof zone === 'string' && zone !== '' ? zone : 'UTC'
}

export function clockTone(clock: ClockView, now: Date = new Date()): 'danger' | 'warn' | 'ok' | 'neutral' {
  if (clock.state === 'expired') return 'danger'
  if (clock.state === 'satisfied' || clock.state === 'waived') return 'ok'
  const days = daysUntil(clock.dueAt, now, zoneOf(clock))
  if (days <= 0) return 'danger'
  return days <= 3 || clock.state === 'in_court' ? 'warn' : 'neutral'
}

export function Contracts({ projectId, projectName }: { projectId: string; projectName: string }) {
  const { api } = useSession()
  const [tab, setTab] = useState<'clocks' | 'profile'>('clocks')
  const [documents, setDocuments] = useState<ContractDocumentView[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [clauses, setClauses] = useState<ClauseView[]>([])
  const [obligations, setObligations] = useState<ObligationView[]>([])
  const [clocks, setClocks] = useState<ClockView[] | null>([])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    Promise.all([
      api.contracts(projectId),
      // A refusal is not an empty list. Telling somebody "no deadlines are
      // running on this job" when they simply may not see them is the one
      // wrong answer this screen could give.
      api.clocks(projectId).catch(() => ({ clocks: null })),
    ])
      .then(([docs, running]) => {
        if (cancelled) return
        setDocuments(docs.documents)
        setClocks(running.clocks as ClockView[] | null)
        setSelected((current) => current ?? docs.documents[0]?.id ?? null)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load the contracts')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [api, projectId])

  useEffect(() => {
    if (!selected) return
    let cancelled = false
    Promise.all([api.clauses(selected), api.obligations(selected)])
      .then(([c, o]) => {
        if (cancelled) return
        setClauses(c.clauses)
        setObligations(o.obligations)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load that instrument')
      })
    return () => {
      cancelled = true
    }
  }, [api, selected])

  const clauseById = useMemo(() => new Map(clauses.map((c) => [c.id, c])), [clauses])
  const proposed = obligations.filter((o) => o.status === 'proposed')
  const accepted = obligations.filter((o) => o.status === 'accepted')
  const running = (clocks ?? []).filter((c) => c.state === 'watching' || c.state === 'in_court')
  const expired = (clocks ?? []).filter((c) => c.state === 'expired')

  async function decide(obligationId: string, verdict: 'accept' | 'reject'): Promise<void> {
    setBusy(obligationId)
    setError(null)
    try {
      if (verdict === 'accept') await api.acceptObligation(obligationId)
      else await api.rejectObligation(obligationId)
      setObligations((current) =>
        current.map((o) => (o.id === obligationId ? { ...o, status: verdict === 'accept' ? 'accepted' : 'rejected' } : o)),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not go through')
    } finally {
      setBusy(null)
    }
  }

  return (
    <ToolLandingPage
      title="Contracts"
      subtitle={projectName}
      tabs={
        <Tabs
          active={tab}
          onSelect={(key) => setTab(key as 'clocks' | 'profile')}
          tabs={[
            ...(clocks === null ? [] : [{ key: 'clocks', label: 'Clocks', badge: running.length }]),
            { key: 'profile', label: 'Contract Profile', badge: proposed.length },
          ]}
        />
      }
      banner={
        error ? (
          <Banner tone="danger">{error}</Banner>
        ) : expired.length > 0 ? (
          <Banner tone="danger">
            {expired.length} {expired.length === 1 ? 'deadline has' : 'deadlines have'} passed without a notice being
            served. These are kept on the record.
          </Banner>
        ) : proposed.length > 0 && tab === 'profile' ? (
          <Banner tone="accent">
            {proposed.length} extracted {proposed.length === 1 ? 'obligation is' : 'obligations are'} waiting on you.
            Nothing starts a clock until you accept it.
          </Banner>
        ) : undefined
      }
    >
      {loading ? (
        <Card>
          <Spinner label="Loading the contracts" />
        </Card>
      ) : tab === 'clocks' && clocks !== null ? (
        <Card
          title="Running deadlines"
          actions={
            <Button
              onClick={() => {
                setBusy('sweep')
                api
                  .sweepClocks(projectId)
                  .then(() => api.clocks(projectId))
                  .then((r) => setClocks(r.clocks))
                  .catch((err: unknown) => setError(err instanceof Error ? err.message : 'The sweep failed'))
                  .finally(() => setBusy(null))
              }}
              disabled={busy === 'sweep'}
            >
              {busy === 'sweep' ? 'Checking…' : 'Check now'}
            </Button>
          }
        >
          <Table
            rows={clocks}
            rowKey={(row) => row.id}
            empty={
              <EmptyState
                title="No clocks running"
                detail="A clock starts when something happens on the job that a contract puts a deadline on. Accept the obligations on the Contract Profile tab first."
              />
            }
            columns={[
              {
                key: 'what',
                header: 'Obligation',
                render: (row) => (
                  <>
                    <strong>{OBLIGATION_LABELS[row.obligationType] ?? row.obligationType}</strong>
                    {row.clauseNumber ? (
                      <span style={{ color: 'var(--ink-muted)' }}> · {row.clauseNumber}</span>
                    ) : null}
                    <div style={{ fontSize: 12, color: 'var(--ink-muted)' }}>{row.triggerDescription}</div>
                  </>
                ),
              },
              {
                key: 'trigger',
                header: 'Started by',
                width: '170px',
                render: (row) =>
                  row.triggerDesignation ? (
                    <>
                      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{row.triggerDesignation}</span>
                      <div style={{ fontSize: 12, color: 'var(--ink-muted)' }}>{row.triggerTitle}</div>
                    </>
                  ) : (
                    '—'
                  ),
              },
              {
                key: 'notice',
                header: 'Notice',
                width: '150px',
                render: (row) =>
                  row.noticeDesignation ? (
                    <>
                      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{row.noticeDesignation}</span>
                      <div style={{ fontSize: 12, color: 'var(--ink-muted)' }}>{row.noticeStatus}</div>
                    </>
                  ) : (
                    // Stated, not blank. A clock with no record behind it means
                    // nobody on this project may raise a notice, and that is a
                    // configuration problem somebody has to fix today.
                    <span style={{ color: 'var(--danger)' }}>No notice raised</span>
                  ),
              },
              {
                key: 'due',
                header: 'Due',
                width: '190px',
                render: (row) => (
                  <>
                    <Pill tone={clockTone(row)}>
                      {row.state === 'expired' ? 'Expired' : dueText(row.dueAt, zoneOf(row))}
                    </Pill>
                    <div style={{ fontSize: 12, color: 'var(--ink-muted)' }}>
                      {new Date(row.dueAt).toLocaleDateString(undefined, { timeZone: zoneOf(row) })}
                    </div>
                  </>
                ),
              },
              {
                key: 'why',
                header: '',
                width: '110px',
                render: (row) => (
                  <Button variant="ghost" onClick={() => setExpanded(expanded === row.id ? null : row.id)}>
                    {expanded === row.id ? 'Hide' : 'Show work'}
                  </Button>
                ),
              },
            ]}
          />
          {expanded ? <Computation clock={(clocks ?? []).find((c) => c.id === expanded)!} /> : null}
        </Card>
      ) : (
        <>
          <Card title="Instruments">
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {documents.length === 0 ? (
                <EmptyState
                  title="No contracts on this job yet"
                  detail="Upload the prime, the general conditions and each subcontract. Nothing is read until a person asks for it."
                />
              ) : (
                documents.map((doc) => (
                  <Button
                    key={doc.id}
                    variant={doc.id === selected ? 'primary' : 'ghost'}
                    onClick={() => setSelected(doc.id)}
                  >
                    {doc.title}
                    <span style={{ opacity: 0.7 }}> · {KIND_LABELS[doc.kind] ?? doc.kind}</span>
                  </Button>
                ))
              )}
            </div>
          </Card>

          {selected ? (
            <Card title={`Obligations · ${accepted.length} accepted, ${proposed.length} waiting`}>
              {obligations.length === 0 ? (
                <EmptyState
                  title="Nothing extracted from this instrument yet"
                  detail={
                    clauses.length === 0
                      ? 'This document has not been segmented into clauses. Until it is, nothing can cite it.'
                      : 'The clauses are in. Run the extraction to propose the timed obligations they contain.'
                  }
                />
              ) : (
                <div style={{ display: 'grid', gap: 12 }}>
                  {obligations.map((o) => (
                    <ObligationCard
                      key={o.id}
                      obligation={o}
                      clause={clauseById.get(o.clauseId) ?? null}
                      busy={busy === o.id}
                      onDecide={(verdict) => void decide(o.id, verdict)}
                    />
                  ))}
                </div>
              )}
            </Card>
          ) : null}
        </>
      )}
    </ToolLandingPage>
  )
}

/**
 * One obligation, with the clause it came from underneath it.
 *
 * The quote is highlighted in the clause's own text rather than repeated
 * above it, because a reviewer has to see the sentence IN CONTEXT to judge
 * whether the reading is right. A quote shown on its own is a claim about the
 * contract; a quote shown inside the clause is the contract.
 */
function ObligationCard({
  obligation,
  clause,
  busy,
  onDecide,
}: {
  obligation: ObligationView
  clause: ClauseView | null
  busy: boolean
  onDecide: (verdict: 'accept' | 'reject') => void
}) {
  const parts = clause ? highlight(clause.text, obligation.quote) : null

  return (
    <div
      style={{
        border: '1px solid var(--line)',
        borderRadius: 10,
        padding: 14,
        background: obligation.status === 'proposed' ? 'var(--surface)' : 'transparent',
        opacity: obligation.status === 'rejected' ? 0.5 : 1,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
        <div>
          <strong>{OBLIGATION_LABELS[obligation.obligationType] ?? obligation.obligationType}</strong>
          <div style={{ fontSize: 13, color: 'var(--ink-muted)', marginTop: 2 }}>
            {windowText(obligation)}
            {obligation.clauseNumber ? ` · clause ${obligation.clauseNumber}` : ''}
            {clause?.page ? ` · page ${clause.page}` : ''}
          </div>
          <div style={{ fontSize: 13, marginTop: 6 }}>{obligation.triggerDescription}</div>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
          {obligation.inheritedFromId ? <Pill tone="neutral">Inherited</Pill> : null}
          <Pill tone={obligation.consequence === 'waiver_of_claim' ? 'danger' : 'neutral'}>
            {CONSEQUENCE_LABELS[obligation.consequence] ?? obligation.consequence}
          </Pill>
          {obligation.status === 'proposed' ? (
            <>
              <Button variant="ghost" onClick={() => onDecide('reject')} disabled={busy}>
                Reject
              </Button>
              <Button onClick={() => onDecide('accept')} disabled={busy}>
                {busy ? 'Saving…' : 'Accept'}
              </Button>
            </>
          ) : (
            <Pill tone={obligation.status === 'accepted' ? 'ok' : 'neutral'}>
              {obligation.status === 'accepted' ? 'Accepted' : 'Rejected'}
            </Pill>
          )}
        </div>
      </div>

      {obligation.rationale ? (
        <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginTop: 8, fontStyle: 'italic' }}>
          {obligation.rationale}
          {obligation.confidence ? ` (confidence ${obligation.confidence})` : ''}
        </div>
      ) : null}

      {clause ? (
        <blockquote
          style={{
            margin: '10px 0 0',
            padding: '10px 12px',
            borderLeft: '3px solid var(--line)',
            background: 'var(--surface-sunken)',
            fontSize: 13,
            lineHeight: 1.6,
            whiteSpace: 'pre-wrap',
            maxHeight: 190,
            overflow: 'auto',
          }}
        >
          {parts ? (
            <>
              {parts[0]}
              <mark style={{ background: 'var(--accent-soft)', padding: '1px 0' }}>{parts[1]}</mark>
              {parts[2]}
            </>
          ) : (
            <>
              {/* No highlight rather than a wrong one. The server already
                  refused to store an obligation whose quote is not in its
                  clause, so this means the clause was re-segmented under it. */}
              {clause.text}
            </>
          )}
        </blockquote>
      ) : null}
    </div>
  )
}

/**
 * The arithmetic, in full.
 *
 * Every day counted and every day skipped, with why. This is not a debugging
 * affordance: a deadline a project manager cannot check by hand is one they
 * will not stake a claim on, and the whole product is asking them to.
 */
function Computation({ clock }: { clock: ClockView }) {
  const steps = (clock.computation['steps'] as string[] | undefined) ?? []
  const notes = (clock.computation['notes'] as string[] | undefined) ?? []
  const quote = clock.computation['quote'] as string | undefined

  return (
    <div style={{ marginTop: 12, padding: 14, background: 'var(--surface-sunken)', borderRadius: 10, fontSize: 13 }}>
      {quote ? (
        <p style={{ margin: '0 0 10px', fontStyle: 'italic' }}>
          “{quote}” <span style={{ color: 'var(--ink-muted)' }}>— clause {clock.clauseNumber ?? 'cited'}</span>
        </p>
      ) : null}
      <p style={{ margin: '0 0 8px', color: 'var(--ink-muted)' }}>
        Started {new Date(clock.startedAt).toLocaleString()} · {String(clock.computation['timeZone'] ?? '')}
      </p>
      <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7, fontVariantNumeric: 'tabular-nums' }}>
        {steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      {notes.map((note) => (
        <p key={note} style={{ margin: '10px 0 0', color: 'var(--warn-ink, var(--ink-muted))' }}>
          {note}
        </p>
      ))}
    </div>
  )
}
