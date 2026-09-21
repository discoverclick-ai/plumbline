import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ConstructionRecord } from '@plumbline/shared'
import { ApiError } from '../api/client.js'
import { ToolLandingPage } from '../layouts/index.js'
import { atLeast, useProjectScope, useSession } from '../session/SessionProvider.tsx'
import { Banner, Button, Card, Field, Input, Pill, Select, Spinner, Table, Tabs, Tearsheet, statusTone } from '../ui/index.js'
import { RecordFields, toRequestBody, type FieldValues } from './RecordFields.tsx'
import { RecordList } from './RecordList.tsx'

/**
 * The record list, for every tool.
 *
 * There is no RFI screen in this codebase and there never will be. The tabs
 * are the record types this person may read, taken from the registry and
 * filtered by the permission map; the table columns are the same for all of
 * them because a record is a record; and the create form is rendered from the
 * type's own fields. A tool added by a migration appears here on next load.
 */

export function ToolLanding({
  projectId,
  projectName,
  onOpenRecord,
}: {
  projectId: string
  projectName: string
  onOpenRecord: (recordId: string) => void
}) {
  const { api, types, me, level, can } = useSession()
  // Project tools read 'none' until the session is scoped to this project.
  const scoped = useProjectScope(projectId)

  // Only the types whose tool this person can read. Rendering a tab that
  // returns 403 on click is worse than not rendering it.
  const readable = useMemo(
    () => [...types.values()].filter((type) => atLeast(level(type.toolKey), 'read_only')),
    [types, me, level],
  )

  const [active, setActive] = useState<string>('')
  const [records, setRecords] = useState<ConstructionRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [composing, setComposing] = useState(false)
  const [title, setTitle] = useState('')
  const [values, setValues] = useState<FieldValues>({})
  const [issues, setIssues] = useState<{ field: string; message: string }[]>([])
  const [busy, setBusy] = useState(false)
  const [members, setMembers] = useState<{ userId: string; name: string; organization: string }[]>([])
  const [assignee, setAssignee] = useState('')

  useEffect(() => {
    if (!active && readable[0]) setActive(readable[0].key)
  }, [readable, active])

  const type = types.get(active)

  const load = useCallback(async () => {
    if (!active || !scoped) return
    setLoading(true)
    try {
      const result = await api.records(projectId, { type: active })
      setRecords(result.records)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load records')
    } finally {
      setLoading(false)
    }
  }, [api, projectId, active, scoped])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!scoped) return
    api
      .members(projectId)
      .then((result) => setMembers(result.members))
      .catch(() => setMembers([]))
  }, [api, projectId, scoped])

  // `standard` creates; a read-only user creates only if their template grants
  // the tool's `create` privilege. That is the server's rule, mirrored here
  // only to decide whether to show the button.
  const canCreate = type
    ? atLeast(level(type.toolKey), 'standard') || (atLeast(level(type.toolKey), 'read_only') && can(type.toolKey, 'create'))
    : false

  // True when any state this type can reach hands the ball to an assignee.
  const needsAssignee = (type?.states ?? []).some((state) => state.ballInCourt === 'assignee')

  async function create() {
    if (!type) return
    setBusy(true)
    setIssues([])
    try {
      const created = await api.createRecord(projectId, {
        typeKey: type.key,
        title,
        body: toRequestBody(values),
        ...(assignee ? { participants: [{ userId: assignee, role: 'assignee' as const }] } : {}),
      })
      setComposing(false)
      setTitle('')
      setValues({})
      setAssignee('')
      await load()
      onOpenRecord(created.record.id)
    } catch (err) {
      if (err instanceof ApiError) {
        setIssues(err.issues)
        if (err.issues.length === 0) setError(err.message)
      } else {
        setError(err instanceof Error ? err.message : 'Could not create that record')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <ToolLandingPage
      title={type?.displayNamePlural ?? 'Records'}
      subtitle={projectName}
      actions={
        canCreate && (
          <Button variant="primary" onClick={() => setComposing(true)}>
            New {type?.displayName}
          </Button>
        )
      }
      banner={error && <Banner tone="danger">{error}</Banner>}
      tabs={
        <Tabs
          active={active}
          onSelect={setActive}
          tabs={readable.map((entry) => ({ key: entry.key, label: entry.displayNamePlural }))}
        />
      }
    >
      <Card>
        {loading ? (
          <Spinner label="Loading" />
        ) : (
          <RecordList
            type={type}
            types={types}
            records={records}
            people={members}
            currentUserId={me?.user?.id ?? null}
            onOpenRecord={onOpenRecord}
            empty={
              <p style={{ color: 'var(--ink-muted)', margin: 0 }}>
                No {type?.displayNamePlural.toLowerCase()} on this project yet.
              </p>
            }
          />
        )}
      </Card>

      {composing && type && (
        <Tearsheet
          title={`New ${type.displayName}`}
          onClose={() => setComposing(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setComposing(false)}>
                Cancel
              </Button>
              <Button variant="primary" busy={busy} onClick={create}>
                Create
              </Button>
            </>
          }
        >
          <Field label="Title" required {...(issues.find((i) => i.field === 'title') ? { error: 'Title is required' } : {})}>
            <Input value={title} onChange={setTitle} />
          </Field>
          {/*
            Who this goes to. Not decoration: a type whose next state hands the
            ball to an assignee cannot be submitted without one, so a form that
            cannot name a person creates records that dead-end.
          */}
          {needsAssignee && (
            <Field
              label="Assign to"
              hint={`Whoever should act on this ${type.displayName.toLowerCase()} next`}
              {...(issues.find((i) => i.field === 'participants') ? { error: 'Choose somebody to assign this to' } : {})}
            >
              <Select
                value={assignee}
                onChange={setAssignee}
                placeholder="Nobody yet"
                options={members.map((member) => ({
                  value: member.userId,
                  label: `${member.name} · ${member.organization}`,
                }))}
              />
            </Field>
          )}
          <RecordFields
            fields={type.fields}
            values={values}
            issues={issues}
            onChange={(key, value) => setValues((prev) => ({ ...prev, [key]: value }))}
          />
        </Tearsheet>
      )}
    </ToolLandingPage>
  )
}
