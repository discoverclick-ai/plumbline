import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { createPool, withTenant } from '../../src/db.js'
import { RecordKernel, type Actor } from '../../src/kernel.js'
import { McpToolRunner, TOOLS } from '../../src/mcp/tools.js'
import {
  addProjectMember,
  createOrganization,
  createProject,
  createUser,
  findTemplateByName,
  provisionTenant,
} from '../../src/provisioning.js'
import { clearRecordTypeCache } from '../../src/repositories/record-types.js'

/**
 * Somebody else's agent, holding somebody's credentials.
 *
 * The header of tools.ts makes two claims, and a claim in a comment is worth
 * nothing. The first is that a call runs as a user: an agent given a trade
 * partner's session gets a trade partner's job and not a byte more. The
 * second is that the write surface is the workflow, so there is no argument
 * an agent can pass that sets a status, moves the ball or edits a closed
 * record, because the kernel offers that to nobody.
 *
 * Both are tested here against a tenant with two projects, because the leak
 * that matters is not cross-tenant (row-level security has that) but the one
 * inside a single tenant, where the sub on the parking deck asks about the
 * hospital.
 */

let pool: Pool
let kernel: RecordKernel
let runner: McpToolRunner
let tenantId: string
let deck: string
let hospital: string

let gcPm: Actor
let sub: Actor

let deckRfi: string
let hospitalRfi: string

beforeAll(async () => {
  pool = createPool({ connectionString: inject('databaseUrl') })
  kernel = new RecordKernel(pool)
  runner = new McpToolRunner(pool)

  const tenant = await provisionTenant(pool, {
    tenantName: 'Ridgeline Construction',
    organizationKind: 'general_contractor',
    admin: { email: 'admin@ridgeline.test', name: 'Robin Admin', password: 'correct horse battery staple' },
  })
  tenantId = tenant.tenantId

  await withTenant(pool, tenantId, async (tx) => {
    const subOrg = await createOrganization(tx, tenantId, {
      name: 'Vega Steel',
      kind: 'specialty_contractor',
      trade: 'Structural Steel',
    })

    const pmId = await createUser(tx, tenantId, {
      organizationId: tenant.organizationId,
      email: 'pm@ridgeline.test',
      name: 'Gale Price',
      companyPermissionTemplateId: await findTemplateByName(tx, tenantId, 'company', 'Employee'),
    })
    const subId = await createUser(tx, tenantId, {
      organizationId: subOrg,
      email: 'pm@vega.test',
      name: 'Sasha Vega',
      companyPermissionTemplateId: await findTemplateByName(tx, tenantId, 'company', 'Collaborator'),
    })

    deck = await createProject(tx, tenantId, { number: '26-011', name: 'North Parking Deck' })
    hospital = await createProject(tx, tenantId, { number: '26-012', name: 'Mercy Hospital Tower' })

    // The sub is on ONE of them. That is the whole test.
    await addProjectMember(tx, tenantId, { projectId: deck, userId: pmId, permissionTemplateName: 'Project Manager' })
    await addProjectMember(tx, tenantId, {
      projectId: hospital,
      userId: pmId,
      permissionTemplateName: 'Project Manager',
    })
    await addProjectMember(tx, tenantId, { projectId: deck, userId: subId, permissionTemplateName: 'Project Manager' })

    gcPm = { tenantId, userId: pmId }
    sub = { tenantId, userId: subId }
  })

  const onDeck = await kernel.create(gcPm, {
    projectId: deck,
    typeKey: 'rfi',
    title: 'Anchor bolt embedment at grid C4',
    body: { question: 'The detail shows nine inch embedment. Shop drawings say seven.' },
    participants: [{ userId: sub.userId, role: 'assignee' }],
  })
  deckRfi = onDeck.record.id

  const atHospital = await kernel.create(gcPm, {
    projectId: hospital,
    typeKey: 'rfi',
    title: 'Anchor bolt embedment at the imaging suite',
    body: { question: 'Same question, different job, and the sub must never see it.' },
  })
  hospitalRfi = atHospital.record.id
})

afterAll(async () => {
  await pool.end()
  clearRecordTypeCache()
})

describe('the tool surface itself', () => {
  it('offers nothing that sets a state by hand', () => {
    // Not a style check. If a tool ever appears that takes a status, the
    // workflow stops being the only way through and every downstream promise
    // about who may do what goes with it.
    for (const tool of TOOLS) {
      const schema = tool.inputSchema as { properties?: Record<string, unknown> }
      const properties = Object.keys(schema.properties ?? {})
      expect(properties).not.toContain('status')
      expect(properties).not.toContain('state')
      expect(properties).not.toContain('ballInCourt')
      // holderUserId appears on ball_in_court, but only as a filter on a read.
      if (tool.mutating) expect(properties).not.toContain('holderUserId')
    }
    expect(TOOLS.filter((t) => t.mutating).map((t) => t.name)).toEqual([
      'create_record',
      'transition_record',
      'comment_on_record',
    ])
  })

  it('names a tool it does not have rather than returning nothing', async () => {
    await expect(runner.call(gcPm, { name: 'delete_record', arguments: {} })).rejects.toThrow(/No tool named/)
  })

  it('describes the types this deployment actually has, fields and workflow included', async () => {
    const types = (await runner.call(gcPm, { name: 'list_record_types', arguments: {} })) as {
      key: string
      transitions: { key: string; from: string[]; to: string }[]
    }[]

    const rfi = types.find((t) => t.key === 'rfi')
    expect(rfi).toBeDefined()
    // An agent that cannot see the transitions has to guess at them, and a
    // guessing agent writes drafts nobody can submit.
    expect(rfi!.transitions.length).toBeGreaterThan(0)
    expect(rfi!.transitions.every((t) => typeof t.to === 'string' && t.to !== '')).toBe(true)
  })
})

