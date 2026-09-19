import { useEffect, useState } from 'react'
import type { CompanyView, PersonView, TemplateView } from '../api/client.js'
import { ToolLandingPage } from '../layouts/index.js'
import { useSession } from '../session/SessionProvider.tsx'
import { Banner, Button, Card, EmptyState, Input, Pill, Select, Spinner, Table, Tabs } from '../ui/index.js'

/**
 * The company directory.
 *
 * Nothing in this product could add a company or a person, which meant a
 * customer could not onboard: the software could run a job beautifully and
 * had no way to start one or to put anybody on it.
 *
 * The organising idea is that a person belongs to a COMPANY, and the company
 * kind is what decides most of what they may do. "Project Manager" means
 * three different jobs depending on whether the company is the general
 * contractor, the owner or a specialty contractor, so this screen never asks
 * for a role without also showing the company it belongs to.
 */

const KINDS: { value: string; label: string }[] = [
  { value: 'general_contractor', label: 'General contractor' },
  { value: 'owner', label: 'Owner' },
  { value: 'architect', label: 'Architect' },
  { value: 'engineer', label: 'Engineer' },
  { value: 'consultant', label: 'Consultant' },
  { value: 'specialty_contractor', label: 'Specialty contractor' },
  { value: 'supplier', label: 'Supplier' },
]

const KIND_LABEL = new Map(KINDS.map((k) => [k.value, k.label]))

export function Directory() {
  const { api } = useSession()
  const [tab, setTab] = useState<'people' | 'companies'>('people')
  const [companies, setCompanies] = useState<CompanyView[]>([])
  const [people, setPeople] = useState<PersonView[]>([])
  const [templates, setTemplates] = useState<TemplateView[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState<'person' | 'company' | null>(null)

  const reload = (): void => {
    Promise.all([api.companies(), api.people(), api.permissionTemplates('company')])
      .then(([c, p, t]) => {
        setCompanies(c.companies)
        setPeople(p.people)
        setTemplates(t.templates)
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load the directory'))
      .finally(() => setLoading(false))
  }

  useEffect(reload, [api])

  return (
    <ToolLandingPage
      title="Directory"
      tabs={
        <Tabs
          active={tab}
          onSelect={(key) => setTab(key as 'people' | 'companies')}
          tabs={[
            { key: 'people', label: 'People', badge: people.length },
            { key: 'companies', label: 'Companies', badge: companies.length },
          ]}
        />
      }
      banner={error ? <Banner tone="danger">{error}</Banner> : undefined}
    >
      <Card
        title={tab === 'people' ? 'Everybody on this account' : 'Every company on this account'}
        actions={
          <Button onClick={() => setAdding(adding ? null : tab === 'people' ? 'person' : 'company')}>
            {adding ? 'Cancel' : tab === 'people' ? 'Add a person' : 'Add a company'}
          </Button>
        }
      >
        {adding === 'company' ? (
          <AddCompany
            onDone={() => {
              setAdding(null)
              reload()
            }}
            onError={setError}
          />
        ) : null}
        {adding === 'person' ? (
          <AddPerson
            companies={companies}
            templates={templates}
            onDone={() => {
              setAdding(null)
              reload()
            }}
            onError={setError}
          />
        ) : null}

        {loading ? (
          <Spinner label="Loading the directory" />
        ) : tab === 'people' ? (
          <Table
            rows={people}
            rowKey={(row) => row.id}
            empty={<EmptyState title="Nobody here yet" detail="Add a company first, then the people in it." />}
            columns={[
              {
                key: 'name',
                header: 'Name',
                render: (row: PersonView) => (
                  <>
                    <strong>{row.name}</strong>
                    <div style={{ fontSize: 12, color: 'var(--ink-muted)' }}>{row.email}</div>
                  </>
                ),
              },
              {
                key: 'company',
                header: 'Company',
                render: (row: PersonView) => (
                  <>
                    {row.organizationName}
                    {row.jobTitle ? (
                      <div style={{ fontSize: 12, color: 'var(--ink-muted)' }}>{row.jobTitle}</div>
                    ) : null}
                  </>
                ),
              },
              {
                key: 'access',
                header: 'Company access',
                width: '220px',
                render: (row: PersonView) => (
                  // Shown, because "why can they see the budget" is a question
                  // somebody asks about once a month and a directory that
                  // cannot answer it sends them to support.
                  <Pill tone={row.companyTemplateName === 'Company Administrator' ? 'warn' : 'neutral'}>
                    {row.companyTemplateName ?? 'None'}
                  </Pill>
                ),
              },
            ]}
          />
        ) : (
          <Table
            rows={companies}
            rowKey={(row) => row.id}
            empty={<EmptyState title="No companies yet" />}
            columns={[
              {
                key: 'name',
                header: 'Company',
                render: (row: CompanyView) => (
                  <>
                    <strong>{row.name}</strong>
                    {row.isSelf ? (
                      <Pill tone="accent">
                        {' '}
                        You
                      </Pill>
                    ) : null}
                    {row.trade ? (
                      <div style={{ fontSize: 12, color: 'var(--ink-muted)' }}>{row.trade}</div>
                    ) : null}
                  </>
                ),
              },
              {
                key: 'kind',
                header: 'Kind',
                width: '220px',
                render: (row: CompanyView) => KIND_LABEL.get(row.kind) ?? row.kind,
              },
              {
                key: 'people',
                header: 'People',
                width: '100px',
                render: (row: CompanyView) => String(row.userCount),
              },
            ]}
          />
        )}
      </Card>
    </ToolLandingPage>
  )
}

function AddCompany({ onDone, onError }: { onDone: () => void; onError: (message: string) => void }) {
  const { api } = useSession()
  const [name, setName] = useState('')
  const [kind, setKind] = useState('specialty_contractor')
  const [trade, setTrade] = useState('')
  const [busy, setBusy] = useState(false)

  return (
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 14 }}>
      <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--ink-muted)' }}>
        Company name
        <Input value={name} onChange={setName} placeholder="Vega Steel" />
      </label>
      <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--ink-muted)' }}>
        Kind
        <Select value={kind} onChange={setKind} placeholder="Specialty contractor" options={KINDS} />
      </label>
      <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--ink-muted)' }}>
        Trade
        <Input value={trade} onChange={setTrade} placeholder="Structural Steel" />
      </label>
      <Button
        disabled={busy || name.trim() === ''}
        onClick={() => {
          setBusy(true)
          api
            .addCompany({ name: name.trim(), kind, ...(trade.trim() ? { trade: trade.trim() } : {}) })
            .then(onDone)
            .catch((err: unknown) => onError(err instanceof Error ? err.message : 'That did not save'))
            .finally(() => setBusy(false))
        }}
      >
        {busy ? 'Adding…' : 'Add'}
      </Button>
    </div>
  )
}

