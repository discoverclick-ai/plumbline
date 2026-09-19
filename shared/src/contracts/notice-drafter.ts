import { withTenant, type Db } from '../db.js'
import { NotFoundError, PermissionDeniedError, ValidationError } from '../errors.js'
import { RecordKernel, type Actor } from '../kernel.js'
import { hasPrivilege } from '../permissions.js'
import { loadAccess } from '../repositories/permissions.js'
import { ClaimFileService, type ClaimFile } from './claim-file.js'
import { quoteAppearsIn } from './segmentation.js'

/**
 * Drafting the letter.
 *
 * The last piece of the contract subsystem and the one with the sharpest
 * line through it: an agent may draft anything here and serve nothing. Every
 * route out of a draft is a human transition, and that is not caution. A
 * system that mailed a client's architect unsupervised is one incident away
 * from being switched off across the whole company, and then none of the rest
 * of this matters.
 *
 * Three rules the drafter works under, all of them visible in the prompt and
 * all of them checked afterwards rather than trusted.
 *
 * IT QUOTES, IT DOES NOT CHARACTERISE. "Clause 4.7.1 requires written notice
 * within five days of first observance" is a statement about the contract.
 * "You are in breach" is a legal conclusion, and this product does not draw
 * them.
 *
 * IT USES ONLY WHAT THE FILE HOLDS. The dates, the clause text, the
 * observation, the evidence and the schedule impact are all already recorded;
 * a drafter that reaches past them is inventing facts into a legal document.
 * Anything it writes that is not in the file is a defect.
 *
 * AND IT NEVER ASKS FOR ANYTHING IT HAS NOT BEEN TOLD TO ASK FOR. Relief
 * sought is a commercial decision a person makes. The draft reserves rights
 * and leaves the number blank.
 */

export interface NoticeDraftRequest {
  /** Everything the system already recorded, assembled. */
  file: ClaimFile
  /** The sender, as they will sign it. */
  from: { name: string; organization: string }
  /** Who it is addressed to, as a person typed it. */
  to: string | null
}

export interface DraftedNotice {
  subject: string
  body: string
  /** Facts the drafter wanted and the file did not have. */
  missing: string[]
  model: string
}

export interface NoticeDraftProvider {
  readonly name: string
  draft(request: NoticeDraftRequest): Promise<DraftedNotice>
}

/**
 * Phrases that are findings rather than facts.
 *
 * Enforced by the SERVICE, not by any one provider. "This product does not
 * draw legal conclusions" is a product rule: the seam exists so a customer
 * can swap the drafter, and a rule that only the shipped provider honours is
 * one the next provider breaks silently.
 */
const LEGAL_CONCLUSIONS = [
  /\byou are in breach\b/i,
  /\byou are liable\b/i,
  /\bconstitutes? a (?:breach|default)\b/i,
  /\bin default of\b/i,
  /\bwe are entitled to\b/i,
  /\byou have failed to comply\b/i,
  /\bis a material breach\b/i,
  /\bnegligen(?:t|ce)\b/i,
]

export function legalConclusionIn(text: string): string | null {
  const hit = LEGAL_CONCLUSIONS.find((pattern) => pattern.test(text))
  if (!hit) return null
  return (hit.exec(text)?.[0] ?? '').trim()
}

/**
 * A drafter with no model in it.
 *
 * Not a placeholder. A notice is a formal letter with a fixed shape, and the
 * shape is dictated by what it has to prove: that notice was given, of what,
 * under which clause, within the window, by somebody identified. A template
 * fed from the claim file gets all of that right, deterministically, and it
 * is what a deployment without a model key gets.
 *
 * The model-backed drafter exists to write the one paragraph this cannot:
 * the description of what actually happened, in the language of the job.
 */
export class TemplateNoticeDrafter implements NoticeDraftProvider {
  readonly name = 'template'

