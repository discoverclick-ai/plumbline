import { useEffect, useState } from 'react'
import type { SyncConflictView } from '../api/client.js'
import { ToolLandingPage } from '../layouts/index.js'
import { useSession } from '../session/SessionProvider.tsx'
import { Banner, Button, Card, EmptyState, Pill, Spinner } from '../ui/index.js'

/**
 * What the field typed and the server could not keep.
 *
 * Offline sync on a construction site is not an edge case: basements, lifts,
 * rural jobs, and a phone that has been out of signal since seven. The merge
 * keeps every field the server did not also change, which is most of them,
 * and this screen exists for the rest.
 *
 * The rule the whole screen is built on: NEVER SHOW THAT SOMETHING WAS LOST
 * WITHOUT SHOWING WHAT IT WAS. A conflict list that says "notes was dropped"
 * is a list nobody can act on; one that shows the sentence the foreman typed
 * lets them paste it back in thirty seconds. The value is right there, ready
 * to copy, next to a link to the record it belongs on.
 *
 * There is deliberately no "apply anyway" button. The device's value lost
 * because somebody at a desk changed the same field, and silently overwriting
 * their work to fix the foreman's would just move the problem. A person reads
 * both and decides.
 */

/** "eight hours later", which is the fact that explains most conflicts. */
export function arrivalGap(occurredAt: string, receivedAt: string): string | null {
  const gap = Date.parse(receivedAt) - Date.parse(occurredAt)
  if (!Number.isFinite(gap) || gap < 60 * 60 * 1000) return null
  const hours = Math.round(gap / (60 * 60 * 1000))
  if (hours < 24) return `reached us ${hours} ${hours === 1 ? 'hour' : 'hours'} later`
  const days = Math.round(hours / 24)
  return `reached us ${days} ${days === 1 ? 'day' : 'days'} later`
}

export function SyncConflicts({ projectId, projectName }: { projectId: string; projectName: string }) {
  const { api } = useSession()
  const [conflicts, setConflicts] = useState<SyncConflictView[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .syncConflicts(projectId)
      .then((r) => {
        if (!cancelled) setConflicts(r.conflicts)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load the conflicts')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [api, projectId])

  const rejected = conflicts.filter((c) => c.outcome === 'rejected')

  return (
    <ToolLandingPage
      title="From the field"
      subtitle={projectName}
      banner={
        error ? (
          <Banner tone="danger">{error}</Banner>
        ) : rejected.length > 0 ? (
          <Banner tone="danger">
            {rejected.length} {rejected.length === 1 ? 'change was' : 'changes were'} refused outright, not merged.
            Whoever typed them does not know.
          </Banner>
        ) : undefined
      }
    >
      <Card title={`${conflicts.length} ${conflicts.length === 1 ? 'change' : 'changes'} the server could not keep`}>
        {loading ? (
          <Spinner label="Loading" />
        ) : conflicts.length === 0 ? (
          <EmptyState
            title="Nothing was lost"
            detail="Every change pushed from a phone on this job was applied. Most are: the merge keeps any field the office did not also touch."
          />
        ) : (
          <div style={{ display: 'grid', gap: 12 }}>
            {conflicts.map((conflict) => (
              <article
                key={conflict.clientOpId}
                style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 14 }}
              >
                <header style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
                  <div>
                    <Pill tone={conflict.outcome === 'rejected' ? 'danger' : 'warn'}>
                      {conflict.outcome === 'rejected' ? 'Refused' : 'Partly merged'}
                    </Pill>{' '}
                    {conflict.designation ? (
                      <>
                        <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{conflict.designation}</strong>{' '}
                        <span style={{ color: 'var(--ink-muted)' }}>{conflict.title}</span>
                      </>
                    ) : (
                      <span style={{ color: 'var(--ink-muted)' }}>A record that no longer exists</span>
                    )}
                  </div>
                  <span style={{ fontSize: 12, color: 'var(--ink-muted)', whiteSpace: 'nowrap' }}>
                    {conflict.deviceOwner ?? 'Unknown'}
                    {conflict.deviceLabel ? ` · ${conflict.deviceLabel}` : ''}
                  </span>
                </header>

                <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--ink-muted)' }}>
                  Typed {new Date(conflict.occurredAt).toLocaleString()}
                  {/* The gap is the fact that explains most conflicts: a
                      phone out of signal since seven, pushing at four. */}
                  {arrivalGap(conflict.occurredAt, conflict.receivedAt)
                    ? `, ${arrivalGap(conflict.occurredAt, conflict.receivedAt)}`
                    : ''}
                </p>

                {conflict.detail ? (
                  <p style={{ margin: '6px 0 0', fontSize: 13 }}>{conflict.detail}</p>
                ) : null}

                {conflict.applied.length > 0 ? (
                  <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--ink-muted)' }}>
                    Kept: {conflict.applied.join(', ')}
                  </p>
                ) : null}

                {conflict.dropped.length > 0 ? (
                  <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
                    {conflict.dropped.map((field) => (
                      <div key={field.field}>
                        <div style={{ fontSize: 12, color: 'var(--ink-muted)' }}>Not kept · {field.field}</div>
                        {/*
                          The words themselves, ready to copy. A conflict that
                          says a field was lost without showing what was in it
                          is one nobody can resolve.
                        */}
                        <pre
                          style={{
                            margin: '2px 0 0',
                            padding: '8px 10px',
                            background: 'var(--surface-sunken)',
                            borderRadius: 6,
                            fontSize: 13,
                            whiteSpace: 'pre-wrap',
                            fontFamily: 'inherit',
                          }}
                        >
                          {field.value || <em style={{ color: 'var(--ink-faint)' }}>(empty)</em>}
                        </pre>
                        <Button
                          variant="ghost"
                          onClick={() => {
                            void navigator.clipboard?.writeText(field.value)
                            setCopied(`${conflict.clientOpId}:${field.field}`)
                          }}
                        >
                          {copied === `${conflict.clientOpId}:${field.field}` ? 'Copied' : 'Copy'}
                        </Button>
                      </div>
                    ))}
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </Card>
    </ToolLandingPage>
  )
}
