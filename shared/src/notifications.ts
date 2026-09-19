import { randomBytes } from 'node:crypto'
import { withTenant, type Db } from './db.js'
import { NotFoundError, ValidationError } from './errors.js'
import type { Actor } from './kernel.js'
import * as repo from './repositories/records.js'

/**
 * Telling people, and letting them reply.
 *
 * Ball in court is worthless if nobody is told they are holding it. Until now
 * the product assumed somebody opens the app, which is the assumption that
 * kills field adoption: a superintendent does not open your app. Your app
 * reaches them or it does not exist.
 *
 * Notifications are rows before they are emails, generated from the event log
 * by a worker rather than inline with the write. Two reasons, and both have
 * bitten every product that did it the other way. A transition that fails
 * because a mail server is slow is a transition that should have succeeded.
 * And a notification about something the recipient already dealt with in the
 * app should not arrive an hour later regardless.
 */

export interface OutboundMessage {
  to: string
  replyTo: string | null
  subject: string
  body: string
}

/** The seam. One implementation per transport, nothing above here knows which. */
export interface MailSender {
  readonly name: string
  send(message: OutboundMessage): Promise<void>
}

/** Keeps what it was handed, for tests and for a deployment with mail turned off. */
export class RecordingMailSender implements MailSender {
  readonly name = 'recording'
  readonly sent: OutboundMessage[] = []
  async send(message: OutboundMessage): Promise<void> {
    this.sent.push(message)
  }
}

export interface NotificationRow {
  id: string
  recipientId: string
  recordId: string | null
  reason: string
  subject: string
  body: string
  state: 'pending' | 'sent' | 'suppressed' | 'failed'
}

/**
 * Which events are worth an interruption.
 *
 * Deliberately short. Everything the kernel emits lands in the event log and
 * is queryable; only these reach somebody's phone. A product that notifies on
 * every event teaches people to ignore it, and then the one that mattered
 * arrives in a muted thread.
 */
const NOTIFIABLE: ReadonlySet<string> = new Set([
  'record.created',
  'record.transitioned',
  'record.commented',
])

export interface NotificationOptions {
  /** The domain replies come back to, e.g. "reply.plumbline.app". */
  replyDomain?: string
}

export class NotificationService {
  constructor(
    private readonly db: Db,
    private readonly mail: MailSender,
    private readonly options: NotificationOptions = {},
  ) {}

  /**
   * Read the event log forward and queue what is worth saying.
   *
   * Runs on an operator connection across every tenant, like any other
   * worker. Idempotent on (source_event, recipient): replaying the log, which
   * happens whenever the cursor is rewound to fix a bug, must not send the
   * same thing twice.
   */
  async generate(limit = 500): Promise<number> {
    const { rows: cursorRows } = await this.db.query<{ last_event_id: string }>(
      `SELECT last_event_id FROM notification_cursor WHERE name = 'notifications'`,
    )
    const cursor = Number(cursorRows[0]?.last_event_id ?? 0)

    const { rows: events } = await this.db.query<{
      id: string
      tenant_id: string
      project_id: string
      record_id: string
      type_key: string
      event: string
      payload: Record<string, unknown>
      actor_user_id: string | null
    }>(
      `SELECT id, tenant_id, project_id, record_id, type_key, event, payload, actor_user_id
         FROM record_events
        WHERE id > $1
        ORDER BY id
        LIMIT $2`,
      [cursor, limit],
    )

    let queued = 0
    let highest = cursor

    for (const event of events) {
      highest = Number(event.id)
      if (!NOTIFIABLE.has(event.event)) continue

      const recipients = await this.recipientsFor(event)
      for (const recipient of recipients) {
        const { subject, body } = await this.compose(event, recipient)
        const { rowCount } = await this.db.query(
          `INSERT INTO notifications
             (tenant_id, project_id, record_id, recipient_id, reason, subject, body, source_event)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (source_event, recipient_id) WHERE source_event IS NOT NULL DO NOTHING`,
          [
            event.tenant_id,
            event.project_id,
            event.record_id,
            recipient,
            event.event,
            subject,
            body,
            Number(event.id),
          ],
        )
        queued += rowCount ?? 0
      }
    }

    if (highest > cursor) {
      await this.db.query(
        `UPDATE notification_cursor SET last_event_id = $1, updated_at = now() WHERE name = 'notifications'`,
        [highest],
      )
    }
    return queued
  }

