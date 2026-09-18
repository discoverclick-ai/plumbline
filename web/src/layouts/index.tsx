import type { ReactNode } from 'react'

/**
 * The page templates.
 *
 * This is the finding from the Procore teardown, applied: every tool in the
 * product is one of these two layouts. A record list looks the same whether it
 * is RFIs or a tool added next month, and a record looks the same whether it
 * is a submittal or a punch item, because neither screen is written per tool —
 * both are composed here and filled from the type registry.
 *
 * The consequence worth protecting: a new tool ships with no new screen, no
 * new CSS, and no client release.
 */

const PAGE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  flex: 1,
}

const BODY: React.CSSProperties = {
  padding: 'var(--space-5)',
  display: 'grid',
  gap: 'var(--space-4)',
  alignContent: 'start',
  overflowY: 'auto',
  flex: 1,
}

export function ToolLandingPage({
  title,
  subtitle,
  actions,
  tabs,
  banner,
  aside,
  children,
}: {
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  tabs?: ReactNode
  banner?: ReactNode
  aside?: ReactNode
  children: ReactNode
}) {
  return (
    <div style={PAGE}>
      <header
        style={{
          padding: 'var(--space-5) var(--space-5) 0',
          background: 'var(--surface)',
          borderBottom: '1px solid var(--line)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 'var(--space-4)',
            flexWrap: 'wrap',
          }}
        >
          <div>
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 650 }}>{title}</h1>
            {subtitle && <p style={{ margin: '4px 0 0', color: 'var(--ink-muted)' }}>{subtitle}</p>}
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>{actions}</div>
        </div>
        <div style={{ marginTop: 'var(--space-3)' }}>{tabs}</div>
      </header>

      <div style={{ ...BODY, gridTemplateColumns: aside ? 'minmax(0, 1fr) 280px' : 'minmax(0, 1fr)' }}>
        {banner && <div style={{ gridColumn: '1 / -1' }}>{banner}</div>}
        <main style={{ minWidth: 0, display: 'grid', gap: 'var(--space-4)', alignContent: 'start' }}>{children}</main>
        {aside && <aside style={{ display: 'grid', gap: 'var(--space-4)', alignContent: 'start' }}>{aside}</aside>}
      </div>
    </div>
  )
}

export function DetailPage({
  breadcrumbs,
  title,
  status,
  banner,
  tabs,
  footer,
  children,
}: {
  breadcrumbs?: ReactNode
  title: ReactNode
  status?: ReactNode
  banner?: ReactNode
  tabs?: ReactNode
  /** The action bar. Populated from what the server says this actor may do. */
  footer?: ReactNode
  children: ReactNode
}) {
  return (
    <div style={PAGE}>
      <header
        style={{
          padding: 'var(--space-4) var(--space-5) 0',
          background: 'var(--surface)',
          borderBottom: '1px solid var(--line)',
        }}
      >
        {breadcrumbs && <nav style={{ fontSize: 13, color: 'var(--ink-muted)' }}>{breadcrumbs}</nav>}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-3)',
            flexWrap: 'wrap',
            marginTop: 'var(--space-2)',
          }}
        >
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 650 }}>{title}</h1>
          {status}
        </div>
        <div style={{ marginTop: 'var(--space-3)' }}>{tabs}</div>
      </header>

      <div style={{ ...BODY, maxWidth: 880, width: '100%' }}>
        {banner}
        {children}
      </div>

      {footer && (
        <footer
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 'var(--space-2)',
            padding: 'var(--space-4) var(--space-5)',
            borderTop: '1px solid var(--line)',
            background: 'var(--surface)',
            position: 'sticky',
            bottom: 0,
          }}
        >
          {footer}
        </footer>
      )}
    </div>
  )
}
