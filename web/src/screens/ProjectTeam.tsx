import { useEffect, useMemo, useState } from 'react'
import type { CompanyView, PersonView, TemplateView } from '../api/client.js'
import { ToolLandingPage } from '../layouts/index.js'
import { useSession } from '../session/SessionProvider.tsx'
import { Banner, Button, Card, EmptyState, Pill, Select, Spinner, Table } from '../ui/index.js'

/**
 * Who is on this job.
 *
 * The last link in the onboarding loop: start a project, add the companies
 * and people, then put them on it. Without this the first two are useless.
 *
 * The template picker is the whole screen. "Project Manager" names three
 * templates that differ only by which side of the contract the person sits
 * on, and picking the wrong one is SILENT — the person gets access that
 * looks plausible and is wrong in ways nobody notices until a trade partner
 * can see the budget. So the list is filtered to the templates written for
 * that person's own company kind, and where a name is ambiguous it says
 * which company kind it belongs to.
 */

export interface TeamMember {
  userId: string
  name: string
  jobTitle: string | null
  organization: string
}

/**
 * The templates that make sense for this person.
 *
 * A template with no stated audience applies to everybody and is the
 * fallback. One with an audience only appears for a company of that kind:
 * offering a subcontractor's PM the owner's Project Manager template is
 * offering somebody the wrong answer to the most important question on the
 * screen.
 */
export function templatesFor(templates: TemplateView[], orgKind: string | null): TemplateView[] {
  const project = templates.filter((t) => t.scope === 'project')
  // Nobody chosen yet: show everything, with the audience spelled out, rather
  // than an empty list that looks like a broken screen.
  if (orgKind === null) return project
  return project.filter((template) => {
    const audience = template.appliesToOrgKinds
    if (!audience || audience.length === 0) return true
    return audience.includes(orgKind)
  })
}

/** "Project Manager (general contractor)" when the bare name is ambiguous. */
export function templateLabel(template: TemplateView, all: TemplateView[]): string {
  const sameName = all.filter((t) => t.name === template.name)
  if (sameName.length <= 1) return template.name
  const audience = (template.appliesToOrgKinds ?? []).map((k) => k.replace(/_/g, ' ')).join(', ')
  return audience ? `${template.name} (${audience})` : `${template.name} (everyone else)`
}

export function ProjectTeam({ projectId, projectName }: { projectId: string; projectName: string }) {
  const { api } = useSession()
  const [members, setMembers] = useState<TeamMember[]>([])
  const [people, setPeople] = useState<PersonView[] | null>(null)
  const [companies, setCompanies] = useState<CompanyView[]>([])
  const [templates, setTemplates] = useState<TemplateView[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [chosen, setChosen] = useState('')
  const [templateName, setTemplateName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = (): void => {
    Promise.all([
      api.members(projectId),
      // A refusal is not an empty directory. Somebody who may run the project
      // and not read the whole company directory should still see the team.
      api.people().catch(() => ({ people: null })),
      api.permissionTemplates('project').catch(() => ({ templates: [] })),
      api.companies().catch(() => ({ companies: [] })),
    ])
      .then(([team, directory, t, c]) => {
        setMembers(team.members)
        setPeople(directory.people as PersonView[] | null)
        setTemplates(t.templates)
        setCompanies(c.companies)
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load the team'))
      .finally(() => setLoading(false))
  }

  useEffect(reload, [api, projectId])

  const onProject = useMemo(() => new Set(members.map((m) => m.userId)), [members])
  const available = (people ?? []).filter((p) => !onProject.has(p.id))
  const chosenPerson = available.find((p) => p.id === chosen) ?? null

  // Filtered by the chosen person's OWN company kind. Offering a
  // subcontractor's PM the owner's Project Manager template is offering
  // somebody the wrong answer to the most important question on this screen,
  // and the wrongness is silent.
  const kindByOrg = useMemo(() => new Map(companies.map((c) => [c.id, c.kind])), [companies])
  const offered = useMemo(
    () => templatesFor(templates, chosenPerson ? (kindByOrg.get(chosenPerson.organizationId) ?? null) : null),
    [templates, chosenPerson, kindByOrg],
  )

  return (
    <ToolLandingPage
      title="Project team"
      subtitle={projectName}
      banner={error ? <Banner tone="danger">{error}</Banner> : undefined}
    >
      <Card
        title={`${members.length} on this job`}
        actions={
          people === null ? undefined : (
            <Button onClick={() => setAdding((on) => !on)}>{adding ? 'Cancel' : 'Add somebody'}</Button>
          )
        }
      >
        {adding ? (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 14 }}>
            <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--ink-muted)' }}>
              Who
              <Select
                value={chosen}
                onChange={setChosen}
                placeholder="Pick somebody"
                options={available.map((p) => ({ value: p.id, label: `${p.name} — ${p.organizationName}` }))}
              />
            </label>
            <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--ink-muted)' }}>
              Access on this job
              <Select
                value={templateName}
                onChange={setTemplateName}
                // Blank resolves on the server against this person's own
                // company kind, which is a better answer than any guess this
                // screen could make.
                placeholder="Default for their company"
                options={offered.map((t) => ({ value: t.name, label: templateLabel(t, offered) }))}
              />
            </label>
            <Button
              disabled={busy || chosen === ''}
              onClick={() => {
                setBusy(true)
                setError(null)
                api
                  .addProjectMember(projectId, chosen, templateName || undefined)
                  .then(() => {
                    setAdding(false)
                    setChosen('')
                    setTemplateName('')
                    reload()
                  })
                  .catch((err: unknown) => setError(err instanceof Error ? err.message : 'That did not save'))
                  .finally(() => setBusy(false))
              }}
            >
              {busy ? 'Adding…' : 'Add to the job'}
            </Button>
            {chosenPerson ? (
              <span style={{ fontSize: 12, color: 'var(--ink-muted)', alignSelf: 'center' }}>
                {chosenPerson.organizationName}
              </span>
            ) : null}
          </div>
        ) : null}

        {loading ? (
          <Spinner label="Loading the team" />
        ) : (
          <Table
            rows={members}
            rowKey={(row) => row.userId}
            empty={<EmptyState title="Nobody on this job yet" detail="Add people from the company directory." />}
            columns={[
              {
                key: 'name',
                header: 'Name',
                render: (row: TeamMember) => (
                  <>
                    <strong>{row.name}</strong>
                    {row.jobTitle ? (
                      <div style={{ fontSize: 12, color: 'var(--ink-muted)' }}>{row.jobTitle}</div>
                    ) : null}
                  </>
                ),
              },
              {
                key: 'company',
                header: 'Company',
                render: (row: TeamMember) => <Pill>{row.organization}</Pill>,
              },
            ]}
          />
        )}
      </Card>
    </ToolLandingPage>
  )
}
