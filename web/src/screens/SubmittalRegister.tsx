import { useEffect, useMemo, useState } from 'react'
import type { RequirementView } from '../api/client.js'
import { ToolLandingPage } from '../layouts/index.js'
import { useSession } from '../session/SessionProvider.tsx'
import { Banner, Button, Card, EmptyState, Pill, Spinner, Tabs } from '../ui/index.js'

/**
 * The submittal register.
 *
 * A spec book is two thousand pages nobody reads end to end, and buried in it
 * is a list every project engineer builds by hand in the first fortnight of a
 * job: every submittal the contract requires, by section. Missing one is not
 * a paperwork problem. It is a material that arrives unapproved, gets
 * rejected, and becomes a six week lead time nobody budgeted for.
 *
 * So the screen is built for the one thing that decides whether the register
 * gets used: checking a line against the clause it came from, in two seconds,
 * without leaving the row. A register a project engineer cannot check is one
 * they will rebuild by hand anyway, and then the extraction cost them time
 * rather than saving it.
 *
 * Accepting a line CREATES A SUBMITTAL. That is a real record with a workflow
 * and a ball in court, which is why there is no bulk accept: forty submittals
 * created in one click is forty records nobody chose.
 */

const TYPE_TONE: Record<string, 'neutral' | 'accent'> = {
  'Shop Drawing': 'accent',
  Sample: 'accent',
}

export function groupBySection(requirements: RequirementView[]): { section: string; items: RequirementView[] }[] {
  const groups = new Map<string, RequirementView[]>()
  for (const requirement of requirements) {
    groups.set(requirement.sectionNumber, [...(groups.get(requirement.sectionNumber) ?? []), requirement])
  }
  // MasterFormat order, which is how a spec book is bound and how anybody
  // looking for section 07 52 00 expects to find it.
  return [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([section, items]) => ({ section, items }))
}

/** What a confidence figure means to somebody deciding whether to read it. */
export function confidenceLabel(confidence: string | null): string | null {
  if (confidence === null) return null
  const value = Number(confidence)
  if (!Number.isFinite(value)) return null
  // Bands, not percentages. A reviewer does not act differently on 0.82
  // versus 0.86, and showing two decimals invites them to think they should.
  if (value >= 0.9) return null
  if (value >= 0.7) return 'worth a look'
  return 'check this one'
}

export function SubmittalRegister({ projectId, projectName }: { projectId: string; projectName: string }) {
  const { api } = useSession()
  const [requirements, setRequirements] = useState<RequirementView[]>([])
  const [tab, setTab] = useState<'proposed' | 'accepted'>('proposed')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api
      .submittalRegister(projectId)
      .then((r) => {
        if (!cancelled) setRequirements(r.requirements)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load the register')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [api, projectId])

  const proposed = useMemo(() => requirements.filter((r) => r.status === 'proposed'), [requirements])
  const settled = useMemo(
    () => requirements.filter((r) => r.status === 'accepted' || r.status === 'satisfied'),
    [requirements],
  )
  const shown = tab === 'proposed' ? proposed : settled
  const groups = useMemo(() => groupBySection(shown), [shown])

  async function decide(requirement: RequirementView, verdict: 'accept' | 'reject'): Promise<void> {
    setBusy(requirement.id)
    setError(null)
    try {
      if (verdict === 'accept') {
        await api.acceptRequirement(requirement.id)
        setNote(`${requirement.submittalType} for ${requirement.sectionNumber} raised as a submittal.`)
      } else {
        await api.rejectRequirement(requirement.id)
        setNote(`${requirement.sectionNumber} line rejected.`)
      }
      setRequirements((current) =>
        current.map((r) => (r.id === requirement.id ? { ...r, status: verdict === 'accept' ? 'accepted' : 'rejected' } : r)),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not go through')
    } finally {
      setBusy(null)
    }
  }

  return (
    <ToolLandingPage
      title="Submittal register"
      subtitle={projectName}
      tabs={
        <Tabs
          active={tab}
          onSelect={(key) => setTab(key as 'proposed' | 'accepted')}
          tabs={[
            { key: 'proposed', label: 'Waiting on you', badge: proposed.length },
            { key: 'accepted', label: 'On the register', badge: settled.length },
          ]}
        />
      }
      banner={
        error ? (
          <Banner tone="danger">{error}</Banner>
        ) : note ? (
          <Banner tone="accent">{note}</Banner>
        ) : proposed.length > 0 && tab === 'proposed' ? (
          <Banner tone="accent">
            {proposed.length} {proposed.length === 1 ? 'line was' : 'lines were'} read out of the specification.
            Accepting one raises a real submittal, so read the clause under each.
          </Banner>
        ) : undefined
      }
    >
      <Card title={tab === 'proposed' ? 'Read out of the specification' : 'Accepted'}>
        {loading ? (
          <Spinner label="Loading the register" />
        ) : shown.length === 0 ? (
          <EmptyState
            title={tab === 'proposed' ? 'Nothing waiting' : 'Nothing on the register yet'}
            detail={
              tab === 'proposed'
                ? 'Every line read out of the specification has been decided.'
                : 'Accept a line from the other tab and it becomes a submittal with a ball in court.'
            }
          />
        ) : (
          <div style={{ display: 'grid', gap: 18 }}>
            {groups.map((group) => (
              <section key={group.section}>
                <h3 style={{ margin: '0 0 8px', fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
                  Section {group.section}{' '}
                  <span style={{ color: 'var(--ink-muted)', fontWeight: 400 }}>{group.items.length}</span>
                </h3>
                <div style={{ display: 'grid', gap: 8 }}>
                  {group.items.map((requirement) => (
                    <article
                      key={requirement.id}
                      style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 12 }}
                    >
                      <header style={{ display: 'flex', gap: 10, justifyContent: 'space-between', alignItems: 'baseline' }}>
                        <div>
                          <Pill tone={TYPE_TONE[requirement.submittalType] ?? 'neutral'}>
                            {requirement.submittalType}
                          </Pill>{' '}
                          <strong>{requirement.description}</strong>
                          {confidenceLabel(requirement.confidence) ? (
                            <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--ink-muted)' }}>
                              {confidenceLabel(requirement.confidence)}
                            </span>
                          ) : null}
                        </div>
                        {requirement.status === 'proposed' ? (
                          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                            <Button
                              variant="ghost"
                              onClick={() => void decide(requirement, 'reject')}
                              disabled={busy === requirement.id}
                            >
                              Not required
                            </Button>
                            <Button onClick={() => void decide(requirement, 'accept')} disabled={busy === requirement.id}>
                              {busy === requirement.id ? 'Raising…' : 'Add to register'}
                            </Button>
                          </div>
                        ) : (
                          <Pill tone="ok">{requirement.status === 'satisfied' ? 'Satisfied' : 'On the register'}</Pill>
                        )}
                      </header>

                      {/*
                        The clause, verbatim, under every line. A register a
                        project engineer cannot check is one they rebuild by
                        hand, and then the extraction cost them time rather
                        than saving it.
                      */}
                      <blockquote
                        style={{
                          margin: '8px 0 0',
                          paddingLeft: 10,
                          borderLeft: '3px solid var(--line)',
                          fontSize: 13,
                          color: 'var(--ink-muted)',
                          whiteSpace: 'pre-wrap',
                        }}
                      >
                        {requirement.quote}
                      </blockquote>
                    </article>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </Card>
    </ToolLandingPage>
  )
}
