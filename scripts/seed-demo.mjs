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
  BudgetService,
  CaptureService,
  CommitmentService,
  createBudgetCode,
  InvoicingService,
  createOrganization,
  createPool,
  createProject,
  createUser,
  findTemplateByName,
  provisionTenant,
  RecordKernel,
  StatutoryService,
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
        permissionTemplateName: template,
      })
    }
  }

  return { pm, superintendent, architect, trade, harborPoint, eastyard, steelOrg: steel, designOrg: design }
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

/* -------------------------------------------------------------------------
 * The money.
 *
 * Seeded through the ordinary services, so every figure on the budget screen
 * is computed by the database view the way it would be on a real job. None of
 * these numbers is stored as a total anywhere.
 * ---------------------------------------------------------------------- */

const budget = new BudgetService(pool)
const commitments = new CommitmentService(pool)
const invoicing = new InvoicingService(pool)

const LINES = [
  { code: '03 00 00', type: 'S', label: 'Concrete', amount: '6200000.00' },
  { code: '05 00 00', type: 'S', label: 'Structural steel', amount: '9400000.00' },
  { code: '07 00 00', type: 'S', label: 'Roofing and waterproofing', amount: '2850000.00' },
  { code: '09 00 00', type: 'S', label: 'Interior finishes', amount: '4750000.00' },
  { code: '23 00 00', type: 'S', label: 'Mechanical', amount: '7100000.00' },
  { code: '26 00 00', type: 'S', label: 'Electrical', amount: '5900000.00' },
  { code: '01 00 00', type: 'L', label: 'General conditions', amount: '3150000.00' },
]

const codes = {}
for (const line of LINES) {
  const created = await createBudgetCode(pool, tenant.tenantId, {
    projectId: cast.harborPoint,
    values: { cost_code: line.code, cost_type: line.type },
  })
  codes[line.code] = created.id
  await budget.addLine(pm, {
    projectId: cast.harborPoint,
    budgetCodeId: created.id,
    description: line.label,
    originalAmount: line.amount,
  })
}

// A signed subcontract, billed once and paid. The committed figure comes from
// the commitment itself, the actual from approving the payment application —
// neither is typed in, which is what the budget screen is demonstrating.
const steelSub = await commitments.create(pm, {
  projectId: cast.harborPoint,
  kind: 'subcontract',
  number: 'SC-05-001',
  title: 'Structural steel, furnish and erect',
  vendorOrgId: cast.steelOrg,
  retainagePercent: '5',
  lines: [
    { budgetCodeId: codes['05 00 00'], description: 'Fabrication', amount: '5600000.00' },
    { budgetCodeId: codes['05 00 00'], description: 'Erection', amount: '3550000.00' },
  ],
})
await commitments.execute(pm, steelSub.id)

// The SUB raises their own payment application and the GC approves it. The
// seed got this wrong first time and the product refused, which is the
// separation working: a general contractor who can submit an invoice on a
// subcontractor's behalf can also approve it.
const trade = { tenantId: tenant.tenantId, userId: cast.trade }
const billing = await invoicing.lineBilling(pm, steelSub.id)
const app1 = await invoicing.createInvoice(trade, {
  commitmentId: steelSub.id,
  number: '001',
  periodStart: '2026-07-01',
  periodEnd: '2026-07-31',
  lines: billing.map((l) => ({ commitmentLineId: l.commitmentLineId, amount: '820000.00' })),
})
await invoicing.submit(trade, app1.id)
await invoicing.approve(pm, app1.id)
await invoicing.recordLienWaiver(pm, app1.id)
await invoicing.markPaid(pm, app1.id)

// And a cost nobody invoiced: a T&M ticket settled in the field. Typed by
// hand, which is why the cost panel says who typed it.
await budget.recordCost(pm, {
  projectId: cast.harborPoint,
  budgetCodeId: codes['01 00 00'],
  kind: 'actual',
  amount: '38400.00',
  description: 'T&M ticket 114 — Saturday overtime, dewatering',
  incurredOn: '2026-08-15',
})
await budget.recordCost(pm, {
  projectId: cast.harborPoint,
  budgetCodeId: codes['23 00 00'],
  kind: 'pending',
  amount: '210000.00',
  description: 'Pending change: temporary power for early mechanical start',
})

/* -------------------------------------------------------------------------
 * Lien and bond deadlines. Federal work, first tier sub, so the Miller Act
 * rules apply — and the product ships with both of them UNVERIFIED, which is
 * what the screen is really demonstrating.
 * ---------------------------------------------------------------------- */

const statutory = new StatutoryService(pool)
await statutory.setFacts(pm, cast.harborPoint, {
  jurisdiction: 'US-MILLER',
  projectType: 'federal',
  claimantRole: 'first_tier_subcontractor',
  firstFurnishing: '2026-03-02',
  lastFurnishing: '2026-08-28',
})
await statutory.sweep(pm, cast.harborPoint)

await pool.end()

console.log('Seeded Ridgeline Builders.')
console.log('')
console.log(`  pm@ridgeline.test      ${PASSWORD}   Project Manager, can do everything`)
console.log(`  super@ridgeline.test   ${PASSWORD}   Superintendent`)
console.log(`  aor@bishop.test        ${PASSWORD}   Architect, answers RFIs and cannot close them`)
console.log(`  foreman@vega.test      ${PASSWORD}   Trade partner, sees almost nothing`)
