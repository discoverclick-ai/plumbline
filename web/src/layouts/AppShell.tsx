import type { ReactNode } from 'react'
import { useIsNarrow } from '../ui/index.js'

/**
 * The frame every screen sits in.
 *
 * A top bar that never changes and a left rail of tools, which is the shape
 * every construction platform converges on for a reason: a superintendent
 * moves between four tools forty times a day, and a tab strip that scrolls
 * sideways costs them a gesture every time. The rail also has room for a count
 * beside a tool, which a tab strip does not, and a badge on "In your court" is
 * the single most useful pixel on the screen.
 *
 * On a phone the rail becomes the scrolling strip it used to be everywhere.
 * At 390px a 200px rail leaves 190px of content, and nothing in this product
 * is usable in 190px.
 */

export interface RailItem {
  key: string
  label: string
  /** Shown beside the label. Omitted when zero, because a zero badge is noise. */
  badge?: number
  /** Draws the badge as a warning. Overdue is the only thing that earns it. */
  urgent?: boolean
}

export function AppShell({
  brand,
  context,
  headerRight,
  items,
  active,
  onSelect,
  children,
}: {
  brand: ReactNode
  /** What you are inside: the company, or the job. */
  context?: ReactNode
  headerRight?: ReactNode
  items: RailItem[]
  active: string
  onSelect: (key: string) => void
  children: ReactNode
}) {
  const narrow = useIsNarrow(900)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', background: 'var(--surface-sunken)' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-4)',
          padding: '0 var(--space-4)',
          minHeight: 52,
          background: 'var(--surface)',
          borderBottom: '1px solid var(--line)',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', minWidth: 0 }}>
          {brand}
          {context ? (
            <>
              <span style={{ color: 'var(--line-strong)' }}>/</span>
              <div style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {context}
              </div>
            </>
          ) : null}
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
          {headerRight}
        </div>
      </header>

      <div style={{ display: 'flex', flex: 1, minHeight: 0, flexDirection: narrow ? 'column' : 'row' }}>
        <nav
          aria-label="Tools"
          style={
            narrow
              ? {
                  display: 'flex',
                  gap: 2,
                  padding: '0 var(--space-3)',
                  background: 'var(--surface)',
                  borderBottom: '1px solid var(--line)',
                  overflowX: 'auto',
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                }
              : {
                  width: 216,
                  flexShrink: 0,
                  background: 'var(--surface)',
                  borderRight: '1px solid var(--line)',
                  padding: 'var(--space-3) var(--space-2)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 1,
                  overflowY: 'auto',
                }
          }
        >
          {items.map((item) => {
            const selected = item.key === active
            return (
              <button
                key={item.key}
                type="button"
                aria-current={selected ? 'page' : undefined}
                onClick={() => onSelect(item.key)}
                style={{
                  appearance: 'none',
                  font: 'inherit',
                  fontSize: 14,
                  fontWeight: selected ? 650 : 500,
                  textAlign: 'left',
                  cursor: 'pointer',
                  // Never a `border` shorthand beside a `borderBottom`
                  // longhand. React drops a longhand it is handed as
                  // undefined, and the browser then falls back to its own
                  // button default, which is a 2px outset black line — which
                  // is exactly what the rail grew before this was written out
                  // in full.
                  borderTop: 'none',
                  borderLeft: 'none',
                  borderRight: 'none',
                  borderBottom: narrow
                    ? `2px solid ${selected ? 'var(--accent)' : 'transparent'}`
                    : 'none',
                  borderRadius: narrow ? 0 : 8,
                  // On the rail the selected tool is a filled row; on the strip
                  // it is an underline, because a filled pill in a scrolling
                  // strip reads as a button you press rather than where you are.
                  background: selected && !narrow ? 'var(--accent-soft)' : 'transparent',
                  color: selected ? 'var(--accent)' : 'var(--ink-muted)',
                  padding: narrow ? '12px 12px' : '8px 10px',
                  minHeight: 38,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  flexShrink: 0,
                }}
              >
                <span>{item.label}</span>
                {item.badge ? (
                  <span
                    style={{
                      marginLeft: 'auto',
                      fontSize: 11,
                      fontWeight: 650,
                      fontVariantNumeric: 'tabular-nums',
                      minWidth: 20,
                      textAlign: 'center',
                      padding: '1px 6px',
                      borderRadius: 999,
                      background: item.urgent ? 'var(--danger)' : 'var(--surface-sunken)',
                      color: item.urgent ? '#fff' : 'var(--ink-muted)',
                    }}
                  >
                    {item.badge}
                  </span>
                ) : null}
              </button>
            )
          })}
        </nav>

        <main style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>{children}</main>
      </div>
    </div>
  )
}
