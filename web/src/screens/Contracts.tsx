import { useEffect, useMemo, useState } from 'react'
import type {
  ClauseView,
  ClockView,
  ContractDocumentView,
  ObligationView,
  StatutoryClockView,
  StatutoryEventKind,
  StatutoryEventView,
  StatutoryRuleView,
} from '../api/client.js'
import { ToolLandingPage } from '../layouts/index.js'
import { useSession } from '../session/SessionProvider.tsx'
import { Banner, Button, Card, EmptyState, Input, Pill, Select, Spinner, Table, Tabs } from '../ui/index.js'
import { UploadPanel } from './UploadPanel.tsx'

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
  const [tab, setTab] = useState<'clocks' | 'statutory' | 'profile'>('clocks')
  const [statutory, setStatutory] = useState<StatutoryClockView[] | null>([])
  const [documents, setDocuments] = useState<ContractDocumentView[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [clauses, setClauses] = useState<ClauseView[]>([])
  const [obligations, setObligations] = useState<ObligationView[]>([])
  const [clocks, setClocks] = useState<ClockView[] | null>([])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [readReport, setReadReport] = useState<string | null>(null)
  const [statutoryRules, setStatutoryRules] = useState<StatutoryRuleView[]>([])

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
      api.statutoryClocks(projectId).catch(() => ({ clocks: null })),
      api.statutoryRules(projectId).catch(() => ({ rules: [] })),
    ])
      .then(([docs, running, statute, applicable]) => {
        if (cancelled) return
        setDocuments(docs.documents)
        setClocks(running.clocks as ClockView[] | null)
        setStatutory(statute.clocks as StatutoryClockView[] | null)
        setStatutoryRules(applicable.rules)
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
          onSelect={(key) => setTab(key as 'clocks' | 'statutory' | 'profile')}
          tabs={[
            ...(clocks === null ? [] : [{ key: 'clocks', label: 'Clocks', badge: running.length }]),
            // Shown even with nothing running: the form that starts these
            // lives here, so hiding the tab until a clock exists makes the
            // whole subsystem unreachable.
            ...(statutory === null ? [] : [{ key: 'statutory', label: 'Lien & bond', badge: statutory.length }]),
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
      ) : tab === 'statutory' && statutory !== null ? (
        <>
          <StatutoryFacts
            projectId={projectId}
            onSwept={() => void api.statutoryClocks(projectId).then((r) => setStatutory(r.clocks))}
          />
          {/*
            The three triggers this product cannot see for itself. Without
            somewhere to type them, every rule hanging off a recorded lien, a
            served termination or a payment falling due was skipped with a
            reason the customer could read and could not act on.
          */}
          <StatutoryEvents
            projectId={projectId}
            onRecorded={() => void api.statutoryClocks(projectId).then((r) => setStatutory(r.clocks))}
          />
          <StatutoryClocks clocks={statutory} rules={statutoryRules} />
        </>
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
                width: '270px',
                render: (row) => (
                  <div style={{ display: 'flex', gap: 4 }}>
                    <Button variant="ghost" onClick={() => setExpanded(expanded === row.id ? null : row.id)}>
                      {expanded === row.id ? 'Hide' : 'Show work'}
                    </Button>
                    {/*
                      "Draft", never "Send". The drafter writes the letter into
                      the notice record and stops; the record does not move
                      state, and there is no send button anywhere on this
                      screen. An agent may draft anything here and serve
                      nothing.
                    */}
                    {row.noticeRecordId ? (
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setBusy(`draft-${row.id}`)
                          setError(null)
                          api
                            .draftNotice(row.id)
                            .then((drafted) => {
                              if (drafted.missing.length > 0) {
                                // The gaps go in front of the person, not in a
                                // log. A drafted notice missing its addressee
                                // is one somebody sends incomplete.
                                setError(`Drafted into ${row.noticeDesignation}. Still missing: ${drafted.missing[0]}`)
                              }
                            })
                            .catch((err: unknown) =>
                              setError(err instanceof Error ? err.message : 'The draft could not be written'),
                            )
                            .finally(() => setBusy(null))
                        }}
                        disabled={busy === `draft-${row.id}`}
                      >
                        {busy === `draft-${row.id}` ? 'Drafting…' : 'Draft'}
                      </Button>
                    ) : null}
                    {/*
                      Offered on every clock, not only the expired ones. The
                      point of assembling the file continuously is seeing the
                      holes while there is still time to close them.
                    */}
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setBusy(row.id)
                        setError(null)
                        api
                          .claimFileMarkdown(row.id)
                          .then(({ text, filename }) => {
                            const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }))
                            const anchor = document.createElement('a')
                            anchor.href = url
                            anchor.download = filename
                            anchor.click()
                            URL.revokeObjectURL(url)
                          })
                          .catch((err: unknown) =>
                            setError(err instanceof Error ? err.message : 'The claim file could not be assembled'),
                          )
                          .finally(() => setBusy(null))
                      }}
                      disabled={busy === row.id}
                    >
                      {busy === row.id ? 'Assembling…' : 'Claim file'}
                    </Button>
                  </div>
                ),
              },
            ]}
          />
          {expanded ? <Computation clock={(clocks ?? []).find((c) => c.id === expanded)!} /> : null}
        </Card>
      ) : (
        <>
          {/*
            Upload and segment in one action. Two buttons would leave
            documents sitting in 'uploaded' forever, because segmenting is
            not a thing anybody would think to go back and do.
          */}
          <UploadPanel
            title="Add an instrument"
            description="The contract as text. It is cut into citable clauses immediately; nothing is read by a model until somebody asks for it."
            accept=".txt,.md,text/plain"
            nameLabel="Title"
            namePlaceholder="Owner Prime Contract"
            kinds={Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label }))}
            onUpload={async ({ name, kind, text }) => {
              const created = await api.createContract(projectId, { kind, title: name })
              const segmented = await api.segmentContract(created.id, text)
              const refreshed = await api.contracts(projectId)
              setDocuments(refreshed.documents)
              setSelected(created.id)

              return segmented.needsManualSegmentation
                ? {
                    ok: false,
                    // Said plainly rather than stored as a confident carve-up.
                    // A document segmented badly is an invisible gap; one
                    // nobody segmented is a visible one.
                    headline: 'The clause numbering could not be read, so nothing was segmented.',
                    detail: segmented.reason ? [segmented.reason] : [],
                  }
                : {
                    ok: true,
                    headline: `${segmented.clauses.length} clauses, numbered ${segmented.scheme ?? 'unknown'}-style.`,
                    detail: [],
                  }
            }}
          />

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
            <Card
              title={`Obligations · ${accepted.length} accepted, ${proposed.length} waiting`}
              actions={
                <Button
                  onClick={() => {
                    setBusy('profile')
                    setError(null)
                    setReadReport(null)
                    api
                      .profileContract(selected)
                      .then((r) => {
                        setReadReport(
                          `Read ${r.clausesScreened} clauses, looked closely at ${r.candidates}, proposed ${r.proposed}.` +
                            (r.discarded.length > 0
                              ? ` ${r.discarded.length} discarded: the quote was not in the clause.`
                              : ''),
                        )
                        return api.obligations(selected)
                      })
                      .then((o) => setObligations(o.obligations))
                      .catch((err: unknown) =>
                        setError(err instanceof Error ? err.message : 'The contract could not be read'),
                      )
                      .finally(() => setBusy(null))
                  }}
                  disabled={busy === 'profile'}
                >
                  {busy === 'profile' ? 'Reading…' : 'Read this contract'}
                </Button>
              }
            >
              {/*
                The discard count is shown, not hidden. It is the number that
                says the citation gate is doing its job, and a reviewer who
                never sees it has no reason to believe the quotes in front of
                them were checked at all.
              */}
              {readReport ? (
                <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--ink-muted)' }}>{readReport}</p>
              ) : null}
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

