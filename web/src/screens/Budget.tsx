import { useEffect, useState } from 'react'
import type { BudgetLineView, CommitmentView } from '../api/client.js'
import { ToolLandingPage } from '../layouts/index.js'
import { useSession } from '../session/SessionProvider.tsx'
import { Banner, Card, Pill, Spinner, Table, Tabs } from '../ui/index.js'

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
  }, [api, projectId])

  const overBudget = lines.filter((line) => line.projectedOverUnder?.startsWith('-'))

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
      <Card>
        {loading ? (
          <Spinner label="Loading the budget" />
        ) : tab === 'budget' || commitments === null ? (
          <Table
            rows={lines}
            rowKey={(row) => row.budgetLineId}
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
            ]}
          />
        )}
      </Card>
    </ToolLandingPage>
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
