import { useCallback, useEffect, useState } from 'react'
import { ApiError, type CaptureView, type ProposalView } from '../api/client.js'
import { ToolLandingPage } from '../layouts/index.js'
import { useProjectScope, useSession } from '../session/SessionProvider.tsx'
import { Banner, Button, Card, Field, Input, Pill, Spinner, Tearsheet, Textarea } from '../ui/index.js'
import { RecordFields, toFieldValues, toRequestBody, type FieldValues } from './RecordFields.tsx'

/**
 * The approval gate, as a screen.
 *
 * This is the part of the product that does not exist in the incumbents, so it
 * gets the most careful UI in the app. Three things are always on screen for a
 * proposal: what the agent produced, why it says it read the capture that way,
 * and what it could not fill in. A draft you cannot interrogate is a draft you
 * should not accept, and an approver who cannot see the gaps will click
 * through them.
 *
 * Accepting is creating, by the person accepting: the server runs the ordinary
 * kernel path under their permissions. The UI does not pretend otherwise, and
 * a refusal comes back as a plain 403 shown in place.
 */

export function CaptureInbox({ projectId, projectName }: { projectId: string; projectName: string }) {
  const { api, types, can } = useSession()
  const scoped = useProjectScope(projectId)
  const [proposals, setProposals] = useState<ProposalView[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [open, setOpen] = useState<ProposalView | null>(null)
  const [title, setTitle] = useState('')
  const [values, setValues] = useState<FieldValues>({})
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [capture, setCapture] = useState<CaptureView | null>(null)

  const load = useCallback(async () => {
    if (!scoped) return
    setLoading(true)
    try {
      const result = await api.proposals(projectId)
      setProposals(result.proposals)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the inbox')
    } finally {
      setLoading(false)
    }
  }, [api, projectId, scoped])

  useEffect(() => {
    void load()
  }, [load])

  function openProposal(proposal: ProposalView) {
    setOpen(proposal)
    setTitle(proposal.title)
    setValues(toFieldValues(proposal.body))
    setError(null)
    // The point of the gate is checking the draft against the signal it came
    // from. Showing only the agent's rationale asks the approver to audit the
    // reasoning without the evidence.
    setCapture(null)
    api
      .getCapture(proposal.captureId)
      .then(setCapture)
      .catch(() => setCapture(null))
  }

  async function accept() {
    if (!open) return
    setBusy(true)
    setError(null)
    try {
      const result = await api.acceptProposal(open.id, { title, body: toRequestBody(values) })
      setNotice(
        `${result.record.record.designation} created${result.proposal.edited ? ' with your edits' : ''}.`,
      )
      setOpen(null)
      await load()
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.issues.length > 0
            ? `${err.message}: ${err.issues.map((i) => i.message).join(', ')}`
            : err.message
          : 'Could not accept that proposal',
      )
    } finally {
      setBusy(false)
    }
  }

  async function reject() {
    if (!open) return
    setBusy(true)
    try {
      await api.rejectProposal(open.id, note || undefined)
      setNotice('Proposal rejected. The capture is kept and can be re-read later.')
      setOpen(null)
      setNote('')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reject that proposal')
    } finally {
      setBusy(false)
    }
  }

  const type = open ? types.get(open.typeKey) : undefined

  return (
    <ToolLandingPage
      title="Capture inbox"
      subtitle={`${projectName} · drafts waiting for a human`}
      banner={
        error ? <Banner tone="danger">{error}</Banner> : notice ? <Banner tone="ok">{notice}</Banner> : undefined
      }
    >
      {loading ? (
        <Spinner label="Loading inbox" />
      ) : proposals.length === 0 ? (
        <Card>
          <p style={{ margin: 0, color: 'var(--ink-muted)' }}>
            Nothing waiting. Captures from the field appear here as drafts once they have been read.
          </p>
        </Card>
      ) : (
        proposals.map((proposal) => {
          const proposedType = types.get(proposal.typeKey)
          return (
            <Card
              key={proposal.id}
              title={
                <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                  <Pill tone="accent">{proposedType?.displayName ?? proposal.typeKey}</Pill>
                  {proposal.title}
                </span>
              }
              actions={
                <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                  {proposal.confidence !== null && (
                    <Pill tone={proposal.confidence >= 0.75 ? 'ok' : proposal.confidence >= 0.5 ? 'warn' : 'danger'}>
                      {Math.round(proposal.confidence * 100)}% sure
                    </Pill>
                  )}
                  <Button onClick={() => openProposal(proposal)}>Review</Button>
                </span>
              }
            >
              {proposal.rationale && (
                <p style={{ margin: '0 0 var(--space-3)', color: 'var(--ink-muted)' }}>{proposal.rationale}</p>
              )}
              {proposal.issues.length > 0 && (
                <Banner tone="warn">
                  Needs your attention before this can be accepted: {proposal.issues.map((i) => i.message).join('; ')}
                </Banner>
              )}
            </Card>
          )
        })
      )}

      {open && (
        <Tearsheet
          title={`Review ${type?.displayName ?? open.typeKey}`}
          onClose={() => setOpen(null)}
          footer={
            <>
              <Button
                variant="danger"
                busy={busy}
                disabled={!can('capture', 'review')}
                title={can('capture', 'review') ? undefined : 'You cannot decide proposals on this project'}
                onClick={reject}
              >
                Reject
              </Button>
              <Button variant="primary" busy={busy} onClick={accept}>
                Accept and create
              </Button>
            </>
          }
        >
          {open.issues.length > 0 && (
            <Banner tone="warn">{open.issues.map((issue) => issue.message).join('; ')}</Banner>
          )}

          <Card title={capture ? `What the ${capture.kind} said` : 'What the capture said'}>
            <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
              {capture?.text ?? <span style={{ color: 'var(--ink-faint)' }}>Loading the original capture…</span>}
            </p>
            {open.rationale && (
              <p
                style={{
                  margin: 'var(--space-3) 0 0',
                  paddingTop: 'var(--space-3)',
                  borderTop: '1px solid var(--line)',
                  color: 'var(--ink-muted)',
                }}
              >
                <strong style={{ color: 'var(--ink)' }}>Why it read it that way: </strong>
                {open.rationale}
              </p>
            )}
            <p style={{ margin: 'var(--space-3) 0 0', fontSize: 12, color: 'var(--ink-faint)' }}>
              Drafted by {open.model ?? 'an agent'} · nothing exists until you accept
            </p>
          </Card>

          <Field label="Title" required>
            <Input value={title} onChange={setTitle} />
          </Field>

          <RecordFields
            fields={type?.fields ?? []}
            values={values}
            issues={open.issues}
            onChange={(key, value) => setValues((prev) => ({ ...prev, [key]: value }))}
          />

          <Field label="Note (kept if you reject)">
            <Textarea value={note} onChange={setNote} rows={2} />
          </Field>
        </Tearsheet>
      )}
    </ToolLandingPage>
  )
}
