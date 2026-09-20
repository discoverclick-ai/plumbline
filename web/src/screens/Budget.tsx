import { useCallback, useEffect, useState } from 'react'
import type { BudgetLineView, CommitmentView, InvoiceView } from '../api/client.js'
import { ToolLandingPage } from '../layouts/index.js'
import { useSession } from '../session/SessionProvider.tsx'
import { Banner, Button, Card, Pill, Spinner, Table, Tabs } from '../ui/index.js'
import { BudgetSetup } from './BudgetSetup.tsx'
import { CostEntry } from './CostEntry.tsx'
import { NewCommitment } from './NewCommitment.tsx'

/**
 * The money.
 *
 * Every figure on this screen is computed by a database view, and the client
 * does no arithmetic at all. That is deliberate and it is the whole reason the
 * budget was built the way it was: the moment a screen adds two numbers
 * together to show a third, that screen has an opinion, and the next screen
 * will have a different one.
 *
 * Amounts stay strings the entire way through. Parsing them to render them
 * would undo the care taken in the database, because 0.1 is not representable
 * and a budget a cent out is a budget somebody stops trusting.
 */

/** Formats without parsing: group the integer part, keep the cents verbatim. */
export function formatMoney(amount: string | null): string {
  if (amount === null) return '—'
  const negative = amount.startsWith('-')
  const [whole = '0', cents = '00'] = (negative ? amount.slice(1) : amount).split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${negative ? '-' : ''}$${grouped}.${cents.padEnd(2, '0').slice(0, 2)}`
}

/** Negative means over budget, which is the only direction anybody reacts to. */
function overUnderTone(amount: string): 'danger' | 'warn' | 'neutral' {
  if (amount.startsWith('-')) return 'danger'
  return Number(amount) === 0 ? 'warn' : 'neutral'
}

/**
 * Trailing zeros go only AFTER a decimal point. An earlier version stripped
 * them unconditionally, which turned the string "0" into the empty string and
 * put a blank where a quantity of nothing belonged.
 */
export function trimZeros(value: string): string {
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value
}

function quantity(value: string | null, unit: string | null): string {
  if (value === null) return '—'
  const trimmed = trimZeros(value)
  return unit ? `${trimmed} ${unit}` : trimmed
}

export function Budget({ projectId, projectName }: { projectId: string; projectName: string }) {
  const { api } = useSession()
  const [tab, setTab] = useState<'budget' | 'commitments'>('budget')
  const [lines, setLines] = useState<BudgetLineView[]>([])
  const [costsVisible, setCostsVisible] = useState(true)
  const [commitments, setCommitments] = useState<CommitmentView[] | null>([])
  const [openLine, setOpenLine] = useState<string | null>(null)
  const [openCommitment, setOpenCommitment] = useState<CommitmentView | null>(null)
  const [editing, setEditing] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)
  const setBilling = (row: CommitmentView): void =>
    setOpenCommitment((current) => (current?.commitmentId === row.commitmentId ? null : row))
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    Promise.all([
      api.budget(projectId),
      // A refusal is not an empty list. "Nothing committed on this job yet"
      // told to somebody who simply may not see the contracts is a lie, and
      // on a job with four signed subcontracts it is an alarming one.
      api.commitments(projectId).catch(() => ({ commitments: null })),
    ])
      .then(([budget, committed]) => {
        if (cancelled) return
        setLines(budget.lines)
        setCostsVisible(budget.costsVisible)
        setCommitments(committed.commitments as CommitmentView[] | null)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          // The common case here is not a bug, it is a permission: most people
          // on a job may not see cost figures, and saying so plainly is more
          // useful than an empty table.
          setError(err instanceof Error ? err.message : 'Could not load the budget')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [api, projectId, reloadToken])

  const overBudget = lines.filter((line) => line.projectedOverUnder?.startsWith('-'))
  // Looked up rather than held, so a reload cannot leave the open panel
  // showing figures the table has already moved past. A stale panel is how
  // the same cost gets entered twice, which is the one mistake this whole
  // thing exists to prevent.
  const openLineRow = lines.find((line) => line.budgetLineId === openLine) ?? null

  return (
    <ToolLandingPage
      title="Budget"
      subtitle={projectName}
      tabs={
        <Tabs
          active={tab}
          onSelect={(key) => setTab(key as 'budget' | 'commitments')}
          tabs={[
            { key: 'budget', label: 'Budget' },
            ...(commitments === null ? [] : [{ key: 'commitments', label: 'Commitments', badge: commitments.length }]),
          ]}
        />
      }
      banner={
        error ? (
          <Banner tone="danger">{error}</Banner>
        ) : !costsVisible ? (
          // Said plainly rather than shown as an empty column. A screen full
          // of dashes reads as a job with no numbers on it, which is a very
          // different and more alarming thing than not being cleared to see
          // them.
          <Banner tone="accent">
            You can see the scope and the quantities on this job. Cost figures are not part of your access.
          </Banner>
        ) : overBudget.length > 0 ? (
          <Banner tone="danger">
            {overBudget.length} {overBudget.length === 1 ? 'line is' : 'lines are'} projected over budget.
          </Banner>
        ) : undefined
      }
    >
      <Card
        actions={
          // Only where cost figures are visible. Somebody who may see the
          // scope and not the money has no business setting the money.
          costsVisible ? (
            <Button variant="ghost" onClick={() => setEditing((on) => !on)}>
              {editing ? 'Done' : tab === 'budget' ? 'Add a line' : 'New commitment'}
            </Button>
          ) : undefined
        }
      >
        {editing && tab === 'budget' ? (
          <BudgetSetup projectId={projectId} onAdded={() => setReloadToken((n) => n + 1)} />
        ) : null}
        {editing && tab === 'commitments' ? (
          <NewCommitment projectId={projectId} onCreated={() => setReloadToken((n) => n + 1)} />
        ) : null}
        {loading ? (
          <Spinner label="Loading the budget" />
        ) : tab === 'budget' || commitments === null ? (
          <Table
            rows={lines}
            rowKey={(row) => row.budgetLineId}
            // Opening a line is how cost gets entered by hand. Not every
            // dollar on a job arrives through a record the posting worker can
            // read: a T&M ticket settled in the field, a rental, a figure
            // carried across mid-job. With no way in, the actual column stays
            // wrong and every projection built on it is wrong too.
            {...(costsVisible
              ? {
                  onRowClick: (row: BudgetLineView) =>
                    setOpenLine((current) => (current === row.budgetLineId ? null : row.budgetLineId)),
                }
              : {})}
            empty={
              <p style={{ margin: 0, color: 'var(--ink-muted)' }}>
                No budget lines yet. A line is a budget code with a number against it.
              </p>
            }
            columns={[
              {
                key: 'code',
                header: 'Budget Code',
                width: '180px',
                render: (row) => (
                  <>
                    <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{row.budgetCode}</strong>
                    <div style={{ fontSize: 12, color: 'var(--ink-muted)' }}>{row.description}</div>
                  </>
                ),
              },
              ...(costsVisible
                ? [
                    {
                      key: 'original',
                      header: 'Original',
                      width: '130px',
                      secondary: true,
                      render: (row: BudgetLineView) => <Money value={row.originalAmount} />,
                    },
                  ]
                : [
                    {
                      key: 'quantity',
                      header: 'Quantity',
                      width: '150px',
                      render: (row: BudgetLineView) =>
                        // Most lines are a lump sum with no units on them at
                        // all, and "0 of —" is worse than saying so.
                        row.originalQuantity === null ? (
                          <span style={{ display: 'block', textAlign: 'right', color: 'var(--ink-faint)' }}>
                            not tracked by unit
                          </span>
                        ) : (
                          <span style={{ display: 'block', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                            {quantity(row.quantityToDate, row.unitOfMeasure)}
                            <span style={{ color: 'var(--ink-faint)' }}>
                              {' of '}
                              {quantity(row.originalQuantity, row.unitOfMeasure)}
                            </span>
                          </span>
                        ),
                    },
                  ]),
              ...(costsVisible
                ? ([
                    {
                      key: 'revisions',
                      header: 'Revisions',
                      width: '130px',
                      secondary: true,
                      render: (row: BudgetLineView) =>
                        Number(row.approvedRevisions ?? 0) === 0 ? (
                          <span style={{ color: 'var(--ink-faint)' }}>&mdash;</span>
                        ) : (
                          <Money value={row.approvedRevisions} />
                        ),
                    },
                    {
                      key: 'current',
                      header: 'Current Budget',
                      width: '140px',
                      render: (row: BudgetLineView) => <Money value={row.currentBudget} strong />,
                    },
                    {
                      key: 'committed',
                      header: 'Committed',
                      width: '140px',
                      render: (row: BudgetLineView) => <Money value={row.committedCost} />,
                    },
                    {
                      key: 'actual',
                      header: 'Actual',
                      width: '130px',
                      secondary: true,
                      render: (row: BudgetLineView) => <Money value={row.actualCost} />,
                    },
                    {
                      key: 'projected',
                      header: 'Projected',
                      width: '140px',
                      render: (row: BudgetLineView) => <Money value={row.projectedCost} />,
                    },
                    {
                      key: 'variance',
                      header: 'Over / Under',
                      width: '150px',
                      render: (row: BudgetLineView) => (
                        <Pill tone={overUnderTone(row.projectedOverUnder ?? '0')}>
                          {formatMoney(row.projectedOverUnder)}
                        </Pill>
                      ),
                    },
                  ] as const)
                : []),
            ]}
          />
        ) : (
          <Table
            rows={commitments ?? []}
            rowKey={(row) => row.commitmentId}
            empty={
              <p style={{ margin: 0, color: 'var(--ink-muted)' }}>
                Nothing committed on this job yet.
              </p>
            }
            columns={[
              {
                key: 'number',
                header: 'Number',
                width: '130px',
                render: (row) => <strong>{row.number}</strong>,
              },
              {
                key: 'title',
                header: 'Scope',
                render: (row) => (
                  <>
                    <div>{row.title}</div>
                    <div style={{ fontSize: 12, color: 'var(--ink-muted)' }}>
                      {row.kind === 'subcontract' ? 'Subcontract' : 'Purchase order'}
                      {Number(row.retainagePercent) > 0 ? ` · ${row.retainagePercent}% retainage` : ''}
                    </div>
                  </>
                ),
              },
              {
                key: 'status',
                header: 'Status',
                width: '160px',
                render: (row) => (
                  // An unsigned contract counts for nothing, and the screen
                  // says so rather than showing a number that looks committed.
                  <Pill tone={row.status === 'executed' ? 'neutral' : 'warn'}>
                    {row.status.replace(/_/g, ' ')}
                  </Pill>
                ),
              },
              {
                key: 'original',
                header: 'Original',
                width: '140px',
                secondary: true,
                render: (row) => <Money value={row.originalValue} />,
              },
              {
                key: 'changes',
                header: 'Changes',
                width: '130px',
                secondary: true,
                render: (row) =>
                  Number(row.executedChanges) === 0 ? (
                    <span style={{ color: 'var(--ink-faint)' }}>&mdash;</span>
                  ) : (
                    <Money value={row.executedChanges} />
                  ),
              },
              {
                key: 'current',
                header: 'Current Value',
                width: '150px',
                render: (row) => <Money value={row.currentValue} strong />,
              },
              {
                key: 'billing',
                header: '',
                width: '120px',
                render: (row) => (
                  <Button variant="ghost" onClick={() => setBilling(row)}>
                    {openCommitment?.commitmentId === row.commitmentId ? 'Hide billing' : 'Billing'}
                  </Button>
                ),
              },
            ]}
          />
        )}
      </Card>

      {openLineRow ? (
        <Card title={`${openLineRow.budgetCode} · ${openLineRow.description}`}>
          <CostEntry
            projectId={projectId}
            line={openLineRow}
            onRecorded={() => setReloadToken((n) => n + 1)}
          />
        </Card>
      ) : null}

      {openCommitment ? (
        <Billing
          commitment={openCommitment}
          costsVisible={costsVisible}
          onChanged={() => {
            // Refresh the commitment figures, NOT the panel. An earlier
            // version called the toggle here, so approving an application
            // closed the screen you were working on.
            void api.commitments(projectId).then((r) => setCommitments(r.commitments))
          }}
        />
      ) : null}
    </ToolLandingPage>
  )
}

const INVOICE_TONE: Record<string, 'neutral' | 'warn' | 'ok' | 'danger'> = {
  draft: 'neutral',
  submitted: 'warn',
  under_review: 'warn',
  approved: 'ok',
  paid: 'ok',
  rejected: 'danger',
  void: 'neutral',
}

/**
 * The pay application cycle, against one commitment.
 *
 * A general contractor's month IS this screen: what was billed, what is held
 * back, whether the lien waiver arrived, and whether it can be paid. The
 * whole subsystem had no client at all, which meant every invoice in the
 * product had to be driven by curl.
 *
 * The two rules that matter are both the server's and both shown rather than
 * enforced here: money is never recomputed in this client, and paying before
 * the lien waiver is recorded is refused. The button is disabled with the
 * reason next to it rather than hidden, because a missing button teaches
 * nobody what to go and get.
 */
function Billing({
  commitment,
  costsVisible,
  onChanged,
}: {
  commitment: CommitmentView
  costsVisible: boolean
  onChanged: () => void
}) {
  const { api } = useSession()
  const [invoices, setInvoices] = useState<InvoiceView[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback((): void => {
    api
      .invoices(commitment.commitmentId)
      .then((r) => setInvoices(r.invoices))
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not load the billing')
        setInvoices([])
      })
  }, [api, commitment.commitmentId])

  useEffect(reload, [reload])

  async function act(invoice: InvoiceView, what: 'submit' | 'approve' | 'waiver' | 'pay'): Promise<void> {
    setBusy(invoice.invoiceId)
    setError(null)
    try {
      if (what === 'submit') await api.submitInvoice(invoice.invoiceId)
      else if (what === 'approve') await api.approveInvoice(invoice.invoiceId)
      else if (what === 'waiver') await api.recordLienWaiver(invoice.invoiceId)
      else await api.payInvoice(invoice.invoiceId)
      reload()
      onChanged()
    } catch (err) {
      // The server's refusal, verbatim. It knows why — an unsigned
      // commitment, a missing waiver, a step out of order — and paraphrasing
      // it here would produce two explanations that drift apart.
      setError(err instanceof Error ? err.message : 'That did not go through')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card title={`Billing · ${commitment.number} ${commitment.title}`}>
      {error ? <Banner tone="danger">{error}</Banner> : null}
      {invoices === null ? (
        <Spinner label="Loading the billing" />
      ) : (
        <Table
          rows={invoices}
          rowKey={(row) => row.invoiceId}
          empty={
            <p style={{ margin: 0, color: 'var(--ink-muted)' }}>
              Nothing billed against this commitment yet.
            </p>
          }
          columns={[
            {
              key: 'number',
              header: 'Application',
              width: '150px',
              render: (row: InvoiceView) => (
                <>
                  <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{row.number}</strong>
                  <div style={{ fontSize: 12, color: 'var(--ink-muted)' }}>
                    {row.periodStart.slice(0, 10)} to {row.periodEnd.slice(0, 10)}
                  </div>
                </>
              ),
            },
            {
              key: 'status',
              header: 'Status',
              width: '140px',
              render: (row: InvoiceView) => (
                <Pill tone={INVOICE_TONE[row.status] ?? 'neutral'}>{row.status.replace(/_/g, ' ')}</Pill>
              ),
            },
            ...(costsVisible
              ? ([
                  {
                    key: 'billed',
                    header: 'This period',
                    width: '140px',
                    render: (row: InvoiceView) => <Money value={row.billedThisPeriod} />,
                  },
                  {
                    key: 'retainage',
                    header: 'Retainage held',
                    width: '150px',
                    secondary: true,
                    render: (row: InvoiceView) => <Money value={row.retainageWithheld} />,
                  },
                  {
                    key: 'due',
                    header: 'Due',
                    width: '140px',
                    render: (row: InvoiceView) => <Money value={row.amountDue} strong />,
                  },
                ] as const)
              : []),
            {
              key: 'waiver',
              header: 'Lien waiver',
              width: '140px',
              render: (row: InvoiceView) =>
                row.lienWaiverReceived ? (
                  <Pill tone="ok">Received</Pill>
                ) : (
                  <Button variant="ghost" onClick={() => void act(row, 'waiver')} disabled={busy === row.invoiceId}>
                    Record it
                  </Button>
                ),
            },
            {
              key: 'act',
              header: '',
              width: '200px',
              render: (row: InvoiceView) => (
                <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                  {row.status === 'draft' ? (
                    <Button onClick={() => void act(row, 'submit')} disabled={busy === row.invoiceId}>
                      Submit
                    </Button>
                  ) : null}
                  {row.status === 'submitted' || row.status === 'under_review' ? (
                    <Button onClick={() => void act(row, 'approve')} disabled={busy === row.invoiceId}>
                      Approve
                    </Button>
                  ) : null}
                  {row.status === 'approved' ? (
                    <Button
                      onClick={() => void act(row, 'pay')}
                      // Disabled with the reason beside it rather than hidden.
                      // A missing button teaches nobody what to go and get.
                      disabled={busy === row.invoiceId || !row.lienWaiverReceived}
                      title={row.lienWaiverReceived ? undefined : 'The lien waiver has not been recorded'}
                    >
                      Pay
                    </Button>
                  ) : null}
                </div>
              ),
            },
          ]}
        />
      )}
    </Card>
  )
}

/** Tabular numerals, right aligned. Money in a proportional font is unreadable in a column. */
function Money({ value, strong }: { value: string | null; strong?: boolean }) {
  return (
    <span
      style={{
        display: 'block',
        textAlign: 'right',
        fontVariantNumeric: 'tabular-nums',
        fontWeight: strong ? 600 : 400,
      }}
    >
      {formatMoney(value)}
    </span>
  )
}