describe('an agent holding a trade partner’s session', () => {
  it('searches only the jobs that partner is on', async () => {
    const mine = (await runner.call(sub, {
      name: 'search_records',
      arguments: { query: 'anchor bolt embedment' },
    })) as { record: { id: string } }[]

    const ids = mine.map((r) => r.record.id)
    expect(ids).toContain(deckRfi)
    expect(ids).not.toContain(hospitalRfi)

    // Same words, same tenant, same moment: the GC sees both.
    const theirs = (await runner.call(gcPm, {
      name: 'search_records',
      arguments: { query: 'anchor bolt embedment' },
    })) as { record: { id: string } }[]
    expect(theirs.map((r) => r.record.id)).toEqual(expect.arrayContaining([deckRfi, hospitalRfi]))
  })

  it('cannot open a record on a job it is not on, even with the id in hand', async () => {
    await expect(runner.call(sub, { name: 'get_record', arguments: { recordId: hospitalRfi } })).rejects.toThrow()
  })

  it('cannot ask what is overdue on a job it is not on', async () => {
    // The id is not a secret. Membership is the check.
    await expect(runner.call(sub, { name: 'overdue_work', arguments: { projectId: hospital } })).rejects.toThrow()
    await expect(runner.call(sub, { name: 'overdue_work', arguments: { projectId: deck } })).resolves.toBeDefined()
  })

  it('cannot read another job’s ball in court', async () => {
    await expect(runner.call(sub, { name: 'ball_in_court', arguments: { projectId: hospital } })).rejects.toThrow()
  })
})

describe('writing through the workflow, or not at all', () => {
  it('creates records in their initial state, whatever the agent asks for', async () => {
    const created = (await runner.call(gcPm, {
      name: 'create_record',
      arguments: {
        projectId: deck,
        typeKey: 'rfi',
        title: 'Curtain wall anchor spacing',
        body: { question: 'Confirm spacing at the south elevation.', status: 'closed', state: 'closed' },
      },
    })) as { record: { id: string; status: string }; availableTransitions: { key: string }[] }

    // The agent passed a status in the body twice. Neither took: status is not
    // a field, it is where the record sits in its own workflow.
    expect(created.record.status).not.toBe('closed')
    expect(created.availableTransitions.length).toBeGreaterThan(0)
  })

  it('refuses a transition the workflow does not offer from here', async () => {
    const view = (await runner.call(gcPm, { name: 'get_record', arguments: { recordId: deckRfi } })) as {
      availableTransitions: { key: string }[]
      record: { status: string }
    }
    const offered = new Set(view.availableTransitions.map((t) => t.key))
    expect(offered.has('close')).toBe(false)

    await expect(
      runner.call(gcPm, { name: 'transition_record', arguments: { recordId: deckRfi, transitionKey: 'close' } }),
    ).rejects.toThrow()
  })

  it('refuses to submit a record with nobody to hand the ball to', async () => {
    // The agent left the assignee off, which is easy to do and produces a
    // draft that can never move. Refusing at the transition is the right
    // answer; the tool description has to say so, or an agent writes a
    // queue of dead drafts and reports them as filed.
    const orphan = (await runner.call(gcPm, {
      name: 'create_record',
      arguments: { projectId: deck, typeKey: 'rfi', title: 'Roof drain invert', body: { question: 'Which invert?' } },
    })) as { record: { id: string }; availableTransitions: { key: string }[] }

    await expect(
      runner.call(gcPm, {
        name: 'transition_record',
        arguments: { recordId: orphan.record.id, transitionKey: orphan.availableTransitions[0]!.key },
      }),
    ).rejects.toThrow(/assignee/)
  })

  it('runs a transition the workflow does offer, and moves the ball with it', async () => {
    const before = (await runner.call(gcPm, { name: 'get_record', arguments: { recordId: deckRfi } })) as {
      availableTransitions: { key: string }[]
    }
    const next = before.availableTransitions[0]!

    const after = (await runner.call(gcPm, {
      name: 'transition_record',
      arguments: { recordId: deckRfi, transitionKey: next.key },
    })) as { record: { status: string }; assignment: { holderUserId: string } | null }

    expect(after.record.status).toBeDefined()
    // Who owes the next move is a row, not a guess an agent makes.
    expect(after.assignment?.holderUserId).toBe(sub.userId)
  })

  it('attributes a comment to the person, not to the agent', async () => {
    const comment = (await runner.call(sub, {
      name: 'comment_on_record',
      arguments: { recordId: deckRfi, body: 'Steel is on the truck; this one gates erection.' },
    })) as { authorUserId: string; body: string }

    expect(comment.authorUserId).toBe(sub.userId)
  })
})
