import type { FieldSpec } from '@plumbline/shared'
import { Field, Input, Select, Textarea } from '../ui/index.js'

/**
 * Fields, rendered from the type definition.
 *
 * This component is the whole reason a new tool needs no client release. It
 * has never heard of an RFI: it reads `fields` off the registry entry and
 * renders a control per declared type, so a record type added by a migration
 * gets a working form the moment the server serves it.
 *
 * Validation is deliberately NOT duplicated here. The server normalizes and
 * validates every body against the same definition, and a second copy of those
 * rules in the client is a second copy to drift. What the client does is
 * surface the server's per-field issues next to the right control.
 */

export type FieldValues = Record<string, string>

export function toFieldValues(body: Record<string, unknown>): FieldValues {
  const values: FieldValues = {}
  for (const [key, value] of Object.entries(body)) {
    values[key] = value === null || value === undefined ? '' : String(value)
  }
  return values
}

/** Only the keys the user actually filled in; empty strings mean "left blank". */
export function toRequestBody(values: FieldValues): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(values)) {
    if (value !== '') body[key] = value
  }
  return body
}

export function RecordFields({
  fields,
  values,
  onChange,
  issues = [],
  readOnly = false,
}: {
  fields: FieldSpec[]
  values: FieldValues
  onChange: (key: string, value: string) => void
  issues?: { field: string; message: string }[]
  readOnly?: boolean
}) {
  const issueFor = (key: string): string | undefined => issues.find((issue) => issue.field === key)?.message

  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      {fields.map((field) => {
        const value = values[field.key] ?? ''
        const error = issueFor(field.key)

        if (readOnly) {
          return (
            <div key={field.key} style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-muted)' }}>{field.label}</span>
              <span style={{ whiteSpace: 'pre-wrap' }}>
                {value === '' ? <em style={{ color: 'var(--ink-faint)' }}>Not given</em> : value}
              </span>
            </div>
          )
        }

        return (
          <Field
            key={field.key}
            label={field.label}
            {...(field.required ? { required: true } : {})}
            {...(error ? { error } : {})}
          >
            {field.type === 'multiline' ? (
              <Textarea value={value} onChange={(next) => onChange(field.key, next)} />
            ) : field.type === 'select' ? (
              <Select
                value={value}
                onChange={(next) => onChange(field.key, next)}
                options={(field.options ?? []).map((option) => ({ value: option, label: option }))}
              />
            ) : field.type === 'boolean' ? (
              <Select
                value={value}
                onChange={(next) => onChange(field.key, next)}
                options={[
                  { value: 'true', label: 'Yes' },
                  { value: 'false', label: 'No' },
                ]}
              />
            ) : (
              <Input
                name={field.key}
                value={value}
                onChange={(next) => onChange(field.key, next)}
                type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
              />
            )}
          </Field>
        )
      })}
    </div>
  )
}
