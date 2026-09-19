import { withTenant, type Db } from './db.js'
import { NotFoundError, PermissionDeniedError, ValidationError } from './errors.js'
import { RecordKernel, type Actor } from './kernel.js'
import { hasLevel, hasPrivilege } from './permissions.js'
import { loadAccess } from './repositories/permissions.js'

/**
 * Specifications, and the register hiding inside them.
 *
 * A spec book is two thousand pages nobody reads end to end, and buried in it
 * is a list every project engineer builds by hand in the first fortnight of a
 * job: every submittal the contract requires, by section. Missing one is not a
 * paperwork problem. It is a material that arrives unapproved, gets rejected,
 * and becomes a six week lead time nobody budgeted for.
 *
 * That list is the best agent job in construction: tedious, mechanical,
 * entirely determined by the document, and checkable line by line against the
 * clause it came from. Which is exactly why the citation rule here is not
 * advisory. A requirement whose quote cannot be found verbatim in the section
 * is discarded before it reaches the database, because an extracted
 * requirement nobody can trace to a clause is one nobody will defend in a
 * meeting, and a register a project engineer cannot check is a register they
 * will rebuild by hand anyway.
 */

export interface ExtractedRequirement {
  submittalType: string
  description: string
  /** Verbatim from the section. Checked, not trusted. */
  quote: string
  paragraph?: string
  confidence?: number
}

export interface RequirementExtractionRequest {
  sectionNumber: string
  sectionTitle: string
  body: string
}

/** The seam. One implementation per provider, nothing above here knows which. */
export interface RequirementExtractionProvider {
  readonly name: string
  extract(request: RequirementExtractionRequest): Promise<{ requirements: ExtractedRequirement[]; model: string }>
}

/** Scripted, for tests and for seeding without spend. */
export class ScriptedExtractionProvider implements RequirementExtractionProvider {
  readonly name = 'scripted'
  private readonly queue: ExtractedRequirement[][] = []
  push(requirements: ExtractedRequirement[]): void {
    this.queue.push(requirements)
  }
  async extract(): Promise<{ requirements: ExtractedRequirement[]; model: string }> {
    return { requirements: this.queue.shift() ?? [], model: 'scripted' }
  }
}

/**
 * The submittal types the register may produce.
 *
 * The same vocabulary the submittal record type already uses, so accepting a
 * requirement is a copy rather than a translation. An extractor free to invent
 * a type would produce a register that cannot become submittals, which is the
 * only thing the register is for.
 */
export const SUBMITTAL_TYPES: readonly string[] = [
  'Product Data',
  'Shop Drawing',
  'Sample',
  'Mock-up',
  'Certificate',
  'Test Report',
  'Other',
]

export interface RequirementRow {
  id: string
  sectionId: string
  sectionNumber: string
  submittalType: string
  description: string
  quote: string
  status: 'proposed' | 'accepted' | 'rejected' | 'satisfied'
  confidence: string | null
  submittalId: string | null
}

/**
 * Normalises whitespace before comparing, and nothing else.
 *
 * A model reflowing a line break inside a quote is not a hallucination and
 * refusing it would train people to ignore the check. Changing a word is, and
 * this still catches that.
 */
function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

export function quoteIsFound(quote: string, body: string): boolean {
  const needle = normalise(quote)
  return needle.length > 0 && normalise(body).includes(needle)
}

export class SpecificationService {
  constructor(
    private readonly db: Db,
    private readonly provider: RequirementExtractionProvider,
  ) {}

