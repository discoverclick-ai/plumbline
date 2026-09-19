import type {
  BallInCourtEntry,
  ConstructionRecord,
  FieldSpec,
  ParticipantRole,
  PermissionLevel,
  RecordAssignment,
  RecordComment,
  RecordParticipant,
  RecordStateChange,
  StateSpec,
} from '@plumbline/shared'

/**
 * The API client.
 *
 * Every screen in this app is rendered from two server responses: the record
 * type registry (what the fields and states of a tool are) and the permission
 * map (what this person may do with it). Neither is hard-coded here, which is
 * what lets a tool added by a migration appear in the UI with no client
 * release.
 */

export interface ToolAccessView {
  level: PermissionLevel
  /** '*' for a company administrator, who holds every privilege by definition. */
  privileges: string[] | '*'
}

export interface MeView {
  user: { id: string; name: string; email: string; job_title: string | null; organization: string } | null
  isCompanyAdmin: boolean
  isProjectMember: boolean
  tools: Record<string, ToolAccessView>
}

export interface RecordTypeView {
  key: string
  toolKey: string
  displayName: string
  displayNamePlural: string
  numberPrefix: string
  fields: FieldSpec[]
  states: StateSpec[]
  transitions: { key: string; label: string; from: string[]; to: string; requiresFields: string[] }[]
}

export interface ProjectView {
  id: string
  number: string
  name: string
  stage: string
  city: string | null
  state_code: string | null
  contract_value: string | null
}

export interface RecordView {
  record: ConstructionRecord
  type: { key: string; displayName: string; toolKey: string }
  statusLabel: string
  participants: RecordParticipant[]
  assignment: RecordAssignment | null
  /** Only the transitions this actor may run. The button bar renders from this. */
  availableTransitions: { key: string; label: string }[]
}

export interface ProposalView {
  id: string
  captureId: string
  projectId: string
  typeKey: string
  title: string
  body: Record<string, string | number | boolean | null>
  participants: { userId: string; role: ParticipantRole }[]
  confidence: number | null
  rationale: string | null
  model: string | null
  issues: { field: string; message: string }[]
  status: 'pending' | 'accepted' | 'rejected' | 'superseded'
  edited: boolean
  recordId: string | null
  createdAt: string
}

export interface CaptureView {
  id: string
  projectId: string
  kind: 'photo' | 'voice' | 'document' | 'text' | 'email'
  text: string | null
  capturedAt: string
  status: string
}

/** Carries the API's own error code and per-field issues to the UI unchanged. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly issues: { field: string; message: string }[] = [],
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/**
 * Money arrives as strings and stays that way until it is formatted.
 *
 * Parsing it into a JavaScript number to render it is the one line that would
 * undo the care taken in the database: 0.1 is not representable, and a budget
 * that is a cent out is a budget somebody stops trusting.
 */
export interface BudgetLineView {
  budgetLineId: string
  budgetCodeId: string
  budgetCode: string
  description: string
  unitOfMeasure: string | null
  originalQuantity: string | null
  quantityToDate: string
  /** Null for somebody who may see the budget and not what it costs. */
  originalAmount: string | null
  approvedRevisions: string | null
  currentBudget: string | null
  committedCost: string | null
  actualCost: string | null
  pendingCost: string | null
  projectedCost: string | null
  projectedOverUnder: string | null
}

export interface CommitmentView {
  commitmentId: string
  kind: 'subcontract' | 'purchase_order'
  number: string
  title: string
  status: 'draft' | 'out_for_signature' | 'executed' | 'closed' | 'void'
  vendorOrgId: string
  retainagePercent: string
  originalValue: string
  executedChanges: string
  currentValue: string
}

/**
 * A contract instrument, as much of one as this person may know about.
 *
 * The list a trade partner gets back is not the list a general contractor
 * gets back, and that is the server's decision, not this client's. Nothing
 * here filters.
 */
export interface ContractDocumentView {
  id: string
  projectId: string
  kind: string
  title: string
  counterpartyOrgId: string | null
  parentDocumentId: string | null
  executedAt: string | null
  effectiveAt: string | null
  status: string
  clauseCount: number
  version: number
}

export interface ClauseView {
  id: string
  clauseNumber: string | null
  heading: string | null
  text: string
  page: number | null
  orderIndex: number
}

