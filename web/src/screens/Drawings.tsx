import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PinView, SheetView } from '../api/client.js'
import { ToolLandingPage } from '../layouts/index.js'
import { useSession } from '../session/SessionProvider.tsx'
import { Banner, Button, Card, EmptyState, Pill, Select, Spinner } from '../ui/index.js'

/**
 * Drawings.
 *
 * The most-opened screen on any construction job and the one where being
 * wrong is most expensive: a crew building from a superseded sheet is the
 * accident this tool exists to prevent. So the sheet shown is always the
 * CURRENT revision, the label is on screen at all times, and a pin placed on
 * an older revision is drawn differently rather than silently moved forward —
 * a detail that changed between revisions may have moved with it.
 *
 * Rendering is pdf.js against a canvas. Note for whoever reads the tests: the
 * canvas path is NOT covered by them, because jsdom has no 2D context. What
 * is covered is everything a wrong answer would come from — which revision is
 * current, where a pin lands in sheet coordinates, and how a click on a
 * scaled canvas becomes a fraction of the page.
 */

/**
 * A click on the canvas, as a fraction of the page.
 *
 * Stored as fractions rather than pixels so a pin survives a different zoom,
 * a different screen and a re-render of the same sheet at another scale. The
 * bounding rectangle is used rather than the canvas's own width because CSS
 * may be scaling it, and reading the attribute would put every pin in the
 * wrong place on a laptop.
 */
export function pinFraction(
  rect: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const clamp = (n: number): number => Math.min(1, Math.max(0, n))
  return {
    x: Number(clamp((clientX - rect.left) / rect.width).toFixed(5)),
    y: Number(clamp((clientY - rect.top) / rect.height).toFixed(5)),
  }
}

/** Groups sheets the way a drawing index does: by discipline, then number. */
export function byDiscipline(sheets: SheetView[]): { discipline: string; sheets: SheetView[] }[] {
  const groups = new Map<string, SheetView[]>()
  for (const sheet of sheets) {
    const key = sheet.discipline ?? 'Unclassified'
    groups.set(key, [...(groups.get(key) ?? []), sheet])
  }
  return [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([discipline, group]) => ({
      discipline,
      // Sheet numbers sort as text on purpose: "A-101" before "A-1010" is
      // what a drawing index does, and numeric sorting would interleave
      // disciplines that share digits.
      sheets: [...group].sort((a, b) => a.number.localeCompare(b.number)),
    }))
}