  async createBook(
    actor: Actor,
    input: { projectId: string; name: string; issuedOn?: string },
  ): Promise<{ id: string }> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      await this.assertPrivilege(tx, actor, input.projectId, 'upload')
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO specification_books (tenant_id, project_id, name, issued_on, created_by)
              VALUES ($1, $2, $3, $4::date, $5) RETURNING id`,
        [actor.tenantId, input.projectId, input.name, input.issuedOn ?? null, actor.userId],
      )
      return { id: rows[0]?.id as string }
    })
  }

  async addSection(
    actor: Actor,
    input: { bookId: string; number: string; title: string; body: string },
  ): Promise<{ id: string }> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const book = await this.loadBook(tx, actor.tenantId, input.bookId)
      await this.assertPrivilege(tx, actor, book.project_id, 'upload')
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO specification_sections (tenant_id, book_id, number, title, body)
              VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (book_id, number) DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body
           RETURNING id`,
        [actor.tenantId, input.bookId, input.number, input.title, input.body],
      )
      return { id: rows[0]?.id as string }
    })
  }

  /**
   * Reads a section and proposes the submittals it requires.
   *
   * Proposals, never records. Same gate as every other agent in this system:
   * an agent may propose anything and create nothing.
   */
  async extractRequirements(
    actor: Actor,
    sectionId: string,
  ): Promise<{ proposed: number; discarded: { reason: string; description: string }[] }> {
    const section = await withTenant(this.db, actor.tenantId, async (tx) => {
      const found = await this.loadSection(tx, actor.tenantId, sectionId)
      await this.assertPrivilege(tx, actor, found.project_id, 'upload')
      return found
    })

    const result = await this.provider.extract({
      sectionNumber: section.number,
      sectionTitle: section.title,
      body: section.body,
    })

    const discarded: { reason: string; description: string }[] = []
    let proposed = 0

    await withTenant(this.db, actor.tenantId, async (tx) => {
      for (const requirement of result.requirements) {
        // The citation rule, enforced before the row exists rather than
        // reported afterwards. A register a project engineer cannot check line
        // by line is one they will rebuild by hand anyway.
        if (!quoteIsFound(requirement.quote, section.body)) {
          discarded.push({ reason: 'quote not found in the section', description: requirement.description })
          continue
        }
        if (!SUBMITTAL_TYPES.includes(requirement.submittalType)) {
          discarded.push({
            reason: `unknown submittal type "${requirement.submittalType}"`,
            description: requirement.description,
          })
          continue
        }
        await tx.query(
          `INSERT INTO specification_requirements
             (tenant_id, section_id, submittal_type, description, quote, paragraph, confidence)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            actor.tenantId,
            sectionId,
            requirement.submittalType,
            requirement.description,
            requirement.quote,
            requirement.paragraph ?? null,
            requirement.confidence ?? null,
          ],
        )
        proposed += 1
      }
    })

    return { proposed, discarded }
  }

  async register(actor: Actor, projectId: string): Promise<RequirementRow[]> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const access = await loadAccess(tx, { userId: actor.userId, tenantId: actor.tenantId, projectId })
      if (!hasLevel(access, 'specifications', 'read_only')) {
        throw new PermissionDeniedError('You cannot see specifications on this project', {
          tool: 'specifications',
        })
      }
      const { rows } = await tx.query<Record<string, string | null>>(
        `SELECT r.id, r.section_id, s.number AS section_number, r.submittal_type, r.description,
                r.quote, r.status, r.confidence, r.submittal_id
           FROM specification_requirements r
           JOIN specification_sections s ON s.id = r.section_id
           JOIN specification_books b ON b.id = s.book_id
          WHERE r.tenant_id = $1 AND b.project_id = $2
          ORDER BY s.number, r.created_at`,
        [actor.tenantId, projectId],
      )
      return rows.map((r) => ({
        id: r['id'] as string,
        sectionId: r['section_id'] as string,
        sectionNumber: r['section_number'] as string,
        submittalType: r['submittal_type'] as string,
        description: r['description'] as string,
        quote: r['quote'] as string,
        status: r['status'] as RequirementRow['status'],
        confidence: r['confidence'] ?? null,
        submittalId: r['submittal_id'] ?? null,
      }))
    })
  }

  /**
   * Accepting a requirement raises the submittal that will satisfy it.
   *
   * This is the whole point of the register: the list stops being a list and
   * becomes the log the job is actually run from, with each entry traceable to
   * the clause that demanded it.
   */
  async accept(
    actor: Actor,
    requirementId: string,
    input: { specSection?: string; assigneeUserId?: string } = {},
  ): Promise<{ submittalId: string }> {
    const requirement = await withTenant(this.db, actor.tenantId, async (tx) => {
      const found = await this.loadRequirement(tx, actor.tenantId, requirementId)
      await this.assertPrivilege(tx, actor, found.project_id, 'review')
      if (found.status !== 'proposed') {
        throw new ValidationError('That requirement has already been decided', [
          { field: 'status', message: `The requirement is ${found.status}` },
        ])
      }
      return found
    })

    const kernel = new RecordKernel(this.db)
    const created = await kernel.create(actor, {
      projectId: requirement.project_id,
      typeKey: 'submittal',
      title: `${requirement.section_number} · ${requirement.description}`,
      body: {
        spec_section: input.specSection ?? requirement.section_number,
        submittal_type: requirement.submittal_type,
        description: requirement.description,
      },
      ...(input.assigneeUserId
        ? { participants: [{ userId: input.assigneeUserId, role: 'assignee' as const }] }
        : {}),
    })

    await withTenant(this.db, actor.tenantId, async (tx) => {
      await tx.query(
        `UPDATE specification_requirements
            SET status = 'accepted', submittal_id = $3, reviewed_by = $4, reviewed_at = now()
          WHERE tenant_id = $1 AND id = $2`,
        [actor.tenantId, requirementId, created.record.id, actor.userId],
      )
    })

    return { submittalId: created.record.id }
  }

  async reject(actor: Actor, requirementId: string): Promise<void> {
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const requirement = await this.loadRequirement(tx, actor.tenantId, requirementId)
      await this.assertPrivilege(tx, actor, requirement.project_id, 'review')
      await tx.query(
        `UPDATE specification_requirements
            SET status = 'rejected', reviewed_by = $3, reviewed_at = now()
          WHERE tenant_id = $1 AND id = $2`,
        [actor.tenantId, requirementId, actor.userId],
      )
    })
  }

  private async loadBook(tx: Db, tenantId: string, bookId: string): Promise<{ project_id: string }> {
    const { rows } = await tx.query<{ project_id: string }>(
      `SELECT project_id FROM specification_books WHERE tenant_id = $1 AND id = $2`,
      [tenantId, bookId],
    )
    const row = rows[0]
    if (!row) throw new NotFoundError('specification book', bookId)
    return row
  }

  private async loadSection(
    tx: Db,
    tenantId: string,
    sectionId: string,
  ): Promise<{ project_id: string; number: string; title: string; body: string }> {
    const { rows } = await tx.query<{ project_id: string; number: string; title: string; body: string }>(
      `SELECT b.project_id, s.number, s.title, s.body
         FROM specification_sections s JOIN specification_books b ON b.id = s.book_id
        WHERE s.tenant_id = $1 AND s.id = $2`,
      [tenantId, sectionId],
    )
    const row = rows[0]
    if (!row) throw new NotFoundError('specification section', sectionId)
    return row
  }

  private async loadRequirement(
    tx: Db,
    tenantId: string,
    requirementId: string,
  ): Promise<{
    project_id: string
    status: string
    section_number: string
    submittal_type: string
    description: string
  }> {
    const { rows } = await tx.query<{
      project_id: string
      status: string
      section_number: string
      submittal_type: string
      description: string
    }>(
      `SELECT b.project_id, r.status, s.number AS section_number, r.submittal_type, r.description
         FROM specification_requirements r
         JOIN specification_sections s ON s.id = r.section_id
         JOIN specification_books b ON b.id = s.book_id
        WHERE r.tenant_id = $1 AND r.id = $2`,
      [tenantId, requirementId],
    )
    const row = rows[0]
    if (!row) throw new NotFoundError('specification requirement', requirementId)
    return row
  }

  private async assertPrivilege(tx: Db, actor: Actor, projectId: string, privilege: string): Promise<void> {
    const access = await loadAccess(tx, { userId: actor.userId, tenantId: actor.tenantId, projectId })
    if (!hasPrivilege(access, 'specifications', privilege) && !access.isCompanyAdmin) {
      throw new PermissionDeniedError(`You cannot ${privilege} specifications on this project`, {
        tool: 'specifications',
      })
    }
  }
}
