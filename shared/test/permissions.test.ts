import { describe, expect, it } from 'vitest'
import { PermissionDeniedError } from '../src/errors.js'
import {
  assertTransitionAllowed,
  buildAccess,
  hasPrivilege,
  levelAtLeast,
  toolAccess,
  type Grant,
} from '../src/permissions.js'
import type { TransitionSpec } from '../src/record-type.js'
import type { ParticipantRole, PermissionScope } from '../src/types.js'

const TOOL_SCOPES = new Map<string, PermissionScope>([
  ['directory', 'company'],
  ['projects', 'company'],
  ['rfis', 'project'],
  ['punch_list', 'project'],
])

function access(options: {
  companyGrants?: Grant[]
  projectGrants?: Grant[]
  isProjectMember?: boolean
}) {
  return buildAccess({
    userId: 'u1',
    tenantId: 't1',
    projectId: 'p1',
    toolScopes: TOOL_SCOPES,
    companyGrants: options.companyGrants ?? [],
    projectGrants: options.projectGrants ?? [],
    isProjectMember: options.isProjectMember ?? true,
  })
}

describe('levelAtLeast', () => {
  it('orders the four levels', () => {
    expect(levelAtLeast('admin', 'standard')).toBe(true)
    expect(levelAtLeast('standard', 'standard')).toBe(true)
    expect(levelAtLeast('read_only', 'standard')).toBe(false)
    expect(levelAtLeast('none', 'read_only')).toBe(false)
  })
})

describe('buildAccess', () => {
  it('gives no project tools to someone who is not on the project', () => {
    const snapshot = access({
      projectGrants: [{ toolKey: 'rfis', level: 'admin', privileges: [] }],
      isProjectMember: false,
    })
    // The grant exists on the template; the membership does not. Absence of
    // membership is a hard no, not a downgrade to read-only.
    expect(toolAccess(snapshot, 'rfis').level).toBe('none')
  })

  it('treats a company directory admin as admin everywhere, with every privilege', () => {
    const snapshot = access({
      companyGrants: [{ toolKey: 'directory', level: 'admin', privileges: [] }],
      isProjectMember: false,
    })
    expect(snapshot.isCompanyAdmin).toBe(true)
    expect(toolAccess(snapshot, 'rfis').level).toBe('admin')
    expect(hasPrivilege(snapshot, 'rfis', 'a-privilege-invented-next-year')).toBe(true)
  })

  it('reads company tools from the company template and project tools from the project one', () => {
    const snapshot = access({
      companyGrants: [{ toolKey: 'directory', level: 'read_only', privileges: [] }],
      projectGrants: [{ toolKey: 'rfis', level: 'standard', privileges: ['respond'] }],
    })
    expect(toolAccess(snapshot, 'directory').level).toBe('read_only')
    expect(toolAccess(snapshot, 'rfis').level).toBe('standard')
    expect(hasPrivilege(snapshot, 'rfis', 'respond')).toBe(true)
    expect(hasPrivilege(snapshot, 'rfis', 'close')).toBe(false)
  })

  it('denies tools the template never mentions', () => {
    const snapshot = access({ projectGrants: [{ toolKey: 'rfis', level: 'admin', privileges: [] }] })
    expect(toolAccess(snapshot, 'punch_list').level).toBe('none')
  })
})

const ANSWER: TransitionSpec = {
  key: 'answer',
  label: 'Answer',
  from: ['open'],
  to: 'answered',
  requires: { level: 'standard', privilege: 'respond' },
}

const SUBMIT: TransitionSpec = {
  key: 'submit',
  label: 'Submit',
  from: ['draft'],
  to: 'open',
  requires: { level: 'standard', participantRoles: ['creator'] },
}

const roles = (...list: ParticipantRole[]) => new Set(list)

describe('assertTransitionAllowed', () => {
  it('allows a reviewer with the level and the privilege', () => {
    const snapshot = access({ projectGrants: [{ toolKey: 'rfis', level: 'standard', privileges: ['respond'] }] })
    expect(() => assertTransitionAllowed(snapshot, 'rfis', ANSWER, roles('assignee'))).not.toThrow()
  })

  it('refuses the level without the privilege', () => {
    const snapshot = access({ projectGrants: [{ toolKey: 'rfis', level: 'standard', privileges: [] }] })
    expect(() => assertTransitionAllowed(snapshot, 'rfis', ANSWER, roles('assignee'))).toThrow(PermissionDeniedError)
  })

  it('refuses the privilege without the level', () => {
    const snapshot = access({ projectGrants: [{ toolKey: 'rfis', level: 'read_only', privileges: ['respond'] }] })
    expect(() => assertTransitionAllowed(snapshot, 'rfis', ANSWER, roles('assignee'))).toThrow(PermissionDeniedError)
  })

  it('enforces the role held on the record, even for a company admin', () => {
    const admin = access({ companyGrants: [{ toolKey: 'directory', level: 'admin', privileges: [] }] })
    // Being a company administrator does not make you the author of this RFI.
    expect(() => assertTransitionAllowed(admin, 'rfis', SUBMIT, roles('watcher'))).toThrow(PermissionDeniedError)
    expect(() => assertTransitionAllowed(admin, 'rfis', SUBMIT, roles('creator'))).not.toThrow()
  })
})