export function Drawings({ projectId, projectName }: { projectId: string; projectName: string }) {
  const { api } = useSession()
  const [sheets, setSheets] = useState<SheetView[]>([])
  const [selected, setSelected] = useState<SheetView | null>(null)
  const [pins, setPins] = useState<PinView[]>([])
  const [discipline, setDiscipline] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api
      .sheets(projectId, discipline || undefined)
      .then((r) => {
        if (cancelled) return
        setSheets(r.sheets)
        setSelected((current) => (current && r.sheets.some((s) => s.drawingId === current.drawingId) ? current : r.sheets[0] ?? null))
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load the drawings')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [api, projectId, discipline])

  useEffect(() => {
    if (!selected) return
    let cancelled = false
    api
      .pins(selected.drawingId)
      .then((r) => {
        if (!cancelled) setPins(r.pins)
      })
      .catch(() => {
        if (!cancelled) setPins([])
      })
    return () => {
      cancelled = true
    }
  }, [api, selected])

  const groups = useMemo(() => byDiscipline(sheets), [sheets])
  const disciplines = useMemo(
    () => [...new Set(sheets.map((s) => s.discipline).filter((d): d is string => d !== null))].sort(),
    [sheets],
  )
  const stalePins = pins.filter((p) => !p.onCurrentRevision)

  return (
    <ToolLandingPage
      title="Drawings"
      subtitle={projectName}
      banner={
        error ? (
          <Banner tone="danger">{error}</Banner>
        ) : stalePins.length > 0 ? (
          <Banner tone="warn">
            {stalePins.length} {stalePins.length === 1 ? 'pin was' : 'pins were'} placed on an earlier revision of this
            sheet. What they point at may have moved.
          </Banner>
        ) : undefined
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 280px) 1fr', gap: 14, alignItems: 'start' }}>
        <Card
          title="Sheets"
          actions={
            disciplines.length > 1 ? (
              <Select
                value={discipline}
                onChange={setDiscipline}
                placeholder="All disciplines"
                options={disciplines.map((d) => ({ value: d, label: d }))}
              />
            ) : undefined
          }
        >
          {loading ? (
            <Spinner label="Loading the drawing index" />
          ) : sheets.length === 0 ? (
            <EmptyState
              title="No published sheets"
              detail="Nothing is current until a set is published, because a crew building from a check set is the accident this tool exists to prevent."
            />
          ) : (
            <nav style={{ display: 'grid', gap: 14 }}>
              {groups.map((group) => (
                <section key={group.discipline}>
                  <h3 style={{ margin: '0 0 4px', fontSize: 12, color: 'var(--ink-muted)', textTransform: 'uppercase' }}>
                    {group.discipline}
                  </h3>
                  <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 2 }}>
                    {group.sheets.map((sheet) => (
                      <li key={sheet.drawingId}>
                        <button
                          onClick={() => setSelected(sheet)}
                          aria-current={selected?.drawingId === sheet.drawingId}
                          style={{
                            width: '100%',
                            textAlign: 'left',
                            border: 'none',
                            borderRadius: 6,
                            padding: '6px 8px',
                            font: 'inherit',
                            cursor: 'pointer',
                            background:
                              selected?.drawingId === sheet.drawingId ? 'var(--accent-soft)' : 'transparent',
                          }}
                        >
                          <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{sheet.number}</strong>
                          <div style={{ fontSize: 12, color: 'var(--ink-muted)' }}>{sheet.title}</div>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </nav>
          )}
        </Card>

        {selected ? <SheetViewer sheet={selected} pins={pins} /> : <Card>{null}</Card>}
      </div>
    </ToolLandingPage>
  )
}

/**
 * One sheet, rendered, with its pins over it.
 *
 * The revision label is on screen at all times and never abbreviated away.
 * The single most expensive mistake this screen can make is showing a
 * superseded sheet without saying so.
 */
function SheetViewer({ sheet, pins }: { sheet: SheetView; pins: PinView[] }) {
  const { api } = useSession()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [scale, setScale] = useState(1)

  const render = useCallback(async (): Promise<void> => {
    const canvas = canvasRef.current
    if (!canvas) return
    setStatus('loading')
    try {
      const bytes = await api.sheetBytes(sheet.revisionId)
      // Imported lazily so the drawing renderer is not in the bundle for
      // somebody who only ever opens RFIs.
      const pdfjs = await import('pdfjs-dist')
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url).toString()

      const document = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise
      const page = await document.getPage(1)
      const viewport = page.getViewport({ scale: 2 * scale })
      const context = canvas.getContext('2d')
      if (!context) {
        setStatus('failed')
        return
      }
      canvas.width = viewport.width
      canvas.height = viewport.height
      await page.render({ canvas, canvasContext: context, viewport }).promise
      setStatus('ready')
    } catch {
      // Failing visibly. A blank white rectangle where a drawing should be is
      // indistinguishable from an empty sheet.
      setStatus('failed')
    }
  }, [api, sheet.revisionId, scale])

  useEffect(() => {
    void render()
  }, [render])

  return (
    <Card
      title={
        <span>
          {sheet.number} — {sheet.title}{' '}
          {/* Always on screen. A superseded sheet shown without saying so is
              the accident this whole tool exists to prevent. */}
          <Pill tone="accent">Rev {sheet.revisionLabel}</Pill>{' '}
          <span style={{ fontSize: 12, color: 'var(--ink-muted)', fontWeight: 400 }}>
            {sheet.setName}, issued {sheet.issuedOn.slice(0, 10)}
            {sheet.revisionCount > 1 ? ` · ${sheet.revisionCount} revisions` : ''}
          </span>
        </span>
      }
      actions={
        <div style={{ display: 'flex', gap: 4 }}>
          <Button variant="ghost" onClick={() => setScale((s) => Math.max(0.5, s - 0.5))} disabled={scale <= 0.5}>
            −
          </Button>
          <Button variant="ghost" onClick={() => setScale((s) => Math.min(4, s + 0.5))} disabled={scale >= 4}>
            +
          </Button>
        </div>
      }
    >
      {status === 'failed' ? (
        <Banner tone="danger">
          This sheet could not be rendered. Download it rather than working from a blank screen.
        </Banner>
      ) : null}

      <div style={{ position: 'relative', overflow: 'auto', maxHeight: '75vh', background: 'var(--surface-sunken)' }}>
        {status === 'loading' ? <Spinner label={`Rendering ${sheet.number}`} /> : null}
        <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: 'auto' }} />

        {pins.map((pin) => (
          <span
            key={pin.pinId}
            title={`${pin.recordId}${pin.onCurrentRevision ? '' : ` (placed on rev ${pin.revisionLabel})`}`}
            style={{
              position: 'absolute',
              left: `${Number(pin.x) * 100}%`,
              top: `${Number(pin.y) * 100}%`,
              transform: 'translate(-50%, -50%)',
              width: 18,
              height: 18,
              borderRadius: '50%',
              // A pin from an earlier revision is drawn hollow rather than
              // moved forward: the detail it points at may have moved with
              // the revision, and quietly relocating it would be a guess.
              background: pin.onCurrentRevision ? 'var(--accent)' : 'transparent',
              border: `2px solid ${pin.onCurrentRevision ? 'var(--accent)' : 'var(--warn, #b45309)'}`,
              boxShadow: '0 0 0 2px rgba(255,255,255,0.8)',
            }}
          />
        ))}
      </div>
    </Card>
  )
}
