import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { createPool, withTenant } from '../../src/db.js'
import { RecordKernel, type Actor } from '../../src/kernel.js'
import {
  addProjectMember,
  createOrganization,
  createProject,
  createUser,
  findTemplateByName,
  provisionTenant,
} from '../../src/provisioning.js'
import { clearRecordTypeCache } from '../../src/repositories/record-types.js'
import { ScheduleService } from '../../src/schedule/service.js'

/**
 * What is going to stop us this week.
 *
 * Not "when does the job finish". The schedule is here to be joined to the
 * paperwork, and the join is the product: an activity starting Thursday with
 * two days of float, and the RFI that has been with the architect for eleven
 * days, are the same problem, and nothing in this industry says so.
 */

const tab = (...cells: (string | number)[]): string => cells.join('\t')

function xer(options: { steelFloat?: number; includeGlass?: boolean } = {}): string {
  const lines = [
    tab('ERMHDR', '18.8.0', '2026-03-02', 'Project', 'admin', 'Primavera P6'),
    tab('%T', 'PROJECT'),
    tab('%F', 'proj_id', 'proj_short_name', 'day_hr_cnt', 'last_recalc_date'),
    tab('%R', '100', 'HARBOR', '8', '2026-03-02 00:00'),
    tab('%T', 'TASK'),
    tab('%F', 'task_id', 'proj_id', 'task_code', 'task_name', 'task_type', 'early_start_date',
        'early_end_date', 'total_float_hr_cnt', 'driving_path_flag'),
    tab('%R', '1', '100', 'A1010', 'Erect structural steel', 'TT_Task',
        futureDate(5), futureDate(19), String((options.steelFloat ?? 2) * 8), 'N'),
  ]
  if (options.includeGlass !== false) {
    lines.push(
      tab('%R', '2', '100', 'A1020', 'Install curtain wall', 'TT_Task', futureDate(23), futureDate(45), '160', 'N'),
    )
  }
  lines.push(
    tab('%R', '3', '100', 'A9000', 'Landscaping', 'TT_Task', futureDate(200), futureDate(220), '800', 'N'),
    tab('%E'),
  )
  return lines.join('\n')
}

function futureDate(days: number): string {
  return `${new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)} 08:00`
}

let pool: Pool
let kernel: RecordKernel
let schedule: ScheduleService
let tenantId: string
let projectId: string
let gcPm: Actor
let sub: Actor
let architectId: string
let rfiId: string

beforeAll(async () => {
  pool = createPool({ connectionString: inject('databaseUrl') })
  kernel = new RecordKernel(pool)
  schedule = new ScheduleService(pool)

  const tenant = await provisionTenant(pool, {
    tenantName: 'Lookahead Builders',
    organizationKind: 'general_contractor',
    admin: { email: 'admin@lookahead.test', name: 'Lee Admin', password: 'correct horse battery staple' },
  })
  tenantId = tenant.tenantId

  await withTenant(pool, tenantId, async (tx) => {
    const design = await createOrganization(tx, tenantId, { name: 'Bishop Architects', kind: 'architect' })
    const steel = await createOrganization(tx, tenantId, {
      name: 'Vega Steel',
      kind: 'specialty_contractor',
      trade: 'Structural Steel',
    })
    const employee = await findTemplateByName(tx, tenantId, 'company', 'Employee')
    const collaborator = await findTemplateByName(tx, tenantId, 'company', 'Collaborator')

    const pmId = await createUser(tx, tenantId, {
      organizationId: tenant.organizationId,
      email: 'pm@lookahead.test',
      name: 'Pat Moreno',
      companyPermissionTemplateId: employee,
    })
    architectId = await createUser(tx, tenantId, {
      organizationId: design,
      email: 'aor@bishop.test',
      name: 'Ali Bishop',
      companyPermissionTemplateId: collaborator,
    })
    const subId = await createUser(tx, tenantId, {
      organizationId: steel,
      email: 'pm@vega.test',
      name: 'Sasha Vega',
      companyPermissionTemplateId: collaborator,
    })

    projectId = await createProject(tx, tenantId, { number: '26-041', name: 'Harbor Point' })
    await addProjectMember(tx, tenantId, { projectId, userId: pmId, permissionTemplateName: 'Project Manager' })
    await addProjectMember(tx, tenantId, { projectId, userId: architectId, permissionTemplateName: 'Design Team' })
    await addProjectMember(tx, tenantId, { projectId, userId: subId, permissionTemplateName: 'Trade Partner' })

    gcPm = { tenantId, userId: pmId }
    sub = { tenantId, userId: subId }
  })
})

afterAll(async () => {
  await pool.end()
  clearRecordTypeCache()
})

