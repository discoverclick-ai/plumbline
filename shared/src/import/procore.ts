import { withTenant, type Db } from '../db.js'
import { ValidationError } from '../errors.js'
import { RecordKernel, type Actor } from '../kernel.js'
import { addProjectMember, createOrganization, createUser, findTemplateByName } from '../provisioning.js'

/**
 * Getting a project out of Procore.
 *
 * Strategically this matters more than the outbound connector: a connector
 * buys coexistence, an importer is what lets anybody leave. Procore's moat is
 * not features, it is that ten years of closeout documents live there and
 * nobody can face moving them. A competitor that cannot import is selling a
 * second system, and nobody wants a second system.
 *
 * Built against their EXPORT rather than their API, deliberately. An import
 * that needs the incumbent's API key is one the incumbent can withdraw, and a
 * customer mid-migration is precisely who they would withdraw it from. A CSV
 * export is a contractual right in most jurisdictions and a practical one
 * everywhere.
 *
 * Nothing here touches the network. The importer takes rows; where they came
 * from is the caller's problem.
 */

export interface ImportRow {
  [column: string]: string | undefined
}

export interface ImportResult {
  created: number
  skipped: { row: number; reason: string }[]
  /** Companies and people invented along the way, for a human to review. */
  createdOrganizations: string[]
  createdUsers: string[]
}

/**
 * Their column names, and the several spellings each has depending which
 * export produced it. This mapping is the actual work; the rest is a loop.
 */
const COLUMN_ALIASES: Record<string, string[]> = {
  number: ['Number', '#', 'RFI #', 'RFI Number', 'Submittal #', 'Item #'],
  subject: ['Subject', 'Title', 'Question Subject'],
  question: ['Question', 'Question Body', 'Description', 'Body'],
  answer: ['Official Response', 'Answer', 'Response'],
  status: ['Status'],
  discipline: ['Discipline', 'Trade', 'Category'],
  specSection: ['Spec Section', 'Specification Section', 'Section'],
  assignee: ['Assignee', 'Assignees', 'Ball In Court', 'Responsible Contractor'],
  assigneeEmail: ['Assignee Email', 'Ball In Court Email'],
  company: ['Company', 'Responsible Company', 'Vendor'],
  dueDate: ['Due Date', 'Date Due', 'Required Date'],
  drawingNumber: ['Drawing Number', 'Drawing', 'Sheet'],
}

export function readColumn(row: ImportRow, field: string): string | null {
  for (const alias of COLUMN_ALIASES[field] ?? []) {
    const value = row[alias]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return null
}

/**
 * Their statuses, mapped to ours.
 *
 * The unmapped ones are the interesting part. A Procore RFI can carry a status
 * somebody's company invented, and guessing would quietly reopen closed work
 * or close open work. Anything unrecognised lands OPEN and is reported: fifty
 * rows a human reviews is cheap, a hundred RFIs silently closed on a live job
 * is not.
 */
const RFI_STATUS: Record<string, string> = {
  draft: 'draft',
  open: 'open',
  'in review': 'open',
  submitted: 'open',
  answered: 'answered',
  closed: 'closed',
  void: 'void',
  cancelled: 'void',
}

export function mapRfiStatus(procoreStatus: string | null): { status: string; guessed: boolean } {
  const mapped = procoreStatus ? RFI_STATUS[procoreStatus.trim().toLowerCase()] : undefined
  return mapped ? { status: mapped, guessed: false } : { status: 'open', guessed: true }
}

/**
 * Splits a name that arrives as one field.
 *
 * Procore exports "Bishop, Ali" and "Ali Bishop" depending on the report, and
 * getting it wrong produces a directory full of people called "Bishop".
 */
export function splitName(value: string): { name: string; email: string | null } {
  const emailMatch = /<([^>]+)>|\(([^)]+@[^)]+)\)/.exec(value)
  const email = emailMatch?.[1] ?? emailMatch?.[2] ?? null
  const bare = value.replace(/<[^>]*>|\([^)]*\)/g, '').trim()
  const name = bare.includes(',')
    ? bare
        .split(',')
        .map((part) => part.trim())
        .reverse()
        .join(' ')
    : bare
  return { name, email }
}

/**
 * A CSV parser that handles the three things a construction export always has:
 * quoted fields, embedded commas, and embedded newlines inside a quoted RFI
 * question. Splitting on commas loses roughly a third of a real export and
 * produces rows that look perfectly plausible.
 */
export function parseCsv(text: string): ImportRow[] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] as string
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else quoted = false
      } else field += char
      continue
    }
    if (char === '"') quoted = true
    else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (char !== '\r') field += char
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  const header = rows.shift()
  if (!header) throw new ValidationError('That file is empty', [{ field: 'file', message: 'No header row' }])

  return rows
    .filter((cells) => cells.some((cell) => cell.trim() !== ''))
    .map((cells) => {
      const record: ImportRow = {}
      header.forEach((column, index) => {
        record[column.trim()] = cells[index]
      })
      return record
    })
}

export class ProcoreImporter {
  constructor(private readonly db: Db) {}

