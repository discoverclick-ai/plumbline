import type { RecordBody } from './record-type.js'

export type PermissionLevel = 'none' | 'read_only' | 'standard' | 'admin'

export type PermissionScope = 'company' | 'project'

export type ParticipantRole = 'creator' | 'assignee' | 'reviewer' | 'approver' | 'distribution' | 'watcher'

export type OrganizationKind =
  | 'owner'
  | 'general_contractor'
  | 'specialty_contractor'
  | 'architect'
  | 'engineer'
  | 'supplier'
  | 'consultant'
  | 'other'

export type ProjectStage =
  | 'bidding'
  | 'pre_construction'
  | 'course_of_construction'
  | 'post_construction'
  | 'warranty'
  | 'closed'

export interface Organization {
  id: string
  tenantId: string
  name: string
  kind: OrganizationKind
  trade: string | null
  isSelf: boolean
}

export interface User {
  id: string
  tenantId: string
  organizationId: string
  email: string
  name: string
  jobTitle: string | null
  isActive: boolean
  companyPermissionTemplateId: string | null
}

export interface Project {
  id: string
  tenantId: string
  number: string
  name: string
  stage: ProjectStage
  city: string | null
  stateCode: string | null
  timeZone: string
  startDate: string | null
  projectedFinishDate: string | null
  contractValue: string | null
}

export interface ProjectMembership {
  id: string
  projectId: string
  userId: string
  permissionTemplateId: string | null
}

export interface ConstructionRecord {
  id: string
  tenantId: string
  projectId: string
  typeKey: string
  typeVersion: number
  number: number
  designation: string
  title: string
  body: RecordBody
  status: string
  ballInCourtUserId: string | null
  dueAt: string | null
  createdBy: string
  updatedBy: string
  version: number
  closedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface RecordParticipant {
  id: string
  recordId: string
  userId: string
  role: ParticipantRole
  position: number
}

export interface RecordAssignment {
  id: string
  recordId: string
  holderUserId: string
  expectedAction: string
  dueAt: string | null
  assignedBy: string
  assignedAt: string
  releasedAt: string | null
  releasedReason: string | null
}

export interface RecordStateChange {
  id: number
  recordId: string
  fromStatus: string | null
  toStatus: string
  transitionKey: string
  actorUserId: string
  note: string | null
  occurredAt: string
}

export interface RecordComment {
  id: string
  recordId: string
  authorUserId: string
  body: string
  createdAt: string
}

/**
 * One line of the "who is blocking what, and for how long" view. This is a
 * query, not a report: it is the reason ball-in-court is an assignment row
 * rather than a status string.
 */
export interface BallInCourtEntry {
  recordId: string
  projectId: string
  projectName: string
  typeKey: string
  designation: string
  title: string
  status: string
  holderUserId: string
  holderName: string
  expectedAction: string
  assignedAt: string
  dueAt: string | null
  /** Whole days the current holder has been sitting on it. */
  ageDays: number
  overdue: boolean
}