  /**
   * Who hears about this.
   *
   * The holder of the ball, always, because that is the one message this
   * product exists to deliver. Plus anybody on the record who asked for
   * everything. Never the person who caused it: a notification about your own
   * action is how people learn to filter you into a folder.
   */
  private async recipientsFor(event: {
    tenant_id: string
    project_id: string
    record_id: string
    actor_user_id: string | null
  }): Promise<string[]> {
    const { rows } = await this.db.query<{ user_id: string; scope: string; is_holder: boolean }>(
      `SELECT p.user_id,
              COALESCE(np.scope, npp.scope, 'ball_in_court') AS scope,
              (r.ball_in_court_user_id = p.user_id) AS is_holder
         FROM record_participants p
         JOIN records r ON r.id = p.record_id AND r.tenant_id = p.tenant_id
         LEFT JOIN notification_preferences np
                ON np.tenant_id = p.tenant_id AND np.user_id = p.user_id AND np.project_id = r.project_id
         LEFT JOIN notification_preferences npp
                ON npp.tenant_id = p.tenant_id AND npp.user_id = p.user_id AND npp.project_id IS NULL
        WHERE p.tenant_id = $1 AND p.record_id = $2`,
      [event.tenant_id, event.record_id],
    )

    const wanted = new Set<string>()
    for (const row of rows) {
      if (row.scope === 'none') continue
      if (row.user_id === event.actor_user_id) continue
      if (row.scope === 'all' || row.is_holder) wanted.add(row.user_id)
    }
    return [...wanted]
  }

  private async compose(
    event: { tenant_id: string; record_id: string; event: string; payload: Record<string, unknown> },
    recipientId: string,
  ): Promise<{ subject: string; body: string }> {
    const { rows } = await this.db.query<{ designation: string; title: string; status: string; project: string }>(
      `SELECT r.designation, r.title, r.status, p.name AS project
         FROM records r JOIN projects p ON p.id = r.project_id AND p.tenant_id = r.tenant_id
        WHERE r.tenant_id = $1 AND r.id = $2`,
      [event.tenant_id, event.record_id],
    )
    const record = rows[0]
    const designation = record?.designation ?? 'A record'
    const title = record?.title ?? ''

    // The subject line is the product. Somebody reads it on a lock screen with
    // wet gloves on, and it has to say what they owe without being opened.
    const subject =
      event.event === 'record.commented'
        ? `${designation}: new comment`
        : `${designation} is in your court: ${title}`

    const action = typeof event.payload['expectedAction'] === 'string' ? event.payload['expectedAction'] : null
    const body = [
      `${designation} — ${title}`,
      record?.project ? `Project: ${record.project}` : null,
      action ? `What is needed: ${action}` : null,
      '',
      'Reply to this email and your reply becomes a comment on the record.',
    ]
      .filter((line) => line !== null)
      .join('\n')

    void recipientId
    return { subject, body }
  }

