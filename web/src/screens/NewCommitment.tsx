import { useEffect, useState } from 'react'
import type { CompanyView } from '../api/client.js'
import { useSession } from '../session/SessionProvider.tsx'
import { Banner, Button, Input, Select } from '../ui/index.js'

/**
 * Writing a subcontract into the system.
 *
 * The middle of the money loop and the last piece with no client: a budget
 * could be built and an application could be billed, with no way to create
 * the commitment those bill against.
 *
 * It is created as a DRAFT. Executing it is a separate, deliberate act,
 * because an unsigned contract counts for nothing against the budget and a
 * form that signed on save would put a number in the committed column for
 * work nobody has agreed to do.
 */

export function NewCommitment({
  projectId,
  onCreated,
}: {
  projectId: string
  onCreated: () => void
}) {
  const { api } = useSession()
  const [vendors, setVendors] = useState<CompanyView[]>([])
  const [codes, setCodes] = useState<{ id: string; display: string }[]>([])
  const [kind, setKind] = useState<'subcontract' | 'purchase_order'>('subcontract')
  const [number, setNumber] = useState('')
  const [title, setTitle] = useState('')
  const [vendorOrgId, setVendorOrgId] = useState('')
  const [retainage, setRetainage] = useState('10')
  const [codeId, setCodeId] = useState('')
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void api
      .companies()
      // Only the companies that can actually hold a contract. Offering the
      // architect as the vendor on a subcontract is offering a mistake.
      .then((r) => setVendors(r.companies.filter((c) => !c.isSelf && (c.kind === 'specialty_contractor' || c.kind === 'supplier'))))
      .catch(() => setVendors([]))
    void api
      .budgetCodes(projectId)
      .then((r) => setCodes(r.codes))
      .catch(() => setCodes([]))
  }, [api, projectId])

  return (
    <div style={{ padding: 12, background: 'var(--surface-sunken)', borderRadius: 8, marginBottom: 12 }}>
      {error ? <Banner tone="danger">{error}</Banner> : null}

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--ink-muted)' }}>
          Kind
          <Select
            value={kind}
            onChange={(v) => setKind(v as 'subcontract' | 'purchase_order')}
            placeholder="Subcontract"
            options={[
              { value: 'subcontract', label: 'Subcontract' },
              { value: 'purchase_order', label: 'Purchase order' },
            ]}
          />
        </label>
        <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--ink-muted)' }}>
          Number
          <Input value={number} onChange={setNumber} placeholder="SC-26-001" />
        </label>
        <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--ink-muted)' }}>
          Scope
          <Input value={title} onChange={setTitle} placeholder="Electrical" />
        </label>
        <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--ink-muted)' }}>
          Vendor
          <Select
            value={vendorOrgId}
            onChange={setVendorOrgId}
            placeholder={vendors.length === 0 ? 'Add one to the directory first' : 'Pick a company'}
            options={vendors.map((v) => ({ value: v.id, label: v.name }))}
          />
        </label>
        <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--ink-muted)' }}>
          Retainage %
          <Input value={retainage} onChange={setRetainage} placeholder="10" />
        </label>
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 10 }}>
        <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--ink-muted)' }}>
          Cost code
          <Select
            value={codeId}
            onChange={setCodeId}
            placeholder={codes.length === 0 ? 'Make one on the budget tab' : 'Pick a code'}
            options={codes.map((c) => ({ value: c.id, label: c.display }))}
          />
        </label>
        <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--ink-muted)' }}>
          Value
          <Input value={amount} onChange={setAmount} placeholder="1180000.00" />
        </label>
        <Button
          disabled={busy || number.trim() === '' || vendorOrgId === '' || codeId === '' || amount.trim() === ''}
          onClick={() => {
            setBusy(true)
            setError(null)
            api
              .createCommitment(projectId, {
                kind,
                number: number.trim(),
                title: title.trim() || number.trim(),
                vendorOrgId,
                ...(retainage.trim() ? { retainagePercent: retainage.trim() } : {}),
                lines: [{ budgetCodeId: codeId, description: title.trim() || 'Base scope', amount: amount.trim() }],
              })
              .then(() => {
                setNumber('')
                setTitle('')
                setAmount('')
                onCreated()
              })
              .catch((err: unknown) => setError(err instanceof Error ? err.message : 'That commitment was refused'))
              .finally(() => setBusy(false))
          }}
        >
          {busy ? 'Creating…' : 'Create as draft'}
        </Button>
      </div>

      <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--ink-muted)' }}>
        Created unsigned. An unsigned contract counts for nothing against the budget, so executing it is a separate
        act.
      </p>
    </div>
  )
}
