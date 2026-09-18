#!/usr/bin/env node
/**
 * Seeds a demo tenant: one project, the cast that makes permissions visible,
 * records in every state, work sitting in somebody's court, and a pending
 * capture proposal waiting at the approval gate.
 *
 * For looking at the product — in a browser, or in a screenshot run — rather
 * than for testing it. Every write goes through the ordinary kernel path, so
 * what you see is what the product actually produces, not fixtures shaped to
 * look good.
 *
 *   DATABASE_URL=postgres://…/plumbline node scripts/seed-demo.mjs
 *
 * Prints the sign-in credentials it created.
 */

import {
  addProjectMember,
  CaptureService,
  createOrganization,
  createPool,
  createProject,
  createUser,
  findTemplateByName,
  provisionTenant,
  RecordKernel,
  withTenant,
} from '@plumbline/shared'

const PASSWORD = 'plumbline-demo'

/** A scripted interpreter, so seeding needs no API key and no spend. */
class DemoProvider {
  name = 'demo'
  #queue = []
  push(output) {
    this.#queue.push(output)
  }
  async interpret() {
    const next = this.#queue.shift()
    if (!next) throw new Error('DemoProvider ran out of queued outputs')
    return {
      output: next,
      model: 'claude-opus-5',
      usage: { inputTokens: 1200, outputTokens: 180, cacheReadTokens: 900, cacheWriteTokens: 0 },
    }
  }
}

const pool = createPool()

const tenant = await provisionTenant(pool, {
  tenantName: 'Ridgeline Builders',
  organizationKind: 'general_contractor',
  admin: { email: 'admin@ridgeline.test', name: 'Dana Admin', password: PASSWORD },
})

const cast = await withTenant(pool, tenant.tenantId, async (tx) => {
  const design = await createOrganization(tx, tenant.tenantId, { name: 'Bishop Architects', kind: 'architect' })
  const steel = await createOrganization(tx, tenant.tenantId, {
    name: 'Vega Steel',
    kind: 'specialty_contractor',
    trade: 'Structural Steel',
  })
  const employee = await findTemplateByName(tx, tenant.tenantId, 'company', 'Employee')
  const collaborator = await findTemplateByName(tx, tenant.tenantId, 'company', 'Collaborator')

  const pm = await createUser(tx, tenant.tenantId, {
    organizationId: tenant.organizationId,
    email: 'pm@ridgeline.test',
    name: 'Priya Mehta',
    jobTitle: 'Project Manager',
    password: PASSWORD,
    companyPermissionTemplateId: employee,
  })
  const superintendent = await createUser(tx, tenant.tenantId, {
    organizationId: tenant.organizationId,
    email: 'super@ridgeline.test',
    name: 'Sam Ruiz',
    jobTitle: 'Superintendent',
    password: PASSWORD,
    companyPermissionTemplateId: employee,
  })
  const architect = await createUser(tx, tenant.tenantId, {
    organizationId: design,
    email: 'aor@bishop.test',
    name: 'Ali Bishop',
    jobTitle: 'Architect of Record',
    password: PASSWORD,
    companyPermissionTemplateId: collaborator,
  })
  const trade = await createUser(tx, tenant.tenantId, {
    organizationId: steel,
    email: 'foreman@vega.test',
    name: 'Tomas Vega',
    jobTitle: 'Foreman',
    password: PASSWORD,
    companyPermissionTemplateId: collaborator,
  })

  const harborPoint = await createProject(tx, tenant.tenantId, {
    number: '24-118',
    name: 'Harbor Point Phase II',
    stage: 'course_of_construction',
    city: 'Seattle',
    stateCode: 'WA',
    contractValue: '48500000.00',
  })
  const eastyard = await createProject(tx, tenant.tenantId, {
    number: '25-006',
    name: 'Eastyard Transit Center',
    stage: 'pre_construction',
    city: 'Tacoma',
    stateCode: 'WA',
    contractValue: '12250000.00',
  })

  for (const projectId of [harborPoint, eastyard]) {
    for (const [userId, template] of [
      [pm, 'Project Manager'],
      [superintendent, 'Superintendent'],
      [architect, 'Design Team'],
      [trade, 'Trade Partner'],
    ]) {
      await addProjectMember(tx, tenant.tenantId, {
        projectId,
        userId,
        permissionTemplateId: await findTemplateByName(tx, tenant.tenantId, 'project', template),
      })
    }
  }

  return { pm, superintendent, architect, trade, harborPoint, eastyard }
})

