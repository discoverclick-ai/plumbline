/**
 * Errors the kernel raises. Each one carries an HTTP status so the API layer
 * maps them mechanically instead of guessing, and a stable `code` so clients
 * (and, later, agents) can branch on the failure rather than parse prose.
 */
export class KernelError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = new.target.name
  }
}

export class NotFoundError extends KernelError {
  constructor(what: string, id?: string) {
    super('not_found', id ? `${what} ${id} not found` : `${what} not found`, 404, { what, id })
  }
}

export class ValidationError extends KernelError {
  constructor(message: string, readonly issues: FieldIssue[] = []) {
    super('validation_failed', message, 422, { issues })
  }
}

export interface FieldIssue {
  field: string
  message: string
}

/**
 * The actor may not do this. Deliberately does not say whether the record
 * exists when the caller cannot see the project at all — that is the
 * NotFoundError's job, and conflating them leaks the portfolio.
 */
export class PermissionDeniedError extends KernelError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super('permission_denied', message, 403, detail)
  }
}

/** The transition is not legal from the record's current state. */
export class InvalidTransitionError extends KernelError {
  constructor(transition: string, from: string) {
    super('invalid_transition', `Cannot ${transition} from ${from}`, 409, { transition, from })
  }
}

/** Someone else wrote first. The caller must re-read and retry. */
export class VersionConflictError extends KernelError {
  constructor(expected: number, actual: number) {
    super('version_conflict', `Record changed since you loaded it (expected v${expected}, found v${actual})`, 409, {
      expected,
      actual,
    })
  }
}

export class AuthenticationError extends KernelError {
  constructor(message = 'Authentication required') {
    super('unauthenticated', message, 401)
  }
}
