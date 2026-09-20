import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { CaptureService, readableText } from '../../src/capture/service.js'
import { createPool, withTenant } from '../../src/db.js'
import { KernelError, ValidationError } from '../../src/errors.js'
import type { Actor } from '../../src/kernel.js'
import {
  addProjectMember,
  createProject,
  createUser,
  findTemplateByName,
  provisionTenant,
} from '../../src/provisioning.js'
import { ScriptedProvider } from '../support/scripted-provider.js'
import { MemoryBlobStore, ScriptedTranscriber } from '../support/scripted-transcriber.js'

/**
 * Bytes to words, in front of the interpreter.
 *
 * A voice memo and a photograph of a handwritten field ticket are the two
 * things a phone on a jobsite is actually good at producing, and both used to
 * reach the capture inbox and stop there: "This capture has no text to
 * interpret yet".
 *
 * The assertions worth their place are about what the pipeline refuses. A
 * reader that cannot hear must say so rather than return a fluent paragraph,
 * because that paragraph would become the text of a capture, then the body of
 * a record, then evidence in a claim, and nothing downstream would ever mark
 * it as invented.
 */

let pool: Pool
let provider: ScriptedProvider
let transcriber: ScriptedTranscriber
let blobs: MemoryBlobStore
let capture: CaptureService
let tenantId: string
let projectId: string
let pm: Actor

beforeAll(async () => {
  pool = createPool({ connectionString: inject('databaseUrl') })
  provider = new ScriptedProvider()
  blobs = new MemoryBlobStore()
  // Reads images, cannot hear. Which is the truth about a vision model.
  transcriber = new ScriptedTranscriber((type) => type.startsWith('image/') || type === 'application/pdf')
  capture = new CaptureService(pool, provider, { transcriber, blobs })

  const tenant = await provisionTenant(pool, {
    tenantName: 'Transcript Builders',
    organizationKind: 'general_contractor',
    admin: { email: 'admin@transcript.test', name: 'Tess Admin', password: 'a-long-enough-password' },
  })
  tenantId = tenant.tenantId

  await withTenant(pool, tenantId, async (tx) => {
    const pmId = await createUser(tx, tenantId, {
      organizationId: tenant.organizationId,
      email: 'pm@transcript.test',
      name: 'Pia Marek',
      companyPermissionTemplateId: await findTemplateByName(tx, tenantId, 'company', 'Employee'),
    })
    projectId = await createProject(tx, tenantId, { number: '26-090', name: 'Hillcrest Medical' })
    await addProjectMember(tx, tenantId, { projectId, userId: pmId, permissionTemplateName: 'Project Manager' })
    pm = { tenantId, userId: pmId }
  })
})

afterAll(async () => {
  await pool.end()
})

async function photoCapture(text?: string): Promise<string> {
  const stored = await blobs.put({
    tenantId,
    bytes: Buffer.from('not really a jpeg'),
    contentType: 'image/jpeg',
  })
  const row = await capture.record(pm, {
    projectId,
    kind: 'document',
    storageKey: stored.key,
    contentType: stored.contentType,
    byteSize: stored.byteSize,
    ...(text ? { text } : {}),
  })
  return row.id
}