const kernel = new RecordKernel(pool)
const pm = { tenantId: tenant.tenantId, userId: cast.pm }
const superintendent = { tenantId: tenant.tenantId, userId: cast.superintendent }
const architect = { tenantId: tenant.tenantId, userId: cast.architect }

// An RFI waiting on the architect.
const anchors = await kernel.create(pm, {
  projectId: cast.harborPoint,
  typeKey: 'rfi',
  title: 'Anchor bolt embedment at grid C4',
  body: {
    question:
      'The anchor detail at grid C4 shows nine inch embedment on S-401 but the shop drawings came through at seven. Which governs? Columns set Thursday.',
    discipline: 'Structural',
    drawing_number: 'S-401',
    cost_impact: 'TBD',
    schedule_impact: 'Yes',
  },
  participants: [{ userId: cast.architect, role: 'assignee' }],
})
await kernel.transition(pm, anchors.record.id, { transitionKey: 'submit' })

// One already answered, so a closed-loop record is on screen too.
const ducts = await kernel.create(pm, {
  projectId: cast.harborPoint,
  typeKey: 'rfi',
  title: 'Duct routing conflict above corridor 2',
  body: {
    question: 'The 24in duct above the level 2 corridor does not clear the structure as drawn.',
    discipline: 'Mechanical',
    cost_impact: 'Yes',
    schedule_impact: 'Yes',
  },
  participants: [{ userId: cast.architect, role: 'assignee' }],
})
await kernel.transition(pm, ducts.record.id, { transitionKey: 'submit' })
await kernel.transition(architect, ducts.record.id, {
  transitionKey: 'answer',
  body: { answer: 'Reroute per sketch SK-12. Clearance holds at 9in above the ceiling grid.' },
})

// Punch work sitting with the steel foreman.
const handrail = await kernel.create(superintendent, {
  projectId: cast.harborPoint,
  typeKey: 'punch_item',
  title: 'Handrail loose at level 4 stair',
  body: {
    description: 'Handrail is loose where it meets the wall bracket at the level 4 stair.',
    location: 'Level 4 stair',
    trade: 'Structural Steel',
    priority: 'High',
  },
  participants: [{ userId: cast.trade, role: 'assignee' }],
})
await kernel.transition(superintendent, handrail.record.id, { transitionKey: 'issue' })

await kernel.create(superintendent, {
  projectId: cast.harborPoint,
  typeKey: 'observation',
  title: 'Guardrail missing at level 5 north',
  body: {
    description: 'Guardrail missing on the north side of level 5 at the stair opening.',
    observation_type: 'Safety',
    location: 'Level 5 north',
    priority: 'High',
  },
  participants: [{ userId: cast.trade, role: 'assignee' }],
})

// A capture from the field, drafted and waiting at the gate.
const provider = new DemoProvider()
provider.push({
  typeKey: 'observation',
  title: 'Water staining on level 2 ceiling tiles',
  fields: [
    {
      key: 'description',
      value: 'Water staining across several ceiling tiles in the northeast corner of level 2. Cause not yet known.',
    },
    { key: 'observation_type', value: 'Quality' },
    { key: 'location', value: 'Level 2 northeast' },
  ],
  participants: [],
  confidence: 0.72,
  rationale:
    'The note reports a condition seen on a walk, with no cause established and nobody assigned, which is an observation rather than a punch item.',
})
const capture = new CaptureService(pool, provider)
const signal = await capture.record(superintendent, {
  projectId: cast.harborPoint,
  kind: 'voice',
  text: 'Walking level two. Water staining on the ceiling tiles in the northeast corner. I do not know yet whether that is the roof or a pipe, so I am not assigning it until we look above the ceiling.',
  latitude: 47.61,
  longitude: -122.33,
})
await capture.interpret(superintendent, signal.id)

await pool.end()

console.log('Seeded Ridgeline Builders.')
console.log('')
console.log(`  pm@ridgeline.test      ${PASSWORD}   Project Manager, can do everything`)
console.log(`  super@ridgeline.test   ${PASSWORD}   Superintendent`)
console.log(`  aor@bishop.test        ${PASSWORD}   Architect, answers RFIs and cannot close them`)
console.log(`  foreman@vega.test      ${PASSWORD}   Trade partner, sees almost nothing`)
