import { useEffect, useMemo, useState } from 'react'
import type { ConstructionRecord } from '@plumbline/shared'
import type { RecordTypeView } from '../api/client.js'
import { Button, Input, Pill, Select, Table, statusTone } from '../ui/index.js'

/**
 * One list, every tool, with the density a project manager actually works in.
 *
 * The four-column table this replaced showed number, title, status and due
 * date. A PM looking at eighty RFIs needs the ball in court, how long it has
 * been sitting, the discipline, the drawing it is against and whether it
 * carries cost impact, and needs to filter to the ones that are theirs and
 * overdue. Four columns means they export to Excel and work there, which is
 * how a construction platform loses the job it was bought for.
 *
 * The columns come from the TYPE REGISTRY rather than a per-tool file. Every
 * field a record type declares is available as a column and, where it is a
 * select, as a filter. That is the payoff of the kernel showing up in the
 * interface: a tool added by a migration next month arrives with its own
 * columns and its own filters and nobody writes a screen.
 */

/** The record's own columns, which exist whatever the tool is. */
type FixedKey = 'designation' | 'title' | 'status' | 'ballInCourt' | 'age' | 'due' | 'created' | 'updated'

export interface ListPerson {
  userId: string
  name: string
  organization: string
}

interface ColumnSpec {
  key: string
  label: string
  /** Shown before anybody touches the picker. */
  byDefault: boolean
  width?: string
  value: (row: ConstructionRecord) => string
  render?: (row: ConstructionRecord) => React.ReactNode
}

function days(from: string): number {
  return Math.max(0, Math.floor((Date.now() - Date.parse(from)) / 86_400_000))
}

function shortDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString() : ''
}

/**
 * Quoting is not optional and is the reason this is written out rather than
 * joined with commas. A record title is free text and routinely contains a
 * comma; an export that splits one row into two is worse than no export,
 * because it is wrong in a file somebody then works from.
 */
export function toCsv(headers: string[], rows: string[][]): string {
  const cell = (value: string): string =>
    /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
  return [headers, ...rows].map((row) => row.map(cell).join(',')).join('\r\n')
}

