import type {
  TranscriptionProvider,
  TranscriptionRequest,
  TranscriptionResult,
} from '../../src/capture/transcription.js'
import type { BlobStore, StoredBlob } from '../../src/storage/index.js'

/**
 * A scripted reader, and a store to read from.
 *
 * Same bargain as the scripted interpreter: the whole path runs with no
 * network and no key, and every request is recorded so a test can assert on
 * what was actually handed to the model — which for transcription is the one
 * thing worth checking, because handing the typed note back as a transcript
 * would look like confirmation and be nothing.
 */
export class ScriptedTranscriber implements TranscriptionProvider {
  readonly name = 'scripted-transcriber'
  readonly requests: TranscriptionRequest[] = []
  private readonly queue: (string | Error)[] = []

  constructor(private readonly readable: (contentType: string) => boolean = () => true) {}

  push(text: string | Error): this {
    this.queue.push(text)
    return this
  }

  handles(contentType: string): boolean {
    return this.readable(contentType)
  }

  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    this.requests.push(request)
    const next = this.queue.shift()
    if (next === undefined) throw new Error('ScriptedTranscriber ran out of queued transcripts')
    if (next instanceof Error) throw next
    return {
      text: next,
      model: 'claude-opus-5',
      usage: { inputTokens: 2_400, outputTokens: 320, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }
  }
}

/** Blobs in a Map. Enough to prove the bytes travelled. */
export class MemoryBlobStore implements BlobStore {
  readonly name = 'memory'
  private readonly blobs = new Map<string, Buffer>()
  private next = 0

  async put(input: { tenantId: string; bytes: Buffer; contentType: string }): Promise<StoredBlob> {
    const key = `${input.tenantId}/2026-01/${String(this.next++).padStart(8, '0')}`
    this.blobs.set(key, input.bytes)
    return { key, byteSize: input.bytes.byteLength, contentType: input.contentType }
  }

  async get(key: string): Promise<Buffer> {
    const bytes = this.blobs.get(key)
    if (!bytes) throw new Error(`no blob at ${key}`)
    return bytes
  }

  async delete(key: string): Promise<void> {
    this.blobs.delete(key)
  }
}