function AddPerson({
  companies,
  templates,
  onDone,
  onError,
}: {
  companies: CompanyView[]
  templates: TemplateView[]
  onDone: () => void
  onError: (message: string) => void
}) {
  const { api } = useSession()
  const [organizationId, setOrganizationId] = useState(companies[0]?.id ?? '')
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [jobTitle, setJobTitle] = useState('')
  const [templateId, setTemplateId] = useState('')
  const [busy, setBusy] = useState(false)

  return (
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 14 }}>
      <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--ink-muted)' }}>
        Company
        <Select
          value={organizationId}
          onChange={setOrganizationId}
          placeholder="Pick a company"
          options={companies.map((c) => ({ value: c.id, label: c.name }))}
        />
      </label>
      <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--ink-muted)' }}>
        Email
        <Input value={email} onChange={setEmail} placeholder="ali@bishop.test" />
      </label>
      <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--ink-muted)' }}>
        Name
        <Input value={name} onChange={setName} placeholder="Ali Bishop" />
      </label>
      <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--ink-muted)' }}>
        Job title
        <Input value={jobTitle} onChange={setJobTitle} placeholder="Architect of Record" />
      </label>
      <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--ink-muted)' }}>
        Company access
        <Select
          value={templateId}
          onChange={setTemplateId}
          // Empty means the account's default, which is the least privileged
          // one. Leaving it blank should never be the generous choice.
          placeholder="Default"
          options={templates.map((t) => ({ value: t.id, label: t.name }))}
        />
      </label>
      <Button
        disabled={busy || organizationId === '' || email.trim() === ''}
        onClick={() => {
          setBusy(true)
          api
            .addPerson({
              organizationId,
              email: email.trim(),
              name: name.trim() || email.trim(),
              ...(jobTitle.trim() ? { jobTitle: jobTitle.trim() } : {}),
              ...(templateId ? { companyPermissionTemplateId: templateId } : {}),
            })
            .then(onDone)
            .catch((err: unknown) => onError(err instanceof Error ? err.message : 'That did not save'))
            .finally(() => setBusy(false))
        }}
      >
        {busy ? 'Adding…' : 'Add'}
      </Button>
    </div>
  )
}