/**
 * Lien and bond deadlines.
 *
 * Separate from the contract clocks because they are a different animal:
 * missing a contract deadline waives a claim you might have won, missing one
 * of these removes the security for money already earned and spent.
 *
 * Every row carries the statute it rests on and the name of whoever verified
 * it against the current text, because a deadline a contractor's attorney can
 * look up in thirty seconds is one they will act on, and one they cannot is
 * one they will ignore.
 */
/**
 * The dates that start a lien clock.
 *
 * Three of them and none is optional: where the job is, what kind of work it
 * is, and where this company sits in the chain ON THIS JOB. The same
 * contractor is a general contractor on one job and a second tier sub on the
 * next, and the deadline is different for each; defaulting any of the three
 * would be guessing at the answer that matters most.
 *
 * Saving sweeps immediately. A date typed into a form and a deadline
 * appearing on a screen should be one action: making somebody press a second
 * button is how a lien window gets recorded and never watched.
 */
function StatutoryFacts({ projectId, onSwept }: { projectId: string; onSwept: () => void }) {
  const { api } = useSession()
  const [jurisdiction, setJurisdiction] = useState('')
  const [role, setRole] = useState('general_contractor')
  const [projectType, setProjectType] = useState('private')
  const [firstFurnishing, setFirstFurnishing] = useState('')
  const [lastFurnishing, setLastFurnishing] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ started: number; skipped: { citation: string; reason: string }[]; unverified: { citation: string; summary: string }[] } | null>(null)
  const [error, setError] = useState<string | null>(null)

  return (
    <Card title="Where this job is, and where you sit on it">
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--ink-muted)' }}>
          Jurisdiction
          <Input value={jurisdiction} onChange={setJurisdiction} placeholder="CO, or US-MILLER for federal work" />
        </label>
        <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--ink-muted)' }}>
          Your role on this job
          <Select
            value={role}
            onChange={setRole}
            placeholder="General contractor"
            options={[
              { value: 'general_contractor', label: 'General contractor' },
              { value: 'first_tier_subcontractor', label: 'First tier subcontractor' },
              { value: 'second_tier_subcontractor', label: 'Second tier subcontractor' },
              { value: 'supplier_to_gc', label: 'Supplier to the GC' },
              { value: 'supplier_to_sub', label: 'Supplier to a sub' },
              { value: 'design_professional', label: 'Design professional' },
              { value: 'equipment_lessor', label: 'Equipment lessor' },
            ]}
          />
        </label>
        <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--ink-muted)' }}>
          Work
          <Select
            value={projectType}
            onChange={setProjectType}
            placeholder="Private"
            options={[
              { value: 'private', label: 'Private' },
              { value: 'public', label: 'Public' },
              { value: 'federal', label: 'Federal' },
            ]}
          />
        </label>
        <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--ink-muted)' }}>
          First furnishing
          <Input value={firstFurnishing} onChange={setFirstFurnishing} placeholder="2026-03-02" />
        </label>
        <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--ink-muted)' }}>
          Last furnishing
          <Input value={lastFurnishing} onChange={setLastFurnishing} placeholder="2026-09-30" />
        </label>
        <Button
          disabled={busy || jurisdiction.trim() === ''}
          onClick={() => {
            setBusy(true)
            setError(null)
            api
              .setStatutoryFacts(projectId, {
                jurisdiction: jurisdiction.trim().toUpperCase(),
                projectType,
                claimantRole: role,
                ...(firstFurnishing ? { firstFurnishing } : {}),
                ...(lastFurnishing ? { lastFurnishing } : {}),
              })
              .then((r) => {
                setResult(r)
                onSwept()
              })
              .catch((err: unknown) => setError(err instanceof Error ? err.message : 'That did not save'))
              .finally(() => setBusy(false))
          }}
        >
          {busy ? 'Saving…' : 'Save and check'}
        </Button>
      </div>

      {error ? <Banner tone="danger">{error}</Banner> : null}

      {result ? (
        <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>
          <Banner tone="accent">
            {result.started === 0 ? 'No new deadlines started.' : `${result.started} deadlines now running.`}
          </Banner>
          {/*
            The unverified rules are the important half. An applicable rule
            nobody has checked against the statute is a deadline that exists
            whether or not this product knows the number, and a contractor who
            learns it exists has been given something worth having.
          */}
          {result.unverified.length > 0 ? (
            <Banner tone="warn">
              {result.unverified.length} {result.unverified.length === 1 ? 'deadline applies' : 'deadlines apply'} to
              this job that nobody has verified against the current statute, so no clock was started for
              {result.unverified.length === 1 ? ' it' : ' them'}. Have counsel confirm{' '}
              {result.unverified.map((u) => u.citation).join(', ')}.
            </Banner>
          ) : null}
          {result.skipped.length > 0 ? (
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: 'var(--ink-muted)' }}>
              {result.skipped.map((s) => (
                <li key={s.citation}>
                  {s.citation}: {s.reason}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </Card>
  )
}

const EVENT_KINDS: { value: StatutoryEventKind; label: string; hint: string }[] = [
  {
    value: 'lien_recorded',
    label: 'Lien recorded',
    hint: 'The date the county recorded it, which is what the statute counts from.',
  },
  {
    value: 'notice_of_termination',
    label: 'Notice of termination',
    hint: 'The date it was served, not the date it was drafted.',
  },
  {
    value: 'payment_due',
    label: 'Payment fell due',
    hint: 'Under the terms in your contract. This product cannot read them for you.',
  },
]

/**
 * The dates nothing here witnesses.
 *
 * Five of the eight statutory triggers are facts about the job and the job
 * knows them. These three are external acts: a clerk recording an instrument,
 * a notice served, a payment falling due under terms that live in a contract
 * this product did not write. Deriving any of them would be a guess, and a
 * guessed statutory deadline is worse than none — a contractor relies on it
 * and loses money they have already earned.
 *
 * Recording one sweeps immediately, for the same reason the facts form does:
 * a date typed in and a deadline appearing should be one action, because
 * making somebody press a second button is how a lien window gets recorded
 * and never watched.
 */
function StatutoryEvents({ projectId, onRecorded }: { projectId: string; onRecorded: () => void }) {
  const { api } = useSession()
  const [events, setEvents] = useState<StatutoryEventView[] | null>(null)
  const [kind, setKind] = useState<StatutoryEventKind>('lien_recorded')
  const [occurredOn, setOccurredOn] = useState('')
  const [reference, setReference] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .statutoryEvents(projectId)
      .then((r) => {
        if (!cancelled) setEvents(r.events)
      })
      .catch(() => {
        // Left null rather than emptied. "Nothing recorded" shown to somebody
        // whose request failed invites them to type a lien in twice.
        if (!cancelled) setError('Could not load what has already been recorded')
      })
    return () => {
      cancelled = true
    }
  }, [api, projectId, busy])

  return (
    <Card title="Dates this product cannot see for itself">
      <p style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--ink-muted)' }}>
        A lien recorded at the county, a notice served, a payment falling due. Nothing here witnesses any of these,
        so a deadline that runs from one of them starts when you say it did.
      </p>

      {error ? <Banner tone="danger">{error}</Banner> : null}

      {events && events.length > 0 ? (
        <Table
          rows={events}
          rowKey={(row) => row.id}
          columns={[
            {
              key: 'date',
              header: 'Happened',
              width: '120px',
              render: (row: StatutoryEventView) => (
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>{row.occurredOn}</span>
              ),
            },
            {
              key: 'kind',
              header: 'What',
              width: '190px',
              render: (row: StatutoryEventView) => (
                <>{EVENT_KINDS.find((k) => k.value === row.kind)?.label ?? row.kind.replace(/_/g, ' ')}</>
              ),
            },
            {
              key: 'reference',
              header: 'Reference',
              render: (row: StatutoryEventView) => (
                <>
                  <div>{row.reference || <span style={{ color: 'var(--ink-faint)' }}>None given</span>}</div>
                  {row.note ? (
                    <div style={{ fontSize: 12, color: 'var(--ink-muted)' }}>{row.note}</div>
                  ) : null}
                </>
              ),
            },
            {
              key: 'by',
              header: 'Recorded by',
              width: '150px',
              secondary: true,
              render: (row: StatutoryEventView) => <>{row.recordedBy ?? '—'}</>,
            },
          ]}
        />
      ) : null}

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 12 }}>
        <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--ink-muted)' }}>
          What happened
          <Select
            value={kind}
            onChange={(value) => setKind(value as StatutoryEventKind)}
            options={EVENT_KINDS.map((k) => ({ value: k.value, label: k.label }))}
          />
        </label>
        <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--ink-muted)' }}>
          Date it happened
          <Input value={occurredOn} onChange={setOccurredOn} type="date" />
        </label>
        <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--ink-muted)', flex: '1 1 220px' }}>
          Reference
          <Input value={reference} onChange={setReference} placeholder="Instrument 2026-0041882" />
        </label>
        <Button
          disabled={busy || occurredOn === ''}
          onClick={() => {
            setBusy(true)
            setError(null)
            api
              .recordStatutoryEvent(projectId, {
                kind,
                occurredOn,
                ...(reference.trim() ? { reference: reference.trim() } : {}),
              })
              // Sweeping here rather than behind a second button. A date typed
              // in and a deadline appearing on the screen are one action.
              .then(() => api.sweepStatutory(projectId))
              .then(() => {
                setOccurredOn('')
                setReference('')
                onRecorded()
              })
              .catch((err: unknown) => setError(err instanceof Error ? err.message : 'That date was refused'))
              .finally(() => setBusy(false))
          }}
        >
          {busy ? 'Recording…' : 'Record it'}
        </Button>
      </div>
      <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--ink-muted)' }}>
        {EVENT_KINDS.find((k) => k.value === kind)?.hint}
      </p>
    </Card>
  )
}