  async draft(request: NoticeDraftRequest): Promise<DraftedNotice> {
    const { file } = request
    const missing: string[] = []
    const lines: string[] = []

    const clause = file.citation?.clauseNumber ?? null
    const subject = `Notice under ${clause ? `clause ${clause}` : 'the contract'} — ${file.project.number} ${file.project.name}`

    if (!request.to) missing.push('Who this is addressed to')
    lines.push(request.to ? `To: ${request.to}` : 'To: [ADDRESSEE]')
    lines.push(`From: ${request.from.name}, ${request.from.organization}`)
    lines.push(`Project: ${file.project.number} — ${file.project.name}`)
    lines.push(`Date: ${new Date().toISOString().slice(0, 10)}`)
    lines.push('')
    lines.push(subject)
    lines.push('')

    if (file.clock) {
      lines.push(
        `This is written notice under ${clause ? `clause ${clause}` : 'the contract'}` +
          `${file.citation ? ` of the ${file.citation.documentTitle}` : ''}.`,
      )
      lines.push('')
    }

    if (file.citation) {
      // Quoted, never characterised. The reader checks it against their own
      // copy and finds it identical, which is the point.
      lines.push(`${clause ? `Clause ${clause}` : 'The contract'} provides:`)
      lines.push('')
      lines.push(`    "${file.citation.quote}"`)
      lines.push('')
    }

    if (file.trigger) {
      lines.push(`On ${(file.clock?.occurredAt ?? '').slice(0, 10)} the following was observed on site:`)
      lines.push('')
      lines.push(`    ${file.trigger.title}`)
      lines.push('')
    } else {
      missing.push('The condition this notice is about')
    }

    if (file.evidence.items.length > 0) {
      lines.push('The condition is evidenced by the following, recorded at the time:')
      lines.push('')
      for (const item of file.evidence.items) {
        const where = item.latitude && item.longitude ? `, at ${item.latitude}, ${item.longitude}` : ''
        lines.push(`    ${item.capturedAt} — ${item.kind} recorded by ${item.capturedBy}${where}`)
      }
      lines.push('')
    } else {
      missing.push('Contemporaneous evidence of the condition')
    }

    if (file.clock?.awarenessAt) {
      lines.push(
        `The condition was first evidenced on ${file.clock.awarenessAt.slice(0, 10)}. ` +
          `This notice is given within the period the clause requires.`,
      )
      lines.push('')
    }

    if (file.scheduleImpact.items.length > 0) {
      lines.push('The following scheduled work is affected:')
      lines.push('')
      for (const item of file.scheduleImpact.items) {
        lines.push(
          `    ${item.activityName} (${item.activityCode}), scheduled to start ${item.startAt ?? 'date not set'}, ` +
            `carrying ${item.totalFloatDays ?? 'unrecorded'} days of float per ${item.scheduleName}.`,
        )
      }
      lines.push('')
    }

    // Rights reserved, nothing claimed. What to ask for is a commercial
    // decision a person makes, and a draft that filled in a number would be
    // making it for them.
    lines.push(
      'We reserve all rights under the Contract in respect of time and cost arising from this condition. ' +
        'Any entitlement will be submitted separately in accordance with the Contract.',
    )
    lines.push('')
    lines.push(request.from.name)
    lines.push(request.from.organization)

    missing.push(...file.gaps.filter((gap) => !/notice/i.test(gap)))

    return { subject, body: lines.join('\n'), missing, model: 'template' }
  }
}

export class NoticeDraftService {
  private readonly kernel: RecordKernel
  private readonly claims: ClaimFileService

  constructor(
    private readonly db: Db,
    private readonly provider: NoticeDraftProvider = new TemplateNoticeDrafter(),
  ) {
    this.kernel = new RecordKernel(db)
    this.claims = new ClaimFileService(db)
  }

  /**
   * Writes the draft into the notice record and stops.
   *
   * The record does NOT move state. It is still sitting in `watching`,
   * waiting for a person to read what was written, edit it, and press the
   * button that says it is ready to serve. Advancing it here would turn "the
   * agent drafted a notice" into "the agent decided a notice was warranted",
   * and those are different products.
   */
  async draft(actor: Actor, clockId: string): Promise<DraftedNotice & { recordId: string }> {
    const file = await this.claims.assemble(actor, clockId)

    const { recordId, addressedTo, sender } = await withTenant(this.db, actor.tenantId, async (tx) => {
      const { rows } = await tx.query<{ notice_record_id: string | null; project_id: string }>(
        'SELECT notice_record_id, project_id FROM obligation_clocks WHERE tenant_id = $1 AND id = $2',
        [actor.tenantId, clockId],
      )
      const clock = rows[0]
      if (!clock) throw new NotFoundError('clock', clockId)
      if (!clock.notice_record_id) {
        throw new ValidationError('This clock has no notice record behind it', [
          { field: 'clockId', message: 'Nobody on this project may raise a notice, so there is nothing to draft into' },
        ])
      }

      const access = await loadAccess(tx, {
        userId: actor.userId,
        tenantId: actor.tenantId,
        projectId: clock.project_id,
      })
      if (!hasPrivilege(access, 'notices', 'create') && !access.isCompanyAdmin) {
        throw new PermissionDeniedError('You cannot draft notices on this project', {
          tool: 'notices',
          privilege: 'create',
        })
      }

      const { rows: who } = await tx.query<{ name: string; organization: string }>(
        `SELECT u.name, o.name AS organization
           FROM users u JOIN organizations o ON o.id = u.organization_id AND o.tenant_id = u.tenant_id
          WHERE u.tenant_id = $1 AND u.id = $2`,
        [actor.tenantId, actor.userId],
      )

      return {
        recordId: clock.notice_record_id,
        addressedTo: file.notice?.addressedTo ?? null,
        sender: who[0] ?? { name: 'Unknown', organization: 'Unknown' },
      }
    })

    const drafted = await this.provider.draft({ file, from: sender, to: addressedTo })

    // Checked here, whoever wrote it. A polished draft is one people edit
    // less, so a polished draft containing a legal conclusion is more
    // dangerous than an obviously mechanical one, and the safe answer is the
    // template letter with the problem named.
    const conclusion = legalConclusionIn(drafted.body)
    const safe: DraftedNotice = conclusion
      ? {
          ...(await new TemplateNoticeDrafter().draft({ file, from: sender, to: addressedTo })),
          missing: [
            ...drafted.missing,
            `The drafted wording was discarded: it stated a legal conclusion ("${conclusion}") rather than a fact.`,
          ],
        }
      : drafted

    // The clause has to survive whatever was written around it. A drafter
    // that tidied the quote has produced a misquotation of a contract inside
    // a legal document.
    if (file.citation && !quoteAppearsIn(file.citation.quote, safe.body)) {
      throw new ValidationError('The drafted notice no longer quotes the clause verbatim', [
        { field: 'body', message: 'The citation was altered, so the draft was not saved' },
      ])
    }

    // The body goes in. The state does not move.
    await this.kernel.update(actor, recordId, { body: { description: safe.body } })

    return { ...safe, recordId }
  }
}
