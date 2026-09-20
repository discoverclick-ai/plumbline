import { useEffect, useRef, useState } from 'react'
import type { SearchHit } from '../api/client.js'
import { useSession } from '../session/SessionProvider.tsx'
import { Input, Pill, Spinner } from '../ui/index.js'

/**
 * Finding a record again.
 *
 * The single most-used affordance in any construction product and it had no
 * client: the route existed, the tsvector column existed, and nothing asked.
 *
 * Two decisions worth writing down.
 *
 * It searches EVERY project this person is on, not the one they happen to be
 * looking at. Half of all searches are "which job was that weld RFI on", and
 * a box scoped to the current project cannot answer the question people
 * actually have. The project name is on every result for the same reason.
 *
 * And it searches designations. "RFI-014" is what somebody reads off a
 * drawing and types, and a search that only matched prose would miss the
 * commonest query in the product.
 */

const STATUS_TONE = (status: string): 'neutral' | 'ok' => (/closed|answered|approved|issued/.test(status) ? 'ok' : 'neutral')

export function SearchBox({ onOpenRecord }: { onOpenRecord: (recordId: string, projectId: string) => void }) {
  const { api } = useSession()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchHit[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const text = query.trim()
    if (text.length < 2) {
      setResults(null)
      return
    }
    // Debounced. Every keystroke is a tsvector query across a tenant's whole
    // record table, and a search-as-you-type that fires on each one turns a
    // cheap index scan into a load test.
    const timer = setTimeout(() => {
      setSearching(true)
      api
        .search(text)
        .then((r) => setResults(r.results))
        .catch(() => setResults([]))
        .finally(() => setSearching(false))
    }, 200)
    return () => clearTimeout(timer)
  }, [api, query])

  useEffect(() => {
    const away = (event: MouseEvent): void => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [])

  return (
    <div ref={box} style={{ position: 'relative', flex: '1 1 220px', maxWidth: 420 }}>
      <Input
        value={query}
        onChange={(value) => {
          setQuery(value)
          setOpen(true)
        }}
        placeholder="Search RFI-014, anchor bolt, Bishop…"
      />

      {open && results !== null ? (
        <div
          role="listbox"
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            marginTop: 4,
            background: 'var(--surface)',
            border: '1px solid var(--line)',
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
            maxHeight: 360,
            overflow: 'auto',
            zIndex: 20,
          }}
        >
          {searching && results.length === 0 ? (
            <div style={{ padding: 10 }}>
              <Spinner label="Searching" />
            </div>
          ) : results.length === 0 ? (
            <p style={{ margin: 0, padding: 12, fontSize: 13, color: 'var(--ink-muted)' }}>
              Nothing matching “{query.trim()}” on any job you are on.
            </p>
          ) : (
            results.map((hit) => (
              <button
                key={hit.id}
                role="option"
                aria-selected={false}
                onClick={() => {
                  setOpen(false)
                  onOpenRecord(hit.id, hit.projectId)
                }}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  border: 'none',
                  borderBottom: '1px solid var(--line)',
                  background: 'transparent',
                  padding: '8px 12px',
                  font: 'inherit',
                  cursor: 'pointer',
                }}
              >
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                  <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{hit.designation}</strong>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {hit.title}
                  </span>
                  <Pill tone={STATUS_TONE(hit.status)}>{hit.status.replace(/_/g, ' ')}</Pill>
                </div>
                {/*
                  The project on every row. Half of all searches are "which
                  job was that weld RFI on", and a result that does not say is
                  a result somebody has to open to find out.
                */}
                <div style={{ fontSize: 12, color: 'var(--ink-muted)' }}>{hit.projectName}</div>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  )
}
