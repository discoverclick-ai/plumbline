import { useCallback, useEffect, useState } from 'react'
import type { BudgetLineView, CostEntryView } from '../api/client.js'
import { useSession } from '../session/SessionProvider.tsx'
import { Banner, Button, Input, Pill, Select, Spinner, Table } from '../ui/index.js'
import { formatMoney, trimZeros } from './Budget.tsx'

/**
 * Putting a cost against a line by hand.
 *
 * Most cost lands here without anybody typing it: the posting worker writes
 * entries off invoices and commitments as they are approved. But not every
 * dollar on a job arrives through a record. A T&M ticket settled in the
 * field, an equipment rental, a figure carried across from the accounting
 * system mid-job. With no way to enter those, the actual column stays wrong,
 * and a projection built on a wrong actual is worse than no projection.
 *
 * The list comes FIRST and the form is underneath it, which is the whole
 * design of this panel. The budget line says $300,000 actual; that total
 * cannot tell a project manager whether the invoice in their hand is already
 * one of those dollars. Showing the entries, each one saying where it came
 * from, is what stops the same invoice being entered twice — and a double
 * entry is not a typo somebody spots, it is a job that looks over budget
 * until an accountant unpicks it three weeks later.
 */

/** What each kind actually means, in the words a PM would use. */
const KINDS: { value: CostEntryView['kind']; label: string; hint: string }[] = [
  { value: 'actual', label: 'Actual', hint: 'Money spent. An invoice paid, a ticket settled.' },
  { value: 'committed', label: 'Committed', hint: 'Money promised. Usually a subcontract or a PO.' },
  { value: 'pending', label: 'Pending', hint: 'Money likely. A change not yet approved.' },
  { value: 'forecast', label: 'Forecast', hint: 'Your estimate of what is still to come.' },
]

function kindTone(kind: CostEntryView['kind']): 'neutral' | 'accent' | 'warn' {
  if (kind === 'actual') return 'neutral'
  return kind === 'pending' || kind === 'forecast' ? 'warn' : 'accent'
}