describe('reading a file nobody typed', () => {
  it('writes down what was read and what read it', async () => {
    const id = await photoCapture()
    transcriber.push('T&M TICKET 114\nSaturday overtime, 6 men, 4 hours\nSigned: R. Alvarez')

    const after = await capture.transcribe(pm, id)
    expect(after.transcript).toMatch(/T&M TICKET 114/)
    // Frozen. A transcript read back in a claim two years from now has to say
    // what heard it.
    expect(after.transcriptModel).toBe('claude-opus-5')
    expect(after.transcribedAt).not.toBeNull()
    // And NOT in `text`. A machine's reading and a person's words are not the
    // same kind of fact, and merged into one column the distinction is gone
    // by the time anybody reviews the proposal.
    expect(after.text).toBeNull()
  })

  it('does not read the same file twice', async () => {
    const id = await photoCapture()
    transcriber.push('First reading.')
    await capture.transcribe(pm, id)

    const before = transcriber.requests.length
    const again = await capture.transcribe(pm, id)
    // Costs money, and would overwrite a transcript somebody may already have
    // read and corrected against. Re-reading is a deliberate act.
    expect(transcriber.requests.length).toBe(before)
    expect(again.transcript).toBe('First reading.')
  })

  it('reads it again when told to', async () => {
    const id = await photoCapture()
    transcriber.push('Blurry, mostly illegible.')
    await capture.transcribe(pm, id)
    transcriber.push('WORK ORDER 22 — slab pour, bay 4')

    const forced = await capture.transcribe(pm, id, { force: true })
    expect(forced.transcript).toBe('WORK ORDER 22 — slab pour, bay 4')
  })

  it('passes the typed note as context, never as something to repeat back', async () => {
    const id = await photoCapture('Ticket from Alvarez, bay 4')
    transcriber.push('T&M TICKET 114')
    await capture.transcribe(pm, id)

    const request = transcriber.requests.at(-1)
    // A field transcript is mostly proper nouns, and the typed note is
    // usually where those are spelled correctly.
    expect(request?.hint).toBe('Ticket from Alvarez, bay 4')
    expect(request?.contentType).toBe('image/jpeg')
    expect(request?.bytes.toString()).toBe('not really a jpeg')
  })

  it('refuses media it cannot actually read, by name', async () => {
    const stored = await blobs.put({ tenantId, bytes: Buffer.from('RIFF'), contentType: 'audio/m4a' })
    const voice = await capture.record(pm, {
      projectId,
      kind: 'voice',
      storageKey: stored.key,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
    })

    // The important refusal. A vision model asked to transcribe a voice memo
    // has nothing to work from, and the failure mode is not an error: it is a
    // fluent, plausible paragraph about a jobsite. The memo sits in the inbox
    // with its recording intact instead, which is recoverable.
    await expect(capture.transcribe(pm, voice.id)).rejects.toMatchObject({
      code: 'transcription_unsupported',
    })
    const still = await capture.getCapture(pm, voice.id)
    expect(still.transcript).toBeNull()
  })

  it('refuses a capture with no file on it', async () => {
    const typed = await capture.record(pm, { projectId, kind: 'text', text: 'Nothing attached.' })
    await expect(capture.transcribe(pm, typed.id)).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('on the way into interpretation', () => {
  it('reads the file first, so the inbox needs no second button', async () => {
    const id = await photoCapture()
    transcriber.push('DELAY NOTICE — no crane access, 2 days lost, grid C-4')
    provider.push({
      typeKey: 'observation',
      title: 'No crane access at grid C-4',
      fields: [{ key: 'description', value: 'Two days lost to crane access at grid C-4.' }],
      participants: [],
      confidence: 0.8,
      rationale: 'Reads as a delay observation.',
    })

    const proposal = await capture.interpret(pm, id)
    expect(proposal.title).toBe('No crane access at grid C-4')
    // The transcript, not the empty text field, is what the model was given.
    expect(provider.requests.at(-1)?.userContent).toMatch(/DELAY NOTICE/)
  })

  it('still says plainly when there is nothing to read at all', async () => {
    const stored = await blobs.put({ tenantId, bytes: Buffer.from('RIFF'), contentType: 'audio/m4a' })
    const voice = await capture.record(pm, {
      projectId,
      kind: 'voice',
      storageKey: stored.key,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
    })
    // Interpretation swallows the transcription refusal, because a capture
    // with a typed note must still interpret when nothing can read its file.
    // What it must not do is invent a reason.
    await expect(capture.interpret(pm, voice.id)).rejects.toBeInstanceOf(ValidationError)
  })

  it('serves a deployment with no reader configured at all', async () => {
    // Every route stays up without a transcription provider. A capture with
    // text interprets exactly as it always did.
    const bare = new CaptureService(pool, provider)
    const typed = await capture.record(pm, { projectId, kind: 'text', text: 'Punch list walked on level 3.' })
    provider.push({
      typeKey: 'observation',
      title: 'Punch list walked on level 3',
      fields: [{ key: 'description', value: 'Punch list walked on level 3.' }],
      participants: [],
      confidence: 0.7,
      rationale: 'A plain observation.',
    })
    const proposal = await bare.interpret(pm, typed.id)
    expect(proposal.title).toBe('Punch list walked on level 3')
  })
})

describe('what the interpreter is handed', () => {
  it('labels the transcript so the typed words outrank the heard ones', () => {
    // A name typed by the person who was there beats the same name as a
    // microphone heard it, and a model given one undifferentiated blob has no
    // way to know which is which.
    const both = readableText({ text: 'Alvarez, bay 4', transcript: 'Alveraz, bay four' })
    expect(both).toMatch(/^Alvarez, bay 4/)
    expect(both).toMatch(/\[Transcribed from the attached file\]/)

    expect(readableText({ text: 'Typed only', transcript: null })).toBe('Typed only')
    expect(readableText({ text: null, transcript: null })).toBe('')
  })
})