export function RecordList({
  type,
  types,
  records,
  people,
  currentUserId,
  onOpenRecord,
  empty,
}: {
  type: RecordTypeView | undefined
  types: Map<string, RecordTypeView>
  records: ConstructionRecord[]
  people: ListPerson[]
  currentUserId: string | null
  onOpenRecord: (recordId: string) => void
  empty: React.ReactNode
}) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('')
  const [holder, setHolder] = useState('')
  const [overdueOnly, setOverdueOnly] = useState(false)
  const [fieldFilters, setFieldFilters] = useState<Record<string, string>>({})
  const [picking, setPicking] = useState(false)
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [sort, setSort] = useState<{ key: string; desc: boolean }>({ key: 'designation', desc: true })

  // Filters are per tool. Carrying "status: answered" from RFIs onto Punch
  // List shows an empty table and reads as a tool with nothing in it.
  useEffect(() => {
    setQuery('')
    setStatus('')
    setHolder('')
    setOverdueOnly(false)
    setFieldFilters({})
  }, [type?.key])

  const nameOf = useMemo(() => {
    const map = new Map(people.map((p) => [p.userId, p.name]))
    return (id: string | null): string => (id ? (map.get(id) ?? 'Somebody not on this project') : '')
  }, [people])

  const columns: ColumnSpec[] = useMemo(() => {
    const fixed: ColumnSpec[] = [
      {
        key: 'designation',
        label: 'Number',
        byDefault: true,
        width: '110px',
        value: (row) => row.designation,
        render: (row) => <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{row.designation}</strong>,
      },
      { key: 'title', label: 'Title', byDefault: true, value: (row) => row.title },
      {
        key: 'status',
        label: 'Status',
        byDefault: true,
        width: '150px',
        value: (row) => types.get(row.typeKey)?.states.find((s) => s.key === row.status)?.label ?? row.status,
        render: (row) => {
          const state = types.get(row.typeKey)?.states.find((s) => s.key === row.status)
          return <Pill tone={statusTone(row.status, state?.terminal)}>{state?.label ?? row.status}</Pill>
        },
      },
      {
        key: 'ballInCourt',
        label: 'Ball in Court',
        byDefault: true,
        width: '170px',
        value: (row) => nameOf(row.ballInCourtUserId),
        render: (row) =>
          row.ballInCourtUserId ? (
            nameOf(row.ballInCourtUserId)
          ) : (
            // Not blank. Blank reads as "loading"; nobody holding a live
            // record is a real and actionable state.
            <span style={{ color: 'var(--ink-faint)' }}>nobody</span>
          ),
      },
      {
        key: 'age',
        label: 'Age',
        byDefault: true,
        width: '90px',
        value: (row) => String(days(row.createdAt)),
        render: (row) => (
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{days(row.createdAt)}d</span>
        ),
      },
      {
        key: 'due',
        label: 'Due',
        byDefault: true,
        width: '120px',
        value: (row) => shortDate(row.dueAt),
        render: (row) => {
          if (!row.dueAt) return <span style={{ color: 'var(--ink-faint)' }}>—</span>
          const overdue = Date.parse(row.dueAt) < Date.now() && row.closedAt === null
          return (
            <span style={{ color: overdue ? 'var(--danger)' : undefined, fontWeight: overdue ? 650 : undefined }}>
              {shortDate(row.dueAt)}
            </span>
          )
        },
      },
      { key: 'created', label: 'Created', byDefault: false, width: '120px', value: (row) => shortDate(row.createdAt) },
      { key: 'updated', label: 'Updated', byDefault: false, width: '120px', value: (row) => shortDate(row.updatedAt) },
    ]

    // Every field the type declares, as a column, with the short ones on by
    // default. A `multiline` field is a paragraph — an RFI question runs to
    // three sentences — and a paragraph in a table cell pushes every other
    // column off the screen, which is the opposite of what a dense list is
    // for. They stay available in the picker, because somebody scanning for
    // one phrase across eighty rows genuinely wants them.
    const short = (type?.fields ?? []).filter((f) => f.type !== 'multiline')
    const fromType: ColumnSpec[] = (type?.fields ?? []).map((field) => ({
      key: `body.${field.key}`,
      label: field.label,
      byDefault: field.type !== 'multiline' && short.indexOf(field) < 3,
      width: field.type === 'select' ? '150px' : undefined,
      value: (row) => {
        const raw = (row.body as Record<string, unknown>)[field.key]
        if (raw === null || raw === undefined) return ''
        return typeof raw === 'boolean' ? (raw ? 'Yes' : 'No') : String(raw)
      },
    }))

    return [...fixed, ...fromType]
  }, [type, types, nameOf])

  const shownKeys = useMemo(() => visibleKeys(columns, hidden), [columns, hidden])
  const visible = columns.filter((c) => shownKeys.has(c.key))

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    let out = records.filter((row) => {
      if (status && row.status !== status) return false
      if (holder === '__nobody__' && row.ballInCourtUserId !== null) return false
      if (holder && holder !== '__nobody__' && row.ballInCourtUserId !== holder) return false
      if (overdueOnly) {
        if (!row.dueAt || row.closedAt !== null || Date.parse(row.dueAt) >= Date.now()) return false
      }
      for (const [key, want] of Object.entries(fieldFilters)) {
        if (!want) continue
        if (String((row.body as Record<string, unknown>)[key] ?? '') !== want) return false
      }
      if (needle) {
        const hay = `${row.designation} ${row.title} ${Object.values(row.body as Record<string, unknown>).join(' ')}`
        if (!hay.toLowerCase().includes(needle)) return false
      }
      return true
    })

    const column = columns.find((c) => c.key === sort.key)
    if (column) {
      out = [...out].sort((a, b) => {
        const av = column.value(a)
        const bv = column.value(b)
        const cmp = av.localeCompare(bv, undefined, { numeric: true })
        return sort.desc ? -cmp : cmp
      })
    }
    return out
  }, [records, query, status, holder, overdueOnly, fieldFilters, sort, columns])

  const selectable = type?.fields.filter((f) => f.type === 'select' && (f.options ?? []).length > 0) ?? []

  function exportCsv(): void {
    const cols = visible
    const csv = toCsv(
      cols.map((c) => c.label),
      rows.map((row) => cols.map((c) => c.value(row))),
    )
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    // What was actually on screen, filters and all. An export that quietly
    // ignores the filter row hands somebody a file that disagrees with the
    // screen they exported it from.
    link.download = `${type?.displayNamePlural ?? 'records'}.csv`.toLowerCase().replace(/\s+/g, '-')
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ width: 240 }}>
          <Input value={query} onChange={setQuery} // Not lower-cased. "Search rfis" is a typo to anybody in this industry,
          // and the registry already holds the plural spelled properly.
          placeholder={`Search ${type?.displayNamePlural ?? 'records'}`} />
        </div>

        {/*
          Each control is boxed at a width. The form controls in this product
          are 100% wide by design, which is right inside a field and wrong in
          a filter row: unboxed they stretch and the row becomes a stack of
          full-width dropdowns taller than the table it filters.
        */}
        <div style={{ width: 170 }}>
          <Select
            value={status}
            onChange={setStatus}
            label="Status"
            placeholder="Any status"
            options={(type?.states ?? []).map((s) => ({ value: s.key, label: s.label }))}
          />
        </div>

        <div style={{ width: 190 }}>
        <Select
          value={holder}
          onChange={setHolder}
          label="Ball in court"
          placeholder="Anybody"
          options={[
            ...(currentUserId ? [{ value: currentUserId, label: 'In my court' }] : []),
            { value: '__nobody__', label: 'Nobody' },
            ...people
              .filter((p) => p.userId !== currentUserId)
              .map((p) => ({ value: p.userId, label: `${p.name} · ${p.organization}` })),
          ]}
        />
        </div>

        {selectable.map((field) => (
          <div key={field.key} style={{ width: 170 }}>
            <Select
              value={fieldFilters[field.key] ?? ''}
              onChange={(value) => setFieldFilters((prev) => ({ ...prev, [field.key]: value }))}
              label={field.label}
              placeholder={`Any ${field.label.toLowerCase()}`}
              options={(field.options ?? []).map((option) => ({ value: option, label: option }))}
            />
          </div>
        ))}

        <Button variant={overdueOnly ? 'secondary' : 'ghost'} onClick={() => setOverdueOnly((on) => !on)}>
          Overdue only
        </Button>
        <Button variant="ghost" onClick={() => setPicking((on) => !on)}>
          Columns
        </Button>
        <Button variant="ghost" onClick={exportCsv} disabled={rows.length === 0}>
          Export
        </Button>
      </div>

      {picking ? (
        <div
          style={{
            display: 'flex',
            gap: 12,
            flexWrap: 'wrap',
            padding: 12,
            borderRadius: 8,
            background: 'var(--surface-sunken)',
          }}
        >
          {columns.map((column) => {
            const on = shownKeys.has(column.key)
            return (
              <label key={column.key} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() =>
                    setHidden((prev) => {
                      const next = new Set(prev)
                      if (on) {
                        next.add(column.key)
                        next.delete(`+${column.key}`)
                      } else {
                        next.delete(column.key)
                        next.add(`+${column.key}`)
                      }
                      return next
                    })
                  }
                />
                {column.label}
              </label>
            )
          })}
        </div>
      ) : null}

      <div style={{ fontSize: 12, color: 'var(--ink-muted)' }}>
        {/*
          Said out loud, because a filtered table that looks like the whole
          table is how somebody reports "we only have four open RFIs".
        */}
        {rows.length === records.length
          ? `${records.length} ${records.length === 1 ? 'record' : 'records'}`
          : `${rows.length} of ${records.length} shown`}
      </div>

      <Table
        rows={rows}
        rowKey={(row) => row.id}
        onRowClick={(row) => onOpenRecord(row.id)}
        empty={empty}
        sort={sort}
        onSort={(key) => setSort((prev) => ({ key, desc: prev.key === key ? !prev.desc : false }))}
        columns={columns
          .filter((c) => shownKeys.has(c.key))
          .map((column) => ({
            key: column.key,
            header: column.label,
            ...(column.width ? { width: column.width } : {}),
            render: (row: ConstructionRecord) =>
              column.render ? column.render(row) : column.value(row) || <span style={{ color: 'var(--ink-faint)' }}>—</span>,
          }))}
      />

    </div>
  )
}

/**
 * Which columns are on, given the defaults and what the picker has changed.
 *
 * The set holds two kinds of marker: a bare key means "turned off", and a key
 * prefixed with + means "turned on". Keeping both, rather than storing the
 * visible set, means a column the product later adds to the defaults appears
 * for somebody who has used the picker, instead of being silently excluded by
 * a set captured before it existed.
 */
export function visibleKeys(columns: { key: string; byDefault: boolean }[], marks: Set<string>): Set<string> {
  const out = new Set<string>()
  for (const column of columns) {
    const forcedOn = marks.has(`+${column.key}`)
    const forcedOff = marks.has(column.key)
    if (forcedOn || (column.byDefault && !forcedOff)) out.add(column.key)
  }
  return out
}