  /**
   * Imports RFIs into an existing project.
   *
   * Everything arrives through the ordinary kernel, so it is validated,
   * numbered, permissioned and audited exactly like a record somebody typed.
   * An importer that writes rows directly produces a project full of records
   * the product's own rules would have refused.
   */
  async importRfis(actor: Actor, input: { projectId: string; rows: ImportRow[] }): Promise<ImportResult> {
    const result: ImportResult = { created: 0, skipped: [], createdOrganizations: [], createdUsers: [] }
    const kernel = new RecordKernel(this.db)
    const people = new Map<string, string>()

    for (const [index, row] of input.rows.entries()) {
      const subject = readColumn(row, 'subject')
      const question = readColumn(row, 'question')
      if (!subject && !question) {
        result.skipped.push({ row: index + 1, reason: 'no subject or question on the row' })
        continue
      }

      const rawStatus = readColumn(row, 'status')
      const { status, guessed } = mapRfiStatus(rawStatus)
      if (guessed && rawStatus) {
        result.skipped.push({
          row: index + 1,
          reason: `status "${rawStatus}" is not one of ours, imported as open`,
        })
      }

      const assigneeId = await this.resolvePerson(
        actor,
        input.projectId,
        index + 1,
        readColumn(row, 'assignee'),
        readColumn(row, 'assigneeEmail'),
        readColumn(row, 'company'),
        people,
        result,
      )

      try {
        const created = await kernel.create(actor, {
          projectId: input.projectId,
          typeKey: 'rfi',
          title: subject ?? (question as string).slice(0, 120),
          body: {
            question: question ?? subject ?? '',
            ...(readColumn(row, 'discipline') ? { discipline: readColumn(row, 'discipline') } : {}),
            ...(readColumn(row, 'drawingNumber') ? { drawing_number: readColumn(row, 'drawingNumber') } : {}),
          },
          ...(assigneeId ? { participants: [{ userId: assigneeId, role: 'assignee' as const }] } : {}),
        })
        await this.walkTo(kernel, actor, created.record.id, status, row)
        result.created += 1
      } catch (err) {
        result.skipped.push({ row: index + 1, reason: (err as Error).message })
      }
    }

    return result
  }

  /**
   * Moves an imported record to the state it was in, one legal transition at a
   * time, and stops the moment it cannot.
   *
   * Stopping short is the right failure: the record exists, it is open, and a
   * person can finish it. Writing `status = 'closed'` directly would produce
   * records in a state their own workflow says is unreachable, which nothing
   * can ever move again.
   */
  private async walkTo(
    kernel: RecordKernel,
    actor: Actor,
    recordId: string,
    target: string,
    row: ImportRow,
  ): Promise<void> {
    const path: Record<string, string[]> = {
      draft: [],
      open: ['submit'],
      answered: ['submit', 'answer'],
      closed: ['submit', 'answer', 'close'],
      void: ['void'],
    }
    for (const transition of path[target] ?? []) {
      try {
        await kernel.transition(actor, recordId, {
          transitionKey: transition,
          ...(transition === 'answer'
            ? {
                body: {
                  answer: readColumn(row, 'answer') ?? 'Imported from Procore without a recorded response.',
                },
              }
            : {}),
        })
      } catch {
        return
      }
    }
  }

  /**
   * Finds or invents the person a row names.
   *
   * Inventing people is unavoidable, because a ten year old RFI names somebody
   * who left in 2019, and it is also how an import quietly fills a directory
   * with duplicates. So matching is by email where one exists, every invention
   * is reported, and a row carrying only a name never creates an account.
   */
  private async resolvePerson(
    actor: Actor,
    projectId: string,
    rowNumber: number,
    rawName: string | null,
    rawEmail: string | null,
    company: string | null,
    cache: Map<string, string>,
    result: ImportResult,
  ): Promise<string | null> {
    if (!rawName && !rawEmail) return null
    const parsed = rawName ? splitName(rawName) : { name: '', email: null }
    const email = rawEmail ?? parsed.email
    const name = parsed.name || email || 'Imported user'
    const key = (email ?? name).toLowerCase()
    if (cache.has(key)) return cache.get(key) as string

    return withTenant(this.db, actor.tenantId, async (tx) => {
      const { rows: existing } = await tx.query<{ id: string }>(
        email
          ? `SELECT id FROM users WHERE tenant_id = $1 AND lower(email) = lower($2)`
          : `SELECT id FROM users WHERE tenant_id = $1 AND lower(name) = lower($2)`,
        [actor.tenantId, email ?? name],
      )
      if (existing[0]) {
        cache.set(key, existing[0].id)
        await addProjectMember(tx, actor.tenantId, { projectId, userId: existing[0].id }).catch(() => undefined)
        return existing[0].id
      }

      if (!email) {
        // A name with no email cannot be matched reliably, and inventing an
        // account creates the duplicate this is trying to avoid.
        result.skipped.push({ row: rowNumber, reason: `"${name}" has no email in the export and was not created` })
        return null
      }

      const { rows: orgRows } = await tx.query<{ id: string }>(
        `SELECT id FROM organizations WHERE tenant_id = $1 AND lower(name) = lower($2)`,
        [actor.tenantId, company ?? 'Imported'],
      )
      let organizationId = orgRows[0]?.id
      if (!organizationId) {
        organizationId = await createOrganization(tx, actor.tenantId, { name: company ?? 'Imported', kind: 'other' })
        result.createdOrganizations.push(company ?? 'Imported')
      }

      const userId = await createUser(tx, actor.tenantId, {
        organizationId,
        email,
        name,
        companyPermissionTemplateId: await findTemplateByName(tx, actor.tenantId, 'company', 'Collaborator'),
      })
      // Least privilege for an imported account. Somebody who left in 2019
      // should not come back with standing access to a live job.
      await addProjectMember(tx, actor.tenantId, { projectId, userId, permissionTemplateName: 'Read Only' })
      result.createdUsers.push(email)
      cache.set(key, userId)
      return userId
    })
  }
}
