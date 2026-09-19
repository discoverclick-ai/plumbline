import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { assertSafeKey, newStorageKey, type BlobStore, type StoredBlob } from './index.js'

/**
 * Bytes on a disk.
 *
 * The root check below is not ceremony. `assertSafeKey` already rejects
 * anything with a path segment in it, and this resolves the final path anyway
 * and refuses to touch it if it landed outside the root. Two independent
 * checks, because a path traversal here reads any file the process can.
 */
export class FilesystemBlobStore implements BlobStore {
  readonly name = 'filesystem'
  private readonly root: string

  constructor(root: string) {
    this.root = resolve(root)
  }

  private pathFor(key: string): string {
    assertSafeKey(key)
    const path = resolve(join(this.root, key))
    if (path !== this.root && !path.startsWith(this.root + sep)) {
      throw new Error('Refusing a storage path outside the store root')
    }
    return path
  }

  async put(input: { tenantId: string; bytes: Buffer; contentType: string }): Promise<StoredBlob> {
    const key = newStorageKey(input.tenantId)
    const path = this.pathFor(key)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, input.bytes)
    return { key, byteSize: input.bytes.byteLength, contentType: input.contentType }
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key))
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true })
  }
}

/**
 * Bytes in memory, for tests that should not touch a disk. Not exported as a
 * default anywhere: a deployment that accidentally ran on this would lose
 * every file on restart.
 */
export class InMemoryBlobStore implements BlobStore {
  readonly name = 'memory'
  private readonly blobs = new Map<string, Buffer>()

  async put(input: { tenantId: string; bytes: Buffer; contentType: string }): Promise<StoredBlob> {
    const key = newStorageKey(input.tenantId)
    this.blobs.set(key, input.bytes)
    return { key, byteSize: input.bytes.byteLength, contentType: input.contentType }
  }

  async get(key: string): Promise<Buffer> {
    assertSafeKey(key)
    const blob = this.blobs.get(key)
    if (!blob) throw new Error(`No blob at ${key}`)
    return blob
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key)
    this.blobs.delete(key)
  }
}