/**
 * The deadlines on this job, running or not.
 *
 * This card used to render an empty box, because the product ships with every
 * statutory rule unverified and an unverified rule starts no clock. Empty
 * reads as "no deadlines apply to this job", which is the most dangerous
 * sentence this subsystem could accidentally say: on federal work a first
 * tier subcontractor has ninety days to give bond notice whether or not this
 * product knows the number, and a contractor who reads a blank card and
 * relies on it loses money they have already earned.
 *
 * So the applicable statutes are named whether or not their arithmetic is
 * trusted. Telling somebody the deadline EXISTS is the valuable half even
 * when the number is withheld.
 */
function StatutoryClocks({ clocks, rules }: { clocks: StatutoryClockView[]; rules: StatutoryRuleView[] }) {
  const unverified = rules.filter((rule) => rule.verifiedAt === null)
  return (
    <Card title="Lien and bond deadlines">
      {clocks.length === 0 && rules.length === 0 ? (
        <p style={{ margin: 0, color: 'var(--ink-muted)' }}>
          Record the jurisdiction and your place in the contract chain above, and the statutes that reach this job
          will be listed here.
        </p>
      ) : null}

      {unverified.length > 0 ? (
        <Banner tone="warn">
          {unverified.length} {unverified.length === 1 ? 'deadline applies' : 'deadlines apply'} to this job that
          nobody has verified against the current statute, so no clock is running for
          {unverified.length === 1 ? ' it' : ' them'}. The deadline exists either way. Have counsel confirm the
          citations below and the clocks start.
        </Banner>
      ) : null}

      {unverified.length > 0 ? (
        <div style={{ display: 'grid', gap: 10, marginBottom: 10 }}>
          {unverified.map((rule) => (
            <article
              key={rule.citation}
              style={{
                border: '1px dashed var(--line-strong)',
                borderRadius: 10,
                padding: 12,
                background: 'var(--surface-sunken)',
              }}
            >
              <header style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
                <strong>{rule.deadlineType.replace(/_/g, ' ')}</strong>
                <Pill tone="warn">not verified</Pill>
              </header>
              <p style={{ margin: '6px 0 0', fontSize: 13 }}>{rule.summary}</p>
              <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--danger)' }}>{rule.consequence}</p>
              <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--ink-muted)' }}>{rule.citation}</p>
            </article>
          ))}
        </div>
      ) : null}

      <div style={{ display: 'grid', gap: 10 }}>
        {clocks.map((clock) => {
          const days = Math.round((Date.parse(`${clock.dueOn}T00:00:00Z`) - Date.now()) / 86_400_000)
          return (
            <article
              key={clock.id}
              style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 12 }}
            >
              <header style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
                <strong>{clock.deadlineType.replace(/_/g, ' ')}</strong>
                <Pill tone={days <= 0 ? 'danger' : days <= 30 ? 'warn' : 'neutral'}>
                  {days <= 0 ? 'Passed' : `${days} days left`} · {clock.dueOn}
                </Pill>
              </header>
              <p style={{ margin: '6px 0 0', fontSize: 13 }}>{clock.summary}</p>
              {/* What it costs, in the contractor's own terms, not in
                  statutory language. */}
              <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--danger)' }}>{clock.consequence}</p>
              <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--ink-muted)' }}>
                {clock.citation}
                {clock.computation['verifiedBy'] ? ` · verified by ${String(clock.computation['verifiedBy'])}` : ''}
                {' · running from '}
                {clock.startedOn} ({clock.triggeredBy.replace(/_/g, ' ')})
                {/* "Why does this say the 9th of July" has to have an answer,
                    and for a trigger somebody typed the answer is the thing
                    they typed. */}
                {clock.sourceEvent?.reference ? ` · ${clock.sourceEvent.reference}` : ''}
              </p>
            </article>
          )
        })}
      </div>
    </Card>
  )
}
