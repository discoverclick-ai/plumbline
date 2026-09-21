import { useCallback, useEffect, useRef, useState } from 'react'
import type { AttachmentListItem } from '../api/client.js'
import { useSession } from '../session/SessionProvider.tsx'
import { Banner, Button, Spinner, Table } from '../ui/index.js'

/**
 * What is attached to a record.
 *
 * The routes for this existed with no client calling any of them: a record
 * could hold the sketch that answers the RFI and no screen in the product
 * could put one there or get one back. That is the same failure as a service
 * with no route, one layer further out.
 *
 * Provenance is the column that matters. An attachment on a job is evidence —
 * who put this revision here, and when — and a list of filenames without
 * either is a folder, which is what this is meant to replace.
 */

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function Attachments({ recordId, canAttach }: { recordId: string; canAttach: boolean }) {
  const { api } = useSession()
  const [items, setItems] = useState<AttachmentListItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  const load = useCallback(() => {
    api
      .attachments(recordId)
      .then((r) => setItems(r.attachments))
      .catch((err: unknown) => {
        // Not an empty list. "Nothing attached" shown to somebody whose
        // request failed is how a drawing gets uploaded twice.
        setError(err instanceof Error ? err.message : 'Could not load what is attached')
        setItems(null)
      })
  }, [api, recordId])

  useEffect(load, [load])

  async function upload(files: FileList | null): Promise<void> {
    if (!files || files.length === 0) return
    setBusy(true)
    setError(null)
    try {
      // One at a time rather than in parallel. Jobsite connections are thin,
      // and six concurrent uploads of a 20MB sketch is how the whole batch
      // fails instead of the sixth one.
      for (const file of Array.from(files)) {
        await api.attach(recordId, file)
      }
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That file was refused')
    } finally {
      setBusy(false)
      if (input.current) input.current.value = ''
    }
  }

  return (
    <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
      {error ? <Banner tone="danger">{error}</Banner> : null}

      {canAttach ? (
        <div>
          <input
            ref={input}
            type="file"
            multiple
            aria-label="Attach a file"
            disabled={busy}
            onChange={(event) => void upload(event.target.files)}
          />
          {busy ? <span style={{ marginLeft: 8, color: 'var(--ink-muted)' }}>Uploading…</span> : null}
        </div>
      ) : null}

      {items === null && error === null ? (
        <Spinner label="Loading attachments" />
      ) : items === null ? null : (
        <Table
          rows={items}
          rowKey={(row) => row.id}
          empty={<p style={{ margin: 0, color: 'var(--ink-muted)' }}>Nothing attached to this record yet.</p>}
          columns={[
            {
              key: 'filename',
              header: 'File',
              render: (row) => (
                <Button
                  variant="ghost"
                  onClick={() => {
                    // Fetched with the bearer token, because a plain link to
                    // the API would download a 401.
                    void api.attachmentUrl(row.id).then((url) => {
                      const link = document.createElement('a')
                      link.href = url
                      link.download = row.filename
                      link.click()
                      URL.revokeObjectURL(url)
                    })
                  }}
                >
                  {row.filename}
                </Button>
              ),
            },
            {
              key: 'size',
              header: 'Size',
              width: '100px',
              secondary: true,
              render: (row) => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{size(row.byteSize)}</span>,
            },
            {
              key: 'by',
              header: 'Attached by',
              width: '200px',
              render: (row) => (
                <>
                  <div>{row.uploadedByName ?? 'Somebody no longer on this job'}</div>
                  <div style={{ fontSize: 12, color: 'var(--ink-muted)' }}>
                    {new Date(row.createdAt).toLocaleDateString()}
                  </div>
                </>
              ),
            },
          ]}
        />
      )}
    </div>
  )
}
