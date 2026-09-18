import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import './tokens.css'

/**
 * Narrow enough that a four-column table turns into two words per line. The
 * field opens this on a phone more often than on anything else, so the table
 * has to stop being a table down here.
 */
export function useIsNarrow(breakpoint = 720): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.innerWidth <= breakpoint,
  )

  useEffect(() => {
    if (typeof window === 'undefined') return

    // matchMedia is the right instrument and jsdom does not implement it, so
    // feature-detect rather than assume. Falling back to a resize listener
    // keeps the component honest in a test environment instead of throwing
    // inside a render.
    if (typeof window.matchMedia === 'function') {
      const query = window.matchMedia(`(max-width: ${breakpoint}px)`)
      const update = () => setNarrow(query.matches)
      update()
      query.addEventListener('change', update)
      return () => query.removeEventListener('change', update)
    }

    const update = () => setNarrow(window.innerWidth <= breakpoint)
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [breakpoint])

  return narrow
}

/**
 * The component set. Twelve of them, deliberately.
 *
 * The teardown counted 103 components in Procore's design system and concluded
 * that the coherence came from somewhere else: a record list, a record and a
 * settings screen each have exactly one layout across every tool. Those live
 * in ../layouts. This file is the vocabulary those layouts are built from, and
 * it stays small on purpose — every component here is one somebody would
 * otherwise reinvent inconsistently.
 */

type Tone = 'neutral' | 'accent' | 'danger' | 'warn' | 'ok'

const TONE_STYLE: Record<Tone, CSSProperties> = {
  neutral: { background: 'var(--surface-sunken)', color: 'var(--ink-muted)', borderColor: 'var(--line)' },
  accent: { background: 'var(--accent-soft)', color: 'var(--accent)', borderColor: 'transparent' },
  danger: { background: 'var(--danger-soft)', color: 'var(--danger)', borderColor: 'transparent' },
  warn: { background: 'var(--warn-soft)', color: 'var(--warn)', borderColor: 'transparent' },
  ok: { background: 'var(--ok-soft)', color: 'var(--ok)', borderColor: 'transparent' },
}

export interface ButtonProps {
  children: ReactNode
  onClick?: () => void
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  type?: 'button' | 'submit'
  disabled?: boolean
  busy?: boolean
  title?: string
}

export function Button({
  children,
  onClick,
  variant = 'secondary',
  type = 'button',
  disabled,
  busy,
  title,
}: ButtonProps) {
  const base: CSSProperties = {
    // 36px is the smallest target that still works through a glove.
    minHeight: 36,
    padding: '0 14px',
    borderRadius: 'var(--radius)',
    border: '1px solid var(--line-strong)',
    background: 'var(--surface-raised)',
    color: 'var(--ink)',
    font: 'inherit',
    fontWeight: 550,
    cursor: disabled || busy ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.55 : 1,
  }
  const variants: Record<NonNullable<ButtonProps['variant']>, CSSProperties> = {
    primary: { background: 'var(--accent)', color: 'var(--accent-ink)', borderColor: 'transparent' },
    secondary: {},
    ghost: { background: 'transparent', borderColor: 'transparent', color: 'var(--ink-muted)' },
    danger: { background: 'transparent', borderColor: 'var(--line-strong)', color: 'var(--danger)' },
  }

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || busy}
      title={title}
      style={{ ...base, ...variants[variant] }}
    >
      {busy ? 'Working…' : children}
    </button>
  )
}

export function Pill({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 8px',
        borderRadius: 999,
        border: '1px solid',
        fontSize: 12,
        fontWeight: 600,
        whiteSpace: 'nowrap',
        ...TONE_STYLE[tone],
      }}
    >
      {children}
    </span>
  )
}

export function Banner({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : undefined}
      style={{
        padding: 'var(--space-3) var(--space-4)',
        borderRadius: 'var(--radius)',
        border: '1px solid',
        ...TONE_STYLE[tone],
      }}
    >
      {children}
    </div>
  )
}

