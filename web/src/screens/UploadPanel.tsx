import { useRef, useState } from 'react'
import { Banner, Button, Card, Input, Select } from '../ui/index.js'

/**
 * Getting a document into the system.
 *
 * Four subsystems here were read-only from the browser: contracts, the
 * schedule, drawings and the statutory dates. Every one of them had a working
 * service, routes and tests, and no way for a person to put anything in. A
 * product where the data has to arrive by curl is a demo.
 *
 * This is the shared piece of all four: pick a file, name it, send it, and
 * read back exactly what the server made of it — including what it REFUSED,
 * which is the part every import screen in this industry hides. A schedule
 * import that silently drops eleven activities is one nobody discovers until
 * a lookahead is missing the work that matters.
 */

export interface UploadOutcome {
  ok: boolean
  headline: string
  /** Lines the person should read before they walk away. */
  detail: string[]
}

export function UploadPanel({
  title,
  description,
  accept,
  nameLabel,
  namePlaceholder,
  kinds,
  onUpload,
}: {
  title: string
  description: string
  accept: string
  nameLabel: string
  namePlaceholder: string
  /** Optional second field, e.g. which kind of instrument this is. */
  kinds?: { value: string; label: string }[]
  onUpload: (input: { name: string; kind: string; text: string; filename: string }) => Promise<UploadOutcome>
}) {
  const [name, setName] = useState('')
  const [kind, setKind] = useState(kinds?.[0]?.value ?? '')
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<UploadOutcome | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  async function handle(file: File): Promise<void> {
    setBusy(true)
    setOutcome(null)
    try {
      const text = await file.text()
      setOutcome(
        await onUpload({
          // The filename is a reasonable default name and a terrible
          // requirement: somebody uploading "export (3).xer" should not have
          // to retype it, and should be able to.
          name: name.trim() || file.name.replace(/\.[^.]+$/, ''),
          kind,
          text,
          filename: file.name,
        }),
      )
    } catch (err) {
      setOutcome({
        ok: false,
        headline: err instanceof Error ? err.message : 'That did not go through',
        detail: [],
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title={title}>
      <p style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--ink-muted)' }}>{description}</p>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--ink-muted)' }}>
          {nameLabel}
          <Input value={name} onChange={setName} placeholder={namePlaceholder} />
        </label>
        {kinds ? (
          <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--ink-muted)' }}>
            Kind
            <Select value={kind} onChange={setKind} options={kinds} placeholder={kinds[0]?.label ?? ''} />
          </label>
        ) : null}
        <input
          ref={fileInput}
          type="file"
          accept={accept}
          style={{ display: 'none' }}
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void handle(file)
            event.target.value = ''
          }}
        />
        <Button onClick={() => fileInput.current?.click()} disabled={busy}>
          {busy ? 'Reading…' : 'Choose a file'}
        </Button>
      </div>

      {outcome ? (
        <div style={{ marginTop: 12 }}>
          <Banner tone={outcome.ok ? 'accent' : 'danger'}>{outcome.headline}</Banner>
          {/*
            What was refused, in full, next to what succeeded. Every import
            screen in this industry hides this, and a schedule import that
            silently drops eleven activities is one nobody discovers until a
            lookahead is missing the work that matters.
          */}
          {outcome.detail.length > 0 ? (
            <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 13, color: 'var(--ink-muted)' }}>
              {outcome.detail.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </Card>
  )
}
