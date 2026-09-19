import { useEffect, useMemo, useRef, useState } from 'react'
import type { PhotoView } from '../api/client.js'
import { ToolLandingPage } from '../layouts/index.js'
import { useSession } from '../session/SessionProvider.tsx'
import { Banner, Button, Card, EmptyState, Pill, Spinner } from '../ui/index.js'

/**
 * The photographs.
 *
 * Organised by the day they were TAKEN, which is the only axis anybody
 * searches on. "Show me the week we poured the north footings" is the
 * question; nobody has ever asked to see the photographs somebody uploaded on
 * a Tuesday.
 *
 * So there is no folder tree. Every product that built one ended up with
 * photographs filed in three places and findable in none, and the date is a
 * better index than a hierarchy a different person made two years ago.
 *
 * The undated ones get their own place at the top rather than being sorted to
 * the bottom of a list ordered by a date they do not have. A photograph with
 * no timestamp is a gap in the evidence, and a gap somebody can see is worth
 * more than one buried at the end.
 */

/** "Monday 2 March", which is how a day gets referred to on a job. */
export function dayLabel(stamp: string): string {
  const [y, m, d] = stamp.slice(0, 10).split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  })
}

export function timeLabel(stamp: string): string {
  return stamp.slice(11, 16)
}

export interface PhotoDay {
  day: string
  label: string
  photos: PhotoView[]
}

/**
 * Groups by the day the shutter opened, newest first, with the undated ones
 * first of all.
 */
export function groupByDay(photos: PhotoView[]): { undated: PhotoView[]; days: PhotoDay[] } {
  const undated = photos.filter((p) => p.takenAtLocal === null)
  const byDay = new Map<string, PhotoView[]>()

  for (const photo of photos) {
    if (photo.takenAtLocal === null) continue
    const day = photo.takenAtLocal.slice(0, 10)
    byDay.set(day, [...(byDay.get(day) ?? []), photo])
  }

  const days = [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([day, group]) => ({
      day,
      label: dayLabel(day),
      photos: [...group].sort((a, b) => (a.takenAtLocal! < b.takenAtLocal! ? -1 : 1)),
    }))

  return { undated, days }
}

/** EXIF orientation as a CSS transform. 6 and 8 are a phone held sideways. */
export function orientationTransform(orientation: number | null): string | undefined {
  switch (orientation) {
    case 3:
      return 'rotate(180deg)'
    case 6:
      return 'rotate(90deg)'
    case 8:
      return 'rotate(270deg)'
    default:
      return undefined
  }
}

function Thumbnail({ photo, onOpen }: { photo: PhotoView; onOpen: () => void }) {
  const { api } = useSession()
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let created: string | null = null
    api
      .photoObjectUrl(photo.id)
      .then((objectUrl) => {
        if (cancelled) {
          URL.revokeObjectURL(objectUrl)
          return
        }
        created = objectUrl
        setUrl(objectUrl)
      })
      .catch(() => setUrl(null))
    return () => {
      cancelled = true
      // Revoked on unmount. A gallery that leaks one object URL per
      // photograph will hold a whole job's images in memory by lunchtime.
      if (created) URL.revokeObjectURL(created)
    }
  }, [api, photo.id])

  return (
    <button
      onClick={onOpen}
      title={photo.caption ?? photo.filename ?? ''}
      style={{
        border: '1px solid var(--line)',
        borderRadius: 8,
        padding: 0,
        overflow: 'hidden',
        background: 'var(--surface-sunken)',
        cursor: 'pointer',
        aspectRatio: '4 / 3',
        position: 'relative',
      }}
    >
      {url ? (
        <img
          src={url}
          alt={photo.caption ?? photo.filename ?? 'Site photograph'}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            transform: orientationTransform(photo.orientation),
          }}
        />
      ) : (
        <span style={{ fontSize: 12, color: 'var(--ink-muted)' }}>…</span>
      )}
      {photo.takenAtLocal ? (
        <span
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            background: 'rgba(0,0,0,0.55)',
            color: 'white',
            fontSize: 11,
            padding: '2px 6px',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {timeLabel(photo.takenAtLocal)}
          {photo.latitude ? ' · located' : ''}
        </span>
      ) : null}
    </button>
  )
}

