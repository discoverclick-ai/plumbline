import type { Db } from '../db.js'
import { KernelError } from '../errors.js'
import { EscalationService } from '../escalation.js'
import { RecordKernel, type Actor } from '../kernel.js'
import { loadRecordTypes } from '../repositories/record-types.js'

/**
 * The kernel, as tools a customer's own agent can call.
 *
 * Procore's marketplace is a farm team for acquisitions. This should be a
 * distribution channel from the start, and the difference is that an MCP
 * server means somebody else's agent can work the job without asking anybody
 * for an integration.
 *
 * Two properties make this safe enough to expose, and both come from
 * decisions made much earlier rather than from anything here.
 *
 * Every call runs AS a user, through the same access snapshot the web client
 * gets. There is no service account and no elevated mode: an agent given a
 * trade partner's session sees a trade partner's job, because row-level
 * security and the permission model do not know the difference between an
 * agent and a browser.
 *
 * And the write surface is the workflow. An agent cannot set a status, edit a
 * closed record or move the ball by hand, because those are not operations the
 * kernel offers anybody. It can only do what the state machine already allows
 * the person it acts for to do.
 */

export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /** Whether a call changes anything, which is what a client shows before approving. */
  mutating: boolean
}

export const TOOLS: McpTool[] = [
  {
    name: 'list_record_types',
    description:
      'List the kinds of record this project uses, with their fields and workflow. Call this first: the set is per deployment and includes types this server may have added since the agent was written.',
    mutating: false,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'search_records',
    description:
      'Find records by words in their title, designation or body. Searches only projects the acting user is on, and only record types they may read.',
    mutating: false,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Words as a person would type them, e.g. "anchor bolt embedment".' },
        projectId: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
    },
  },
  {
    name: 'get_record',
    description:
      'Read one record in full: its body, its participants, who holds the ball, and the transitions the acting user may run on it right now.',
    mutating: false,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['recordId'],
      properties: { recordId: { type: 'string' } },
    },
  },
  {
    name: 'ball_in_court',
    description:
      'What is owed, and by whom. Omit holderUserId for everything open on the project; pass it for one person’s queue.',
    mutating: false,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        projectId: { type: 'string' },
        holderUserId: { type: 'string' },
        overdueOnly: { type: 'boolean' },
      },
    },
  },
  {
    name: 'overdue_work',
    description:
      'Everything past its due date on a project, with how late it is and what it is waiting on. Use this rather than filtering ball_in_court by hand.',
    mutating: false,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['projectId'],
      properties: { projectId: { type: 'string' } },
    },
  },
  {
    name: 'create_record',
    description:
      'Raise a record. The type decides which fields are required; call list_record_types first rather than guessing. Creates it in its initial state, which for most types is a draft the acting user still has to submit. Pass assigneeUserId: most workflows refuse to leave the initial state with nobody to hand the ball to, so a record raised without one is a draft that cannot move.',
    mutating: true,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['projectId', 'typeKey', 'title'],
      properties: {
        projectId: { type: 'string' },
        typeKey: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'object', additionalProperties: true },
        assigneeUserId: { type: 'string' },
      },
    },
  },
  {
    name: 'transition_record',
    description:
      'Move a record along its workflow. Only transitions listed by get_record will succeed; there is no way to set a status directly, for anybody.',
    mutating: true,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['recordId', 'transitionKey'],
      properties: {
        recordId: { type: 'string' },
        transitionKey: { type: 'string' },
        body: { type: 'object', additionalProperties: true },
        note: { type: 'string' },
      },
    },
  },
  {
    name: 'comment_on_record',
    description: 'Add a comment. Comments are attributed to the acting user and cannot be edited or removed.',
    mutating: true,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['recordId', 'body'],
      properties: { recordId: { type: 'string' }, body: { type: 'string' } },
    },
  },
]

export interface ToolCall {
  name: string
  arguments: Record<string, unknown>
}

/**
 * Runs one tool call for one user.
 *
 * Deliberately not an HTTP server or a transport. This is the vocabulary and
 * the dispatch; wiring it to stdio, SSE or a socket is the host's problem and
 * keeps the testable part testable.
 */
export class McpToolRunner {
  private readonly kernel: RecordKernel
  private readonly escalations: EscalationService

  constructor(private readonly db: Db) {
    this.kernel = new RecordKernel(db)
    this.escalations = new EscalationService(db)
  }

  async call(actor: Actor, call: ToolCall): Promise<unknown> {
    const args = call.arguments ?? {}
    const str = (key: string): string => {
      const value = args[key]
      if (typeof value !== 'string' || value === '') {
        throw new KernelError('bad_request', `${call.name} needs ${key}`, 400)
      }
      return value
    }
    const optional = (key: string): string | undefined =>
      typeof args[key] === 'string' && args[key] !== '' ? (args[key] as string) : undefined

    switch (call.name) {
      case 'list_record_types': {
        const types = await loadRecordTypes(this.db)
        return [...types.values()].map((type) => ({
          key: type.key,
          displayName: type.displayName,
          creatableByOrgKinds: type.creatableByOrgKinds,
          fields: type.definition.fields.map((f) => ({
            key: f.key,
            label: f.label,
            type: f.type,
            required: f.required ?? false,
            options: f.options ?? null,
          })),
          states: type.definition.workflow.states.map((s) => s.key),
          transitions: type.definition.workflow.transitions.map((t) => ({
            key: t.key,
            label: t.label,
            from: t.from,
            to: t.to,
            requiresFields: t.requiresFields ?? [],
          })),
        }))
      }

      case 'search_records':
        return this.kernel.search(actor, {
          query: str('query'),
          ...(optional('projectId') ? { projectId: optional('projectId') as string } : {}),
          ...(typeof args['limit'] === 'number' ? { limit: args['limit'] } : {}),
        })

      case 'get_record':
        return this.kernel.get(actor, str('recordId'))

      case 'ball_in_court':
        return this.kernel.ballInCourt(actor, {
          ...(optional('projectId') ? { projectId: optional('projectId') as string } : {}),
          ...(optional('holderUserId') ? { holderUserId: optional('holderUserId') as string } : {}),
          ...(args['overdueOnly'] === true ? { overdueOnly: true } : {}),
        })

      case 'overdue_work':
        return this.escalations.overdue(actor, str('projectId'))

      case 'create_record':
        return this.kernel.create(actor, {
          projectId: str('projectId'),
          typeKey: str('typeKey'),
          title: str('title'),
          ...(args['body'] ? { body: args['body'] as Record<string, unknown> } : {}),
          ...(optional('assigneeUserId')
            ? { participants: [{ userId: optional('assigneeUserId') as string, role: 'assignee' as const }] }
            : {}),
        })

      case 'transition_record':
        return this.kernel.transition(actor, str('recordId'), {
          transitionKey: str('transitionKey'),
          ...(args['body'] ? { body: args['body'] as Record<string, unknown> } : {}),
          ...(optional('note') ? { note: optional('note') as string } : {}),
        })

      case 'comment_on_record':
        return this.kernel.comment(actor, str('recordId'), str('body'))

      default:
        // Named rather than swallowed. An agent calling a tool that does not
        // exist is usually an agent written against a different version, and
        // a silent empty result would have it carry on regardless.
        throw new KernelError('unknown_tool', `No tool named "${call.name}"`, 400)
    }
  }
}