export function Card({ children, title, actions }: { children: ReactNode; title?: ReactNode; actions?: ReactNode }) {
  return (
    <section
      style={{
        background: 'var(--surface-raised)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-raised)',
      }}
    >
      {(title || actions) && (
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'var(--space-3)',
            padding: 'var(--space-3) var(--space-4)',
            borderBottom: '1px solid var(--line)',
          }}
        >
          <h2 style={{ margin: 0, fontSize: 14, fontWeight: 650 }}>{title}</h2>
          {actions}
        </header>
      )}
      <div style={{ padding: 'var(--space-4)' }}>{children}</div>
    </section>
  )
}

export function Field({
  label,
  required,
  error,
  hint,
  children,
}: {
  label: string
  required?: boolean
  error?: string
  hint?: string
  children: ReactNode
}) {
  return (
    <label style={{ display: 'grid', gap: 6 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-muted)' }}>
        {label}
        {required && <span style={{ color: 'var(--danger)' }}> *</span>}
      </span>
      {children}
      {hint && !error && <span style={{ fontSize: 12, color: 'var(--ink-faint)' }}>{hint}</span>}
      {error && (
        <span role="alert" style={{ fontSize: 12, color: 'var(--danger)' }}>
          {error}
        </span>
      )}
    </label>
  )
}

const CONTROL: CSSProperties = {
  minHeight: 36,
  width: '100%',
  padding: '7px 10px',
  borderRadius: 'var(--radius)',
  border: '1px solid var(--line-strong)',
  background: 'var(--surface)',
  color: 'var(--ink)',
  font: 'inherit',
}

export function Input(props: {
  value: string
  onChange: (value: string) => void
  type?: string
  placeholder?: string
  name?: string
}) {
  return (
    <input
      name={props.name}
      type={props.type ?? 'text'}
      value={props.value}
      placeholder={props.placeholder}
      onChange={(e) => props.onChange(e.target.value)}
      style={CONTROL}
    />
  )
}

export function Textarea(props: { value: string; onChange: (value: string) => void; rows?: number }) {
  return (
    <textarea
      value={props.value}
      rows={props.rows ?? 4}
      onChange={(e) => props.onChange(e.target.value)}
      style={{ ...CONTROL, resize: 'vertical', lineHeight: 1.45 }}
    />
  )
}

export function Select(props: {
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
  placeholder?: string
}) {
  return (
    <select value={props.value} onChange={(e) => props.onChange(e.target.value)} style={CONTROL}>
      <option value="">{props.placeholder ?? '—'}</option>
      {props.options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

export interface Column<Row> {
  key: string
  header: string
  width?: string
  /** Hidden on narrow screens, where every line costs a scroll. */
  secondary?: boolean
  render: (row: Row) => ReactNode
}

export function Table<Row>({
  columns,
  rows,
  rowKey,
  onRowClick,
  empty,
}: {
  columns: Column<Row>[]
  rows: Row[]
  rowKey: (row: Row) => string
  onRowClick?: (row: Row) => void
  empty?: ReactNode
}) {
  const narrow = useIsNarrow()

  if (rows.length === 0) return <>{empty ?? <EmptyState title="Nothing here yet" />}</>

  // On a phone the same data reads as a stack: the first column is the
  // heading, the rest are labelled lines. A four-column table at 390px wraps
  // every cell to two words and is unusable through a glove.
  if (narrow) {
    const [lead, ...rest] = columns
    return (
      <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
        {rows.map((row) => (
          <div
            key={rowKey(row)}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
            style={{
              display: 'grid',
              gap: 6,
              padding: 'var(--space-3) 0',
              borderBottom: '1px solid var(--line)',
              cursor: onRowClick ? 'pointer' : 'default',
            }}
          >
            {lead && <div style={{ fontWeight: 650 }}>{lead.render(row)}</div>}
            {rest
              .filter((column) => !column.secondary)
              .map((column) => (
                <div key={column.key} style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'baseline' }}>
                  <span style={{ fontSize: 12, color: 'var(--ink-faint)', minWidth: 72 }}>{column.header}</span>
                  <span style={{ minWidth: 0 }}>{column.render(row)}</span>
                </div>
              ))}
          </div>
        ))}
      </div>
    )
  }

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
      <thead>
        <tr>
          {columns.map((column) => (
            <th
              key={column.key}
              scope="col"
              style={{
                textAlign: 'left',
                padding: '8px 12px',
                borderBottom: '1px solid var(--line)',
                color: 'var(--ink-muted)',
                fontSize: 12,
                fontWeight: 650,
                width: column.width,
              }}
            >
              {column.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={rowKey(row)}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
            style={{ cursor: onRowClick ? 'pointer' : 'default' }}
          >
            {columns.map((column) => (
              <td key={column.key} style={{ padding: '10px 12px', borderBottom: '1px solid var(--line)' }}>
                {column.render(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function Tabs({
  tabs,
  active,
  onSelect,
}: {
  tabs: { key: string; label: string; badge?: number }[]
  active: string
  onSelect: (key: string) => void
}) {
  return (
    <div role="tablist" style={{ display: 'flex', gap: 'var(--space-4)', overflowX: 'auto' }}>
      {tabs.map((tab) => {
        const selected = tab.key === active
        return (
          <button
            key={tab.key}
            role="tab"
            aria-selected={selected}
            onClick={() => onSelect(tab.key)}
            style={{
              appearance: 'none',
              border: 'none',
              background: 'none',
              font: 'inherit',
              fontWeight: selected ? 650 : 500,
              color: selected ? 'var(--ink)' : 'var(--ink-muted)',
              padding: '10px 0',
              borderBottom: `2px solid ${selected ? 'var(--accent)' : 'transparent'}`,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {tab.label}
            {tab.badge !== undefined && tab.badge > 0 && <span style={{ marginLeft: 6 }}>({tab.badge})</span>}
          </button>
        )
      })}
    </div>
  )
}

/**
 * The slide-over. Procore calls it a Tearsheet and uses it for the same job:
 * act on one thing without losing the list you found it in.
 */
export function Tearsheet({
  title,
  onClose,
  footer,
  children,
}: {
  title: ReactNode
  onClose: () => void
  footer?: ReactNode
  children: ReactNode
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={typeof title === 'string' ? title : undefined}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(16, 24, 40, 0.35)',
        display: 'flex',
        justifyContent: 'flex-end',
        zIndex: 20,
      }}
      onClick={onClose}
    >
      <aside
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(560px, 100%)',
          background: 'var(--surface)',
          boxShadow: 'var(--shadow-overlay)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'var(--space-3)',
            padding: 'var(--space-4)',
            borderBottom: '1px solid var(--line)',
          }}
        >
          <h2 style={{ margin: 0, fontSize: 16 }}>{title}</h2>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </header>
        <div style={{ padding: 'var(--space-4)', overflowY: 'auto', flex: 1, display: 'grid', gap: 'var(--space-4)' }}>
          {children}
        </div>
        {footer && (
          <footer
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              gap: 'var(--space-2)',
              padding: 'var(--space-4)',
              borderTop: '1px solid var(--line)',
            }}
          >
            {footer}
          </footer>
        )}
      </aside>
    </div>
  )
}

export function EmptyState({ title, detail, action }: { title: string; detail?: string; action?: ReactNode }) {
  return (
    <div style={{ padding: 'var(--space-6)', textAlign: 'center', color: 'var(--ink-muted)' }}>
      <p style={{ margin: 0, fontWeight: 600, color: 'var(--ink)' }}>{title}</p>
      {detail && <p style={{ margin: '6px 0 0', fontSize: 13 }}>{detail}</p>}
      {action && <div style={{ marginTop: 'var(--space-4)' }}>{action}</div>}
    </div>
  )
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <p role="status" style={{ padding: 'var(--space-5)', color: 'var(--ink-muted)' }}>
      {label}…
    </p>
  )
}

export function Initials({ name }: { name: string }) {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 26,
        height: 26,
        borderRadius: 999,
        background: 'var(--accent-soft)',
        color: 'var(--accent)',
        fontSize: 11,
        fontWeight: 700,
      }}
    >
      {initials}
    </span>
  )
}

/** Status pill tone, derived from the state's own terminal flag. */
export function statusTone(status: string, terminal: boolean | undefined): Tone {
  if (terminal) return status === 'void' || status === 'rejected' ? 'neutral' : 'ok'
  if (status === 'draft') return 'neutral'
  return 'accent'
}