export function Photos({ projectId, projectName }: { projectId: string; projectName: string }) {
  const { api } = useSession()
  const [photos, setPhotos] = useState<PhotoView[]>([])
  const [open, setOpen] = useState<PhotoView | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const reload = (): void => {
    setLoading(true)
    api
      .photos(projectId)
      .then((r) => setPhotos(r.photos))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load the photographs'))
      .finally(() => setLoading(false))
  }

  useEffect(reload, [api, projectId])

  const { undated, days } = useMemo(() => groupByDay(photos), [photos])
  const located = photos.filter((p) => p.latitude !== null).length

  async function upload(files: FileList): Promise<void> {
    setBusy(true)
    setError(null)
    let added = 0
    let duplicates = 0
    try {
      for (const file of [...files]) {
        const result = await api.uploadPhoto(projectId, file)
        if (result.duplicate) duplicates += 1
        else added += 1
      }
      setNote(
        `${added} added` +
          // Said out loud rather than silently swallowed: somebody who just
          // selected forty files and sees nothing change will select them
          // again.
          (duplicates > 0 ? `, ${duplicates} already on this job` : ''),
      )
      reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That upload did not go through')
    } finally {
      setBusy(false)
    }
  }

  return (
    <ToolLandingPage
      title="Photos"
      subtitle={projectName}
      banner={
        error ? (
          <Banner tone="danger">{error}</Banner>
        ) : undated.length > 0 ? (
          <Banner tone="warn">
            {undated.length} {undated.length === 1 ? 'photograph has' : 'photographs have'} no date from the camera.
            A photograph with no timestamp proves very little.
          </Banner>
        ) : note ? (
          <Banner tone="accent">{note}</Banner>
        ) : undefined
      }
    >
      <Card
        title={`${photos.length} photographs · ${located} located`}
        actions={
          <>
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              multiple
              style={{ display: 'none' }}
              onChange={(event) => {
                if (event.target.files?.length) void upload(event.target.files)
                event.target.value = ''
              }}
            />
            <Button onClick={() => fileInput.current?.click()} disabled={busy}>
              {busy ? 'Uploading…' : 'Add photographs'}
            </Button>
          </>
        }
      >
        {loading ? (
          <Spinner label="Loading the photographs" />
        ) : photos.length === 0 ? (
          <EmptyState
            title="No photographs on this job yet"
            detail="Upload straight from a phone. What the camera recorded — when, and where — is kept exactly as it was taken."
          />
        ) : (
          <div style={{ display: 'grid', gap: 22 }}>
            {undated.length > 0 && (
              <section>
                <h3 style={{ margin: '0 0 8px', fontSize: 14 }}>
                  No date from the camera <Pill tone="warn">{undated.length}</Pill>
                </h3>
                <Grid photos={undated} onOpen={setOpen} />
              </section>
            )}
            {days.map((day) => (
              <section key={day.day}>
                <h3 style={{ margin: '0 0 8px', fontSize: 14 }}>
                  {day.label}{' '}
                  <span style={{ color: 'var(--ink-muted)', fontWeight: 400 }}>{day.photos.length}</span>
                </h3>
                <Grid photos={day.photos} onOpen={setOpen} />
              </section>
            ))}
          </div>
        )}
      </Card>

      {open ? <PhotoDetail photo={open} onClose={() => setOpen(null)} /> : null}
    </ToolLandingPage>
  )
}

function Grid({ photos, onOpen }: { photos: PhotoView[]; onOpen: (photo: PhotoView) => void }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 8 }}>
      {photos.map((photo) => (
        <Thumbnail key={photo.id} photo={photo} onOpen={() => onOpen(photo)} />
      ))}
    </div>
  )
}

/**
 * One photograph, with everything the camera said about it.
 *
 * The metadata is the point of this panel, not a footnote. A photograph with
 * a time and a location is evidence; the same photograph without them is an
 * illustration, and somebody choosing what to attach to a notice needs to
 * see which one they are holding.
 */
function PhotoDetail({ photo, onClose }: { photo: PhotoView; onClose: () => void }) {
  const { api } = useSession()
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    let created: string | null = null
    api.photoObjectUrl(photo.id).then((objectUrl) => {
      created = objectUrl
      setUrl(objectUrl)
    })
    return () => {
      if (created) URL.revokeObjectURL(created)
    }
  }, [api, photo.id])

  return (
    <Card
      title={photo.caption ?? photo.filename ?? 'Photograph'}
      actions={
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div style={{ display: 'grid', gap: 14 }}>
        {url ? (
          <img
            src={url}
            alt={photo.caption ?? 'Site photograph'}
            style={{
              maxWidth: '100%',
              maxHeight: '60vh',
              objectFit: 'contain',
              transform: orientationTransform(photo.orientation),
            }}
          />
        ) : (
          <Spinner label="Loading" />
        )}

        <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 14px', margin: 0, fontSize: 13 }}>
          <dt style={{ color: 'var(--ink-muted)' }}>Taken</dt>
          <dd style={{ margin: 0 }}>
            {photo.takenAtLocal ? (
              photo.takenAtLocal.replace('T', ' ')
            ) : (
              // Said plainly. Somebody attaching this to a notice needs to
              // know the camera never said when it was taken.
              <span style={{ color: 'var(--danger)' }}>No timestamp from the camera</span>
            )}
          </dd>
          <dt style={{ color: 'var(--ink-muted)' }}>Uploaded</dt>
          <dd style={{ margin: 0 }}>
            {new Date(photo.uploadedAt).toLocaleString()}
            {photo.uploadedByName ? ` by ${photo.uploadedByName}` : ''}
          </dd>
          <dt style={{ color: 'var(--ink-muted)' }}>Location</dt>
          <dd style={{ margin: 0 }}>
            {photo.latitude && photo.longitude ? `${photo.latitude}, ${photo.longitude}` : 'Not recorded'}
          </dd>
          {photo.cameraModel ? (
            <>
              <dt style={{ color: 'var(--ink-muted)' }}>Camera</dt>
              <dd style={{ margin: 0 }}>{[photo.cameraMake, photo.cameraModel].filter(Boolean).join(' ')}</dd>
            </>
          ) : null}
          {photo.albums.length > 0 ? (
            <>
              <dt style={{ color: 'var(--ink-muted)' }}>Albums</dt>
              <dd style={{ margin: 0 }}>{photo.albums.join(', ')}</dd>
            </>
          ) : null}
        </dl>
      </div>
    </Card>
  )
}