  /** Hand the queued messages to the transport. */
  async deliver(limit = 100): Promise<{ sent: number; failed: number }> {
    const { rows } = await this.db.query<{
      id: string
      tenant_id: string
      record_id: string | null
      recipient_id: string
      subject: string
      body: string
      email: string
    }>(
      `SELECT n.id, n.tenant_id, n.record_id, n.recipient_id, n.subject, n.body, u.email
         FROM notifications n
         JOIN users u ON u.id = n.recipient_id AND u.tenant_id = n.tenant_id
        WHERE n.state = 'pending'
        ORDER BY n.created_at
        LIMIT $1`,
      [limit],
    )

    let sent = 0
    let failed = 0
    for (const row of rows) {
      try {
        const replyTo = row.record_id
          ? await this.replyAddress(row.tenant_id, row.record_id, row.recipient_id)
          : null
        await this.mail.send({ to: row.email, replyTo, subject: row.subject, body: row.body })
        await this.db.query(`UPDATE notifications SET state = 'sent', sent_at = now() WHERE id = $1`, [row.id])
        sent += 1
      } catch (err) {
        await this.db.query(`UPDATE notifications SET state = 'failed', error = $2 WHERE id = $1`, [
          row.id,
          (err as Error).message.slice(0, 500),
        ])
        failed += 1
      }
    }
    return { sent, failed }
  }

  /**
   * The address this person replies to for this record.
   *
   * The token is random rather than derived. An address you can guess by
   * counting is an address anybody can post a comment to, and these arrive
   * with no session to check. One per record per person, so a forwarded email
   * cannot be used to post as somebody else.
   */
  async replyAddress(tenantId: string, recordId: string, userId: string): Promise<string | null> {
    if (!this.options.replyDomain) return null
    const { rows } = await this.db.query<{ token: string }>(
      `INSERT INTO record_reply_addresses (token, tenant_id, record_id, user_id)
            VALUES ($1, $2, $3, $4)
       ON CONFLICT (record_id, user_id) DO UPDATE SET revoked_at = NULL
         RETURNING token`,
      [randomBytes(18).toString('base64url'), tenantId, recordId, userId],
    )
    const token = rows[0]?.token
    return token ? `reply+${token}@${this.options.replyDomain}` : null
  }

  /**
   * An inbound reply becomes a comment.
   *
   * The single cheapest adoption win available: the sub who will never log in
   * still replies to email, and right now that reply is invisible to the
   * project.
   */
  async receiveReply(address: string, body: string): Promise<{ recordId: string; commentId: string }> {
    const token = /reply\+([A-Za-z0-9_-]+)@/.exec(address)?.[1]
    if (!token) throw new ValidationError('Not a reply address', [{ field: 'to', message: 'Unrecognised address' }])

    const { rows } = await this.db.query<{ tenant_id: string; record_id: string; user_id: string }>(
      `SELECT tenant_id, record_id, user_id FROM record_reply_addresses
        WHERE token = $1 AND revoked_at IS NULL`,
      [token],
    )
    const binding = rows[0]
    if (!binding) throw new NotFoundError('reply address', token)

    const text = stripQuotedReply(body)
    if (!text) {
      throw new ValidationError('That reply was empty', [{ field: 'body', message: 'No new text in the reply' }])
    }

    const actor: Actor = { tenantId: binding.tenant_id, userId: binding.user_id }
    return withTenant(this.db, actor.tenantId, async (tx) => {
      const comment = await repo.addComment(tx, {
        tenantId: actor.tenantId,
        recordId: binding.record_id,
        authorUserId: actor.userId,
        body: text,
      })
      return { recordId: binding.record_id, commentId: comment.id }
    })
  }
}

/**
 * Everything below the first quoted line is the thread coming back at us.
 *
 * Worth doing properly: a comment that includes the entire history of the
 * conversation every time is how a record becomes unreadable by its third
 * reply, and people stop opening it.
 */
export function stripQuotedReply(body: string): string {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  for (const line of lines) {
    if (/^>/.test(line)) break
    if (/^On .+ wrote:$/.test(line.trim())) break
    if (/^-{2,}\s*Original Message\s*-{2,}$/i.test(line.trim())) break
    if (/^_{10,}$/.test(line.trim())) break
    if (/^From:\s/.test(line) && out.length > 0) break
    out.push(line)
  }
  return out.join('\n').trim()
}