export interface ObligationView {
  id: string
  documentId: string
  clauseId: string
  clauseNumber: string | null
  quote: string
  obligationType: string
  triggerDescription: string
  durationValue: number
  durationUnit: string
  deadlineBasis: string
  consequence: string
  confidence: string | null
  rationale: string | null
  status: 'proposed' | 'accepted' | 'rejected' | 'superseded'
  inheritedFromId: string | null
}

/**
 * A running deadline.
 *
 * Carries the clause NUMBER and never the clause text: a superintendent needs
 * to know a notice is due today, and does not need the prime's indemnity
 * language to find that out.
 */
export interface ClockView {
  id: string
  state: 'watching' | 'in_court' | 'satisfied' | 'expired' | 'tolled' | 'waived' | 'cancelled'
  obligationType: string
  consequence: string
  clauseNumber: string | null
  triggerDescription: string
  startedAt: string
  dueAt: string
  warnAt: string
  noticeRecordId: string | null
  noticeDesignation: string | null
  noticeStatus: string | null
  triggerDesignation: string | null
  triggerTitle: string | null
  computation: Record<string, unknown>
}

export interface ActivityView {
  activityCode: string
  name: string
  wbsPath: string | null
  startAt: string | null
  finishAt: string | null
  actualStart: string | null
  actualFinish: string | null
  totalFloatDays: string | null
  isCritical: boolean
  isMilestone: boolean
  predecessors: string[]
}

/**
 * One line of the morning meeting.
 *
 * `totalFloatDays` and `longestWaitDays` next to each other is the whole
 * screen: an RFI sitting eleven days against an activity with two days of
 * float is not a paperwork problem, it is a delay that has already happened
 * and nobody has said so.
 */
export interface ExposureView {
  activityCode: string
  activityName: string
  startAt: string | null
  finishAt: string | null
  totalFloatDays: string | null
  isCritical: boolean
  openRecords: number
  longestWaitDays: number | null
  floatRemainingDays: number | null
  records: { recordId: string; designation: string; title: string; status: string; holderName: string | null }[]
}

export interface PhotoView {
  id: string
  projectId: string
  filename: string | null
  contentType: string
  byteSize: number
  /** Local, with no zone: what the camera wrote. */
  takenAtLocal: string | null
  uploadedAt: string
  latitude: string | null
  longitude: string | null
  orientation: number | null
  cameraMake: string | null
  cameraModel: string | null
  width: number | null
  height: number | null
  metadataRead: boolean
  caption: string | null
  uploadedByName: string | null
  albums: string[]
  recordIds: string[]
}

export interface EscalationView {
  id: string
  recordId: string
  designation: string
  title: string
  typeKey: string
  level: string
  reason: string
  message: string
  notifiedId: string
  notifiedName: string | null
  holderName: string | null
  daysWaiting: number
  dueAt: string | null
  createdAt: string
}

export interface SheetView {
  drawingId: string
  number: string
  title: string
  discipline: string | null
  revisionId: string
  revisionLabel: string
  sequence: number
  setName: string
  issuedOn: string
  revisionCount: number
}

export interface PinView {
  pinId: string
  recordId: string
  page: number
  x: string
  y: string
  revisionId: string
  revisionLabel: string
  /** False when the pin was placed on an earlier revision of this sheet. */
  onCurrentRevision: boolean
}

export interface RequirementView {
  id: string
  sectionId: string
  sectionNumber: string
  submittalType: string
  description: string
  /** Verbatim from the section. Checked by the server, shown by the client. */
  quote: string
  status: 'proposed' | 'accepted' | 'rejected' | 'satisfied'
  confidence: string | null
  submittalId: string | null
}

export interface StatutoryClockView {
  id: string
  state: string
  deadlineType: string
  citation: string
  citationUrl: string | null
  summary: string
  consequence: string
  startedOn: string
  dueOn: string
  warnOn: string
  triggeredBy: string
  noticeRecordId: string | null
  computation: Record<string, unknown>
}

export class ApiClient {
  constructor(
    private readonly baseUrl: string,
    private token: string | null = null,
  ) {}