describe('importing a schedule', () => {
  it('keeps every import and makes the newest one current', async () => {
    const first = await schedule.importXer(gcPm, {
      projectId,
      name: 'Baseline',
      text: xer(),
      asBaseline: true,
    })
    expect(first.imported).toBe(3)
    expect(first.dataDate).toBe('2026-03-02')

    const second = await schedule.importXer(gcPm, { projectId, name: 'Update 1', text: xer({ steelFloat: 1 }) })
    expect(second.imported).toBe(3)

    const all = await schedule.schedules(gcPm, projectId)
    // The old one is kept, always. "The schedule said we had four days of
    // float when we raised this" is the sentence a delay claim is built on.
    expect(all).toHaveLength(2)
    expect(all.filter((s) => s.isCurrent)).toHaveLength(1)
    expect(all.find((s) => s.isCurrent)!.name).toBe('Update 1')
    expect(all.find((s) => s.isBaseline)!.name).toBe('Baseline')
  })

  it('refuses a file that produced nothing rather than emptying the lookahead', async () => {
    await expect(
      schedule.importXer(gcPm, { projectId, name: 'Rubbish', text: 'not a schedule' }),
    ).rejects.toThrow(/produced no activities/)

    // And the current schedule is untouched.
    expect((await schedule.schedules(gcPm, projectId)).find((s) => s.isCurrent)!.name).toBe('Update 1')
  })

  it('will not let a trade partner import over the top of the job', async () => {
    await expect(schedule.importXer(sub, { projectId, name: 'Theirs', text: xer() })).rejects.toThrow(/import/i)
  })
})

describe('the lookahead', () => {
  it('shows what starts inside the window and nothing beyond it', async () => {
    const three = await schedule.lookahead(gcPm, projectId, 3)
    const codes = three.map((a) => a.activityCode)

    expect(codes).toContain('A1010')
    // Landscaping is two hundred days out. A six week lookahead is a
    // document; a three week one is a conversation.
    expect(codes).not.toContain('A9000')
  })

  it('orders by how little room is left, not by date alone', async () => {
    const window = await schedule.lookahead(gcPm, projectId, 8)
    const floats = window.map((a) => Number(a.totalFloatDays))
    expect(floats[0]).toBeLessThanOrEqual(floats[1]!)
  })
})

describe('the join that is the whole point', () => {
  it('links a record to an activity code, which survives the next import', async () => {
    const rfi = await kernel.create(gcPm, {
      projectId,
      typeKey: 'rfi',
      title: 'Anchor bolt embedment at grid C4',
      body: { question: 'Nine inch on S-401, seven on the shop drawings. Which governs?' },
      participants: [{ userId: architectId, role: 'assignee' }],
    })
    rfiId = rfi.record.id
    await kernel.transition(gcPm, rfiId, { transitionKey: 'submit' })

    await schedule.link(gcPm, { recordId: rfiId, activityCode: 'A1010', kind: 'blocks' })

    const links = await schedule.linksFor(gcPm, rfiId)
    expect(links).toHaveLength(1)
    expect(links[0]!.name).toBe('Erect structural steel')

    // Reimport. The link points at a CODE, not a row, which is why it is
    // still here: a link that died every Monday is a feature nobody uses
    // twice.
    await schedule.importXer(gcPm, { projectId, name: 'Update 2', text: xer({ steelFloat: 1 }) })
    expect(await schedule.linksFor(gcPm, rfiId)).toHaveLength(1)
  })

  it('says which links now point at nothing when an activity disappears', async () => {
    await schedule.link(gcPm, { recordId: rfiId, activityCode: 'A1020', kind: 'informs' })

    const result = await schedule.importXer(gcPm, {
      projectId,
      name: 'Resequenced',
      text: xer({ includeGlass: false }),
    })

    // An activity deleted from the programme usually means somebody
    // resequenced the work, and the RFI attached to it still matters.
    expect(result.orphanedLinks).toEqual([{ recordDesignation: expect.stringMatching(/^RFI-/), activityCode: 'A1020' }])
  })

  it('refuses a link to an activity that is not on the current schedule', async () => {
    // A typo'd code would otherwise sit in the table looking like a link and
    // matching nothing forever.
    await expect(schedule.link(gcPm, { recordId: rfiId, activityCode: 'A9999' })).rejects.toThrow(
      /No activity A9999/,
    )
  })

  it('puts the float and the wait side by side, which is the product', async () => {
    const exposure = await schedule.exposure(gcPm, projectId)

    const steel = exposure.find((e) => e.activityCode === 'A1010')!
    expect(steel.activityName).toBe('Erect structural steel')
    expect(steel.openRecords).toBe(1)
    expect(steel.records[0]!.designation).toMatch(/^RFI-/)
    // Who is actually sitting on it, by name. "With the design team" is not
    // a thing anybody can act on.
    expect(steel.records[0]!.holderName).toBe('Ali Bishop')
    // Two days, from the last import. The number is whatever P6 said at the
    // data date, never recomputed here.
    expect(Number(steel.totalFloatDays)).toBe(2)

    // Landscaping has nothing blocking it and does not appear at all. An
    // exposure list that includes everything is a schedule printout.
    expect(exposure.map((e) => e.activityCode)).not.toContain('A9000')
  })

  it('drops an activity off the list once the thing blocking it is closed', async () => {
    const architect: Actor = { tenantId, userId: architectId }
    await kernel.transition(architect, rfiId, {
      transitionKey: 'answer',
      body: { answer: 'Nine inch governs. Revise and resubmit.' },
    })
    await kernel.transition(gcPm, rfiId, { transitionKey: 'close' })

    const exposure = await schedule.exposure(gcPm, projectId)
    // Terminal is read out of the record type's own definition rather than
    // from a second list here, which is why closing an RFI is enough.
    expect(exposure.map((e) => e.activityCode)).not.toContain('A1010')
  })
})