export function CostEntry({
  projectId,
  line,
  onRecorded,
}: {
  projectId: string
  line: BudgetLineView
  onRecorded: () => void
}) {
  const { api } = useSession()
  const [entries, setEntries] = useState<CostEntryView[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [kind, setKind] = useState<CostEntryView['kind']>('actual')
  const [amount, setAmount] = useState('')
  const [quantity, setQuantity] = useState('')
  const [incurredOn, setIncurredOn] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(() => {
    setFailed(false)
    api
      .costs(projectId, line.budgetCodeId)
      .then((r) => setEntries(r.entries))
      .catch((err: unknown) => {
        // NOT an empty list. Setting entries to [] here renders "Nothing
        // recorded against this code yet", which is the exact lie this panel
        // exists to prevent: it invites a second entry of a cost that is
        // already there. A failed load has to look like a failed load.
        setError(err instanceof Error ? err.message : 'Could not load what is already recorded')
        setEntries(null)
        setFailed(true)
      })
  }, [api, projectId, line.budgetCodeId])

  useEffect(reload, [reload])

  // A quantity only means something on a line bought by the unit. Asking for
  // one on a lump sum invites a number with no unit attached, which is how
  // "240" ends up in a column nobody can read.
  const tracksUnits = line.unitOfMeasure !== null

  const posted = (entries ?? []).filter((e) => e.posted)

  return (
    <div style={{ padding: 12, background: 'var(--surface-sunken)', borderRadius: 8 }}>
      {error ? <Banner tone="danger">{error}</Banner> : null}

      {posted.length > 0 ? (
        // Said before they type, not after they submit. By the time a
        // duplicate is in, unpicking it is an accounting job.
        <Banner tone="accent">
          {posted.length} of these {posted.length === 1 ? 'was' : 'were'} posted automatically from a record on this
          job. Those keep themselves current, so do not enter them again.
        </Banner>
      ) : null}

      {entries === null ? (
        failed ? (
          // The form stays below, because somebody may genuinely need to
          // record a cost while this is broken. What they do not get is a
          // screen implying there is nothing here.
          <p style={{ margin: 0, color: 'var(--ink-muted)' }}>
            Could not load what is already recorded against {line.budgetCode}. Check before you add another.
          </p>
        ) : (
          <Spinner label="Loading what is already recorded" />
        )
      ) : (
        <Table
          rows={entries}
          rowKey={(row) => row.id}
          empty={
            <p style={{ margin: 0, color: 'var(--ink-muted)' }}>
              Nothing recorded against {line.budgetCode} yet.
            </p>
          }
          columns={[
            {
              key: 'date',
              header: 'Incurred',
              width: '120px',
              secondary: true,
              render: (row: CostEntryView) => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{row.incurredOn}</span>,
            },
            {
              key: 'kind',
              header: 'Kind',
              width: '110px',
              render: (row: CostEntryView) => <Pill tone={kindTone(row.kind)}>{row.kind}</Pill>,
            },
            {
              key: 'what',
              header: 'What',
              render: (row: CostEntryView) => (
                <>
                  <div>{row.description || <span style={{ color: 'var(--ink-faint)' }}>No description</span>}</div>
                  <div style={{ fontSize: 12, color: 'var(--ink-muted)' }}>
                    {/* Where it came from, which is the only thing that tells
                        a reader whether it is theirs to touch. */}
                    {row.source
                      ? `From ${row.source}`
                      : row.posted
                        ? 'Posted automatically'
                        : row.enteredBy
                          ? `Entered by ${row.enteredBy}`
                          : 'Entered by hand'}
                  </div>
                </>
              ),
            },
            {
              key: 'quantity',
              header: 'Quantity',
              width: '110px',
              secondary: true,
              render: (row: CostEntryView) =>
                row.quantity === null ? (
                  <span style={{ display: 'block', textAlign: 'right', color: 'var(--ink-faint)' }}>&mdash;</span>
                ) : (
                  <span style={{ display: 'block', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    {trimZeros(row.quantity)} {line.unitOfMeasure ?? ''}
                  </span>
                ),
            },
            {
              key: 'amount',
              header: 'Amount',
              width: '130px',
              render: (row: CostEntryView) => (
                <span style={{ display: 'block', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  {formatMoney(row.amount)}
                </span>
              ),
            },
          ]}
        />
      )}

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 12 }}>
        <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--ink-muted)' }}>
          Kind
          <Select
            value={kind}
            onChange={(value) => setKind(value as CostEntryView['kind'])}
            options={KINDS.map((k) => ({ value: k.value, label: k.label }))}
          />
        </label>
        <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--ink-muted)' }}>
          Amount
          <Input value={amount} onChange={setAmount} placeholder="18400.00" />
        </label>
        {tracksUnits ? (
          <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--ink-muted)' }}>
            Quantity ({line.unitOfMeasure})
            <Input value={quantity} onChange={setQuantity} placeholder="240.5" />
          </label>
        ) : null}
        <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--ink-muted)' }}>
          Incurred on
          <Input value={incurredOn} onChange={setIncurredOn} placeholder="Today" type="date" />
        </label>
        <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--ink-muted)', flex: '1 1 200px' }}>
          What it was for
          <Input value={description} onChange={setDescription} placeholder="T&M ticket 114, Saturday overtime" />
        </label>
        <Button
          disabled={busy || amount.trim() === ''}
          onClick={() => {
            setBusy(true)
            setError(null)
            api
              .recordCost(projectId, {
                budgetCodeId: line.budgetCodeId,
                kind,
                // Sent as a STRING, unparsed. Turning it into a number here
                // would undo the care taken in the database, where the column
                // is NUMERIC because 0.1 is not representable and a budget a
                // cent out is a budget somebody stops trusting.
                amount: amount.trim(),
                ...(tracksUnits && quantity.trim() ? { quantity: quantity.trim() } : {}),
                ...(incurredOn ? { incurredOn } : {}),
                ...(description.trim() ? { description: description.trim() } : {}),
              })
              .then(() => {
                setAmount('')
                setQuantity('')
                setDescription('')
                reload()
                // The budget behind this panel is now wrong until it reloads,
                // and a figure that lags by one entry is how somebody enters
                // it a second time.
                onRecorded()
              })
              .catch((err: unknown) => setError(err instanceof Error ? err.message : 'That cost was refused'))
              .finally(() => setBusy(false))
          }}
        >
          {busy ? 'Recording…' : 'Record it'}
        </Button>
      </div>
      <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--ink-muted)' }}>
        {KINDS.find((k) => k.value === kind)?.hint}
      </p>
    </div>
  )
}
