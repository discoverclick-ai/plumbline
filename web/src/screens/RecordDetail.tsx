import { useCallback, useEffect, useState } from 'react'
import { ApiError, type ActivityView, type RecordView } from '../api/client.js'
import { DetailPage } from '../layouts/index.js'
import { useSession } from '../session/SessionProvider.tsx'
import {
  Banner,
  Button,
  Card,
  Field,
  Pill,
  Spinner,
  Tabs,
  Tearsheet,
  Textarea,
  statusTone,
} from '../ui/index.js'
import { floatText, startsIn } from './Lookahead.tsx'
import { RecordFields, toFieldValues, toRequestBody, type FieldValues } from './RecordFields.tsx'
import type { RecordComment, RecordStateChange } from '@plumbline/shared'

/**
 * One record, of any type.
 *
 * The action bar is built from `availableTransitions`, which the server
 * computes per actor: the client never decides that an architect may answer an
 * RFI, it renders what it was told. A transition that needs fields opens the
 * slide-over with exactly those fields, because the registry says which ones
 * (`requiresFields`) — the alternative is asking for everything on every move.
 */

export function RecordDetail({
  recordId,
  onBack,
}: {
  recordId: string
  onBack?: () => void
}) {
  const { api, types } = useSession()
  const [view, setView] = useState<RecordView | null>(null)
  const [history, setHistory] = useState<{ states: RecordStateChange[]; comments: RecordComment[] } | null>(null)
  const [tab, setTab] = useState('details')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<{ key: string; label: string } | null>(null)
  const [values, setValues] = useState<FieldValues>({})
  const [issues, setIssues] = useState<{ field: string; message: string }[]>([])
  const [busy, setBusy] = useState(false)
  const [comment, setComment] = useState('')
  const [blocking, setBlocking] = useState<(ActivityView & { kind: string })[]>([])

  const load = useCallback(async () => {
    try {
      const [record, past] = await Promise.all([api.record(recordId), api.history(recordId)])
      setView(record)
      setHistory(past)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this record')
    }
  }, [api, recordId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    let cancelled = false
    // A refusal here is not an error worth showing. Most people on a job hold
    // no schedule access at all, and a red banner on an RFI because they
    // cannot see the programme would be noise on the screen they came for.
    api
      .recordActivities(recordId)
      .then((r) => {
        if (!cancelled) setBlocking(r.activities)
      })
      .catch(() => {
        if (!cancelled) setBlocking([])
      })
    return () => {
      cancelled = true
    }
  }, [api, recordId])

  if (error && !view) return <Banner tone="danger">{error}</Banner>
  if (!view) return <Spinner label="Loading record" />

  const type = types.get(view.record.typeKey)
  // The record arrives before the registry can, and without the registry this
  // screen cannot tell a transition that needs no fields from one whose field
  // list it has not read yet — it would fire the second kind with an empty
  // body and show the server's refusal as if the button were broken.
  if (!type) return <Spinner label="Loading record" />

  const state = type.states.find((s) => s.key === view.record.status)

  const startTransition = (transition: { key: string; label: string }) => {
    const spec = type.transitions.find((t) => t.key === transition.key)
    setIssues([])
    setPending(transition)
    // Pre-fill with what the record already holds so an edit is an edit, not
    // a retype.
    setValues(toFieldValues(view.record.body))
    if (!spec || spec.requiresFields.length === 0) {
      // Nothing to collect: run it straight away.
      void runTransition(transition.key, undefined)
      setPending(null)
    }
  }

  async function runTransition(transitionKey: string, body: Record<string, unknown> | undefined) {
    setBusy(true)
    setError(null)
    try {
      const next = await api.transition(recordId, {
        transitionKey,
        ...(body ? { body } : {}),
        expectedVersion: view?.record.version,
      })
      setView(next)
      setHistory(await api.history(recordId))
      setPending(null)
      setIssues([])
    } catch (err) {
      if (err instanceof ApiError) {
        // The server is the authority on what a transition needs; its issues
        // land next to the right controls rather than as a toast — but only
        // when there are controls on screen. A transition that needs no fields
        // has no slide-over, and swallowing its issues there would make the
        // button look broken.
        setIssues(err.issues)
        const inline = err.issues.length > 0 && body !== undefined
        setError(
          inline
            ? null
            : err.issues.length > 0
              ? `${err.message}: ${err.issues.map((issue) => issue.message).join('; ')}`
              : err.message,
        )
      } else {
        setError(err instanceof Error ? err.message : 'That did not work')
      }
    } finally {
      setBusy(false)
    }
  }

  const requiredKeys = pending
    ? (type.transitions.find((t) => t.key === pending.key)?.requiresFields ?? [])
    : []
  const tearsheetFields = type.fields.filter((field) => requiredKeys.includes(field.key))

  return (
    <DetailPage
      breadcrumbs={
        onBack && (
          <Button variant="ghost" onClick={onBack}>
            ← Back
          </Button>
        )
      }
      title={`${view.record.designation} · ${view.record.title}`}
      status={<Pill tone={statusTone(view.record.status, state?.terminal)}>{view.statusLabel}</Pill>}
      banner={error && <Banner tone="danger">{error}</Banner>}
      tabs={
        <Tabs
          active={tab}
          onSelect={setTab}
          tabs={[
            { key: 'details', label: 'Details' },
            { key: 'activity', label: 'Activity', badge: history?.states.length ?? 0 },
          ]}
        />
      }
      footer={
        <>
          {view.availableTransitions.length === 0 && (
            <span style={{ color: 'var(--ink-faint)', alignSelf: 'center' }}>
              Nothing for you to do on this record
            </span>
          )}
          {view.availableTransitions.map((transition, index) => (
            <Button
              key={transition.key}
              variant={index === 0 ? 'primary' : 'secondary'}
              busy={busy && pending?.key === transition.key}
              onClick={() => startTransition(transition)}
            >
              {transition.label}
            </Button>
          ))}
        </>
      }
    >
      {tab === 'details' && (
        <>
          {view.assignment && (
            <Banner tone="accent">
              <strong>Ball in court</strong> · {view.assignment.expectedAction}
              {view.assignment.dueAt && ` · due ${new Date(view.assignment.dueAt).toLocaleDateString()}`}
            </Banner>
          )}
          {/*
            What this is holding up, above the fields rather than below them.
            Somebody deciding whether to answer today needs to know that steel
            starts Thursday before they read the question, not after.
          */}
          {blocking.length > 0 && (
            <Card title="Holding up">
              <div style={{ display: 'grid', gap: 8 }}>
                {blocking.map((activity) => (
                  <div key={activity.activityCode} style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
                    <Pill
                      tone={
                        activity.isCritical
                          ? 'danger'
                          : Number(activity.totalFloatDays ?? 99) <= 5
                            ? 'warn'
                            : 'neutral'
                      }
                    >
                      {floatText(activity.totalFloatDays)}
                    </Pill>
                    <div>
                      <strong>{activity.name}</strong>
                      <div style={{ fontSize: 12, color: 'var(--ink-muted)' }}>
                        {activity.activityCode} · {startsIn(activity.startAt)}
                        {activity.kind === 'blocks' ? '' : ` · ${activity.kind}`}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}
          <Card title={type.displayName}>
            <RecordFields fields={type.fields} values={toFieldValues(view.record.body)} onChange={() => {}} readOnly />
          </Card>
        </>
      )}

      {tab === 'activity' && (
        <>
          <Card title="History">
            <ol style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 'var(--space-3)' }}>
              {(history?.states ?? []).map((change) => (
                <li key={change.id} style={{ display: 'flex', gap: 'var(--space-3)' }}>
                  <Pill>{change.transitionKey}</Pill>
                  <span style={{ color: 'var(--ink-muted)' }}>
                    {change.fromStatus ? `${change.fromStatus} → ` : ''}
                    {change.toStatus} · {new Date(change.occurredAt).toLocaleString()}
                  </span>
                </li>
              ))}
            </ol>
          </Card>

          <Card title="Comments">
            <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
              {(history?.comments ?? []).map((entry) => (
                <p key={entry.id} style={{ margin: 0 }}>
                  {entry.body}
                  <br />
                  <span style={{ fontSize: 12, color: 'var(--ink-faint)' }}>
                    {new Date(entry.createdAt).toLocaleString()}
                  </span>
                </p>
              ))}
              <Field label="Add a comment">
                <Textarea value={comment} onChange={setComment} rows={3} />
              </Field>
              <div>
                <Button
                  disabled={comment.trim().length === 0}
                  onClick={async () => {
                    await api.comment(recordId, comment)
                    setComment('')
                    setHistory(await api.history(recordId))
                  }}
                >
                  Comment
                </Button>
              </div>
            </div>
          </Card>
        </>
      )}

      {pending && (
        <Tearsheet
          title={pending.label}
          onClose={() => setPending(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setPending(null)}>
                Cancel
              </Button>
              <Button variant="primary" busy={busy} onClick={() => runTransition(pending.key, toRequestBody(values))}>
                {pending.label}
              </Button>
            </>
          }
        >
          <RecordFields
            fields={tearsheetFields}
            values={values}
            issues={issues}
            onChange={(key, value) => setValues((prev) => ({ ...prev, [key]: value }))}
          />
        </Tearsheet>
      )}
    </DetailPage>
  )
}
