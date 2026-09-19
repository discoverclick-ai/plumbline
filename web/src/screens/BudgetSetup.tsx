import { useEffect, useState } from 'react'
import { useSession } from '../session/SessionProvider.tsx'
import { Banner, Button, Input, Select } from '../ui/index.js'

/**
 * Putting a budget together.
 *
 * A budget line needs a budget CODE, a code needs values for each WBS
 * segment, and neither had a route or a screen — so the money subsystem was
 * fully built underneath and unreachable for setup. This is the smallest
 * thing that makes it usable: define a cost code, then put a number against
 * it.
 *
 * Deliberately inline on the budget rather than a separate admin area. Cost
 * codes are invented while somebody is looking at the budget and finds the
 * one they need missing, and sending them to another screen to do it is how
 * people end up with "MISC" for everything.
 */

export interface SegmentField {
  key: string
  label: string
  required: boolean
  values: { code: string; label: string }[]
}

export function BudgetSetup({ projectId, onAdded }: { projectId: string; onAdded: () => void }) {
  const { api } = useSession()
  const [segments, setSegments] = useState<SegmentField[]>([])
  const [chosen, setChosen] = useState<Record<string, string>>({})
  const [codes, setCodes] = useState<{ id: string; display: string }[]>([])
  const [codeId, setCodeId] = useState('')
  const [description, setDescription] = useState('')
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reloadCodes = (): void => {
    void api
      .budgetCodes(projectId)
      .then((r) => setCodes(r.codes))
      .catch(() => setCodes([]))
  }

  useEffect(() => {
    let cancelled = false
    api
      .wbsSegments()
      .then(async (r) => {
        const withValues = await Promise.all(
          r.segments.map(async (segment) => ({
            ...segment,
            values: (await api.wbsValues(projectId, segment.key).catch(() => ({ values: [] }))).values,
          })),
        )
        if (!cancelled) setSegments(withValues)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load the cost breakdown')
      })
    reloadCodes()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, projectId])

  const canMakeCode = segments.filter((s) => s.required).every((s) => (chosen[s.key] ?? '') !== '')

  return (
    <div style={{ padding: 12, background: 'var(--surface-sunken)', borderRadius: 8, marginBottom: 12 }}>
      {error ? <Banner tone="danger">{error}</Banner> : null}

      <p style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--ink-muted)' }}>
        A budget line needs a cost code. Build one from the segments this company uses, then put a number against it.
      </p>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        {segments.map((segment) => (
          <label key={segment.key} style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--ink-muted)' }}>
            {segment.label}
            {segment.required ? '' : ' (optional)'}
            <Select
              value={chosen[segment.key] ?? ''}
              onChange={(value) => setChosen((current) => ({ ...current, [segment.key]: value }))}
              placeholder={segment.values.length === 0 ? 'None defined yet' : 'Pick one'}
              options={segment.values.map((v) => ({ value: v.code, label: `${v.code} — ${v.label}` }))}
            />
          </label>
        ))}
        <Button
          disabled={busy || !canMakeCode}
          onClick={() => {
            setBusy(true)
            setError(null)
            api
              .createBudgetCode(projectId, chosen)
              .then((created) => {
                reloadCodes()
                setCodeId(created.id)
              })
              .catch((err: unknown) => setError(err instanceof Error ? err.message : 'That code was refused'))
              .finally(() => setBusy(false))
          }}
        >
          Make the code
        </Button>
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 12 }}>
        <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--ink-muted)' }}>
          Cost code
          <Select
            value={codeId}
            onChange={setCodeId}
            placeholder={codes.length === 0 ? 'Make one first' : 'Pick a code'}
            options={codes.map((c) => ({ value: c.id, label: c.display }))}
          />
        </label>
        <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--ink-muted)' }}>
          Description
          <Input value={description} onChange={setDescription} placeholder="Electrical" />
        </label>
        <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--ink-muted)' }}>
          Original budget
          <Input value={amount} onChange={setAmount} placeholder="1250000.00" />
        </label>
        <Button
          disabled={busy || codeId === '' || amount.trim() === ''}
          onClick={() => {
            setBusy(true)
            setError(null)
            api
              .addBudgetLine(projectId, {
                budgetCodeId: codeId,
                // Typed as a plain decimal and sent as a STRING. Parsing it
                // here would undo the care taken in the database, where 0.1
                // is not representable and a budget a cent out is a budget
                // somebody stops trusting.
                originalAmount: amount.trim(),
                ...(description.trim() ? { description: description.trim() } : {}),
              })
              .then(() => {
                setDescription('')
                setAmount('')
                onAdded()
              })
              .catch((err: unknown) => setError(err instanceof Error ? err.message : 'That line was refused'))
              .finally(() => setBusy(false))
          }}
        >
          {busy ? 'Adding…' : 'Add the line'}
        </Button>
      </div>
    </div>
  )
}