  setToken(token: string | null): void {
    this.token = token
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })

    const text = await response.text()
    const payload: unknown = text.length > 0 ? JSON.parse(text) : {}

    if (!response.ok) {
      const error = payload as { error?: string; message?: string; issues?: { field: string; message: string }[] }
      throw new ApiError(
        response.status,
        error.error ?? 'error',
        error.message ?? `${method} ${path} failed`,
        error.issues ?? [],
      )
    }
    return payload as T
  }

  signIn(email: string, password: string): Promise<{ token: string; expiresAt: string; userId: string }> {
    return this.request('POST', '/auth/sign-in', { email, password })
  }

  signOut(): Promise<{ signedOut: boolean }> {
    return this.request('POST', '/auth/sign-out')
  }

  me(projectId?: string): Promise<MeView> {
    return this.request('GET', projectId ? `/me?projectId=${projectId}` : '/me')
  }

  recordTypes(): Promise<{ types: RecordTypeView[] }> {
    return this.request('GET', '/record-types')
  }

  projects(): Promise<{ projects: ProjectView[] }> {
    return this.request('GET', '/projects')
  }

  members(projectId: string): Promise<{
    members: { userId: string; name: string; jobTitle: string | null; organization: string }[]
  }> {
    return this.request('GET', `/projects/${projectId}/members`)
  }

  records(projectId: string, params: { type?: string; status?: string; open?: boolean } = {}): Promise<{
    records: ConstructionRecord[]
  }> {
    const query = new URLSearchParams()
    if (params.type) query.set('type', params.type)
    if (params.status) query.set('status', params.status)
    if (params.open) query.set('open', 'true')
    const suffix = query.toString() ? `?${query}` : ''
    return this.request('GET', `/projects/${projectId}/records${suffix}`)
  }

  createRecord(
    projectId: string,
    input: {
      typeKey: string
      title: string
      body: Record<string, unknown>
      participants?: { userId: string; role: ParticipantRole }[]
    },
  ): Promise<RecordView> {
    return this.request('POST', `/projects/${projectId}/records`, input)
  }

  record(recordId: string): Promise<RecordView> {
    return this.request('GET', `/records/${recordId}`)
  }

  transition(
    recordId: string,
    input: { transitionKey: string; body?: Record<string, unknown>; note?: string; expectedVersion?: number },
  ): Promise<RecordView> {
    return this.request('POST', `/records/${recordId}/transitions`, input)
  }

  comment(recordId: string, body: string): Promise<RecordComment> {
    return this.request('POST', `/records/${recordId}/comments`, { body })
  }

  history(recordId: string): Promise<{ states: RecordStateChange[]; comments: RecordComment[] }> {
    return this.request('GET', `/records/${recordId}/history`)
  }

  ballInCourt(
    params: { projectId?: string; holderUserId?: string; overdue?: boolean } = {},
  ): Promise<{ entries: BallInCourtEntry[] }> {
    const query = new URLSearchParams()
    if (params.projectId) query.set('projectId', params.projectId)
    if (params.holderUserId) query.set('holderUserId', params.holderUserId)
    if (params.overdue) query.set('overdue', 'true')
    const suffix = query.toString() ? `?${query}` : ''
    return this.request('GET', `/ball-in-court${suffix}`)
  }

  capture(
    projectId: string,
    input: { kind: CaptureView['kind']; text?: string; storageKey?: string; contentType?: string },
  ): Promise<CaptureView> {
    return this.request('POST', `/projects/${projectId}/captures`, input)
  }

  budget(projectId: string): Promise<{ costsVisible: boolean; lines: BudgetLineView[] }> {
    return this.request('GET', `/projects/${projectId}/budget`)
  }

  commitments(projectId: string): Promise<{ commitments: CommitmentView[] }> {
    return this.request('GET', `/projects/${projectId}/commitments`)
  }

  getCapture(captureId: string): Promise<CaptureView> {
    return this.request('GET', `/captures/${captureId}`)
  }

  interpret(captureId: string): Promise<ProposalView> {
    return this.request('POST', `/captures/${captureId}/interpret`)
  }

  proposals(projectId: string, status = 'pending'): Promise<{ proposals: ProposalView[] }> {
    return this.request('GET', `/projects/${projectId}/proposals?status=${status}`)
  }

  acceptProposal(
    proposalId: string,
    edits: { title?: string; body?: Record<string, unknown> } = {},
  ): Promise<{ proposal: ProposalView; record: RecordView }> {
    return this.request('POST', `/proposals/${proposalId}/accept`, edits)
  }

  contracts(projectId: string): Promise<{ documents: ContractDocumentView[] }> {
    return this.request('GET', `/projects/${projectId}/contracts`)
  }

  clauses(documentId: string): Promise<{ clauses: ClauseView[] }> {
    return this.request('GET', `/contracts/${documentId}/clauses`)
  }

  obligations(documentId: string, status?: string): Promise<{ obligations: ObligationView[] }> {
    const suffix = status ? `?status=${status}` : ''
    return this.request('GET', `/contracts/${documentId}/obligations${suffix}`)
  }

  profileContract(documentId: string): Promise<{
    clausesScreened: number
    candidates: number
    proposed: number
    discarded: { reason: string; quote: string }[]
    screenModel: string
    extractModel: string | null
  }> {
    return this.request('POST', `/contracts/${documentId}/profile`)
  }

  acceptObligation(obligationId: string): Promise<{ ok: true }> {
    return this.request('POST', `/obligations/${obligationId}/accept`)
  }

  rejectObligation(obligationId: string): Promise<{ ok: true }> {
    return this.request('POST', `/obligations/${obligationId}/reject`)
  }

  photos(
    projectId: string,
    filter: { from?: string; to?: string; albumId?: string; recordId?: string; undated?: boolean } = {},
  ): Promise<{ photos: PhotoView[] }> {
    const query = new URLSearchParams()
    if (filter.from) query.set('from', filter.from)
    if (filter.to) query.set('to', filter.to)
    if (filter.albumId) query.set('albumId', filter.albumId)
    if (filter.recordId) query.set('recordId', filter.recordId)
    if (filter.undated) query.set('undated', 'true')
    const suffix = query.toString() ? `?${query}` : ''
    return this.request('GET', `/projects/${projectId}/photos${suffix}`)
  }

  /**
   * The image itself, fetched with the bearer token and handed to the browser
   * as an object URL. An <img src> pointing at the API would be
   * unauthenticated and would render as a broken image.
   */
  async photoObjectUrl(photoId: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}/photos/${photoId}/file`, {
      headers: { ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
    })
    if (!response.ok) throw new ApiError(response.status, 'photo_failed', 'That photograph could not be loaded')
    return URL.createObjectURL(await response.blob())
  }

  uploadPhoto(
    projectId: string,
    file: File,
    caption?: string,
  ): Promise<{ photo: PhotoView; duplicate: boolean }> {
    return fetch(`${this.baseUrl}/projects/${projectId}/photos`, {
      method: 'POST',
      headers: {
        'content-type': file.type || 'image/jpeg',
        'x-filename': file.name,
        ...(caption ? { 'x-caption': caption } : {}),
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: file,
    }).then(async (response) => {
      const parsed = (await response.json()) as { photo: PhotoView; duplicate: boolean; error?: string; message?: string }
      if (!response.ok) {
        throw new ApiError(response.status, parsed.error ?? 'upload_failed', parsed.message ?? 'Upload failed')
      }
      return parsed
    })
  }

  createAlbum(projectId: string, name: string, description?: string): Promise<{ id: string }> {
    return this.request('POST', `/projects/${projectId}/photo-albums`, { name, description })
  }

  lookahead(projectId: string, weeks = 3): Promise<{ activities: ActivityView[] }> {
    return this.request('GET', `/projects/${projectId}/lookahead?weeks=${weeks}`)
  }

  exposure(projectId: string): Promise<{ exposure: ExposureView[] }> {
    return this.request('GET', `/projects/${projectId}/exposure`)
  }

  recordActivities(recordId: string): Promise<{ activities: (ActivityView & { kind: string })[] }> {
    return this.request('GET', `/records/${recordId}/activities`)
  }

  linkActivity(recordId: string, activityCode: string, kind = 'blocks'): Promise<{ ok: true }> {
    return this.request('POST', `/records/${recordId}/activities`, { activityCode, kind })
  }

  submittalRegister(projectId: string): Promise<{ requirements: RequirementView[] }> {
    return this.request('GET', `/projects/${projectId}/submittal-register`)
  }

  acceptRequirement(requirementId: string): Promise<{ submittalId: string }> {
    return this.request('POST', `/submittal-requirements/${requirementId}/accept`)
  }

  rejectRequirement(requirementId: string): Promise<{ ok: true }> {
    return this.request('POST', `/submittal-requirements/${requirementId}/reject`)
  }

  sheets(projectId: string, discipline?: string): Promise<{ sheets: SheetView[] }> {
    const suffix = discipline ? `?discipline=${encodeURIComponent(discipline)}` : ''
    return this.request('GET', `/projects/${projectId}/drawings${suffix}`)
  }

  pins(drawingId: string): Promise<{ pins: PinView[] }> {
    return this.request('GET', `/drawings/${drawingId}/pins`)
  }

  placePin(revisionId: string, recordId: string, x: number, y: number, page = 1): Promise<unknown> {
    return this.request('POST', `/drawing-revisions/${revisionId}/pins`, { recordId, x, y, page })
  }

  /** The sheet's own bytes, authenticated, for the renderer to consume. */
  async sheetBytes(revisionId: string): Promise<ArrayBuffer> {
    const response = await fetch(`${this.baseUrl}/drawing-revisions/${revisionId}/file`, {
      headers: { ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
    })
    if (!response.ok) throw new ApiError(response.status, 'sheet_failed', 'That sheet could not be loaded')
    return response.arrayBuffer()
  }

  escalations(projectId: string): Promise<{ escalations: EscalationView[] }> {
    return this.request('GET', `/projects/${projectId}/escalations`)
  }

  sweepEscalations(projectId: string): Promise<{ drafted: number; skipped: number }> {
    return this.request('POST', `/projects/${projectId}/escalations/sweep`)
  }

  approveEscalation(escalationId: string): Promise<{ ok: true }> {
    return this.request('POST', `/escalations/${escalationId}/approve`)
  }

  dismissEscalation(escalationId: string): Promise<{ ok: true }> {
    return this.request('POST', `/escalations/${escalationId}/dismiss`)
  }

  clocks(projectId: string): Promise<{ clocks: ClockView[] }> {
    return this.request('GET', `/projects/${projectId}/clocks`)
  }

  statutoryClocks(projectId: string): Promise<{ clocks: StatutoryClockView[] }> {
    return this.request('GET', `/projects/${projectId}/statutory-clocks`)
  }

  setStatutoryFacts(
    projectId: string,
    facts: {
      jurisdiction: string
      projectType?: string
      claimantRole: string
      firstFurnishing?: string
      lastFurnishing?: string
      completionDate?: string
      contractExecuted?: string
    },
  ): Promise<{ started: number; skipped: { citation: string; reason: string }[]; unverified: { citation: string; summary: string }[] }> {
    return this.request('PUT', `/projects/${projectId}/statutory-facts`, facts)
  }

  draftNotice(clockId: string): Promise<{ recordId: string; subject: string; body: string; missing: string[] }> {
    return this.request('POST', `/clocks/${clockId}/draft-notice`)
  }

  claimFile(clockId: string): Promise<Record<string, unknown>> {
    return this.request('GET', `/clocks/${clockId}/claim-file`)
  }

  /**
   * The file as a document, fetched rather than linked.
   *
   * The token lives in memory, not in a cookie, so pointing an anchor at the
   * download URL would produce a 401 and a blank tab. The bytes come back
   * through the same authenticated request as everything else and the caller
   * hands them to the browser.
   */
  async claimFileMarkdown(clockId: string): Promise<{ text: string; filename: string }> {
    const response = await fetch(`${this.baseUrl}/clocks/${clockId}/claim-file.md`, {
      headers: { ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
    })
    if (!response.ok) {
      throw new ApiError(response.status, 'claim_file_failed', 'The claim file could not be assembled')
    }
    const disposition = response.headers.get('content-disposition') ?? ''
    const named = /filename="([^"]+)"/.exec(disposition)
    return { text: await response.text(), filename: named?.[1] ?? `claim-${clockId}.md` }
  }

  sweepClocks(projectId: string): Promise<unknown> {
    return this.request('POST', `/projects/${projectId}/clocks/sweep`)
  }

  rejectProposal(proposalId: string, note?: string): Promise<ProposalView> {
    return this.request('POST', `/proposals/${proposalId}/reject`, { note })
  }
}
