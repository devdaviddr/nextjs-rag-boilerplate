import 'server-only'

import { createReadStream } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'

import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'

import { env } from '@/lib/env'

/**
 * Object storage, behind one set of functions with two backends.
 *
 * - **S3-compatible**, when `S3_ENDPOINT` is set: the self-hosted MinIO
 *   service by default, but any S3-compatible endpoint (R2, real S3) works
 *   unmodified. `forcePathStyle` is required for MinIO.
 * - **Local disk** otherwise (#137): objects are files under `STORAGE_DIR`,
 *   so document chat runs with no storage service at all. Fine for one
 *   instance; several instances need a shared store, which is what S3 is.
 */
export function storageBackend(): 's3' | 'disk' {
  return env.S3_ENDPOINT ? 's3' : 'disk'
}

let s3: S3Client | undefined
function client(): S3Client {
  s3 ??= new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID!,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
    },
  })
  return s3
}

function diskRoot(): string {
  return path.resolve(env.STORAGE_DIR ?? './data/storage')
}

/**
 * A key's file on disk. Keys are built by the app (`buildBucketKey`), but a
 * key is still never allowed to name a path outside the storage folder.
 */
function diskPath(key: string): string {
  const root = diskRoot()
  const file = path.resolve(root, key)
  if (!file.startsWith(root + path.sep)) {
    throw new Error(`Refusing a storage key outside the storage folder: ${key}`)
  }
  return file
}

export async function putObject(
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  if (storageBackend() === 'disk') {
    const file = diskPath(key)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, body)
    return
  }
  await client().send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  )
}

/** Returns the object body as a web-standard ReadableStream for streaming responses. */
export async function getObjectStream(key: string): Promise<{
  body: ReadableStream
  contentType?: string
  contentLength?: number
}> {
  if (storageBackend() === 'disk') {
    const file = diskPath(key)
    const { size } = await stat(file)
    return {
      body: Readable.toWeb(createReadStream(file)) as ReadableStream,
      contentLength: size,
    }
  }
  const result = await client().send(
    new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }),
  )
  if (!result.Body) {
    throw new Error(`Object body missing for key: ${key}`)
  }
  return {
    body: result.Body.transformToWebStream(),
    contentType: result.ContentType,
    contentLength: result.ContentLength,
  }
}

/**
 * Returns the whole object in memory. Used by PDF ingestion (spec 0025),
 * which needs random access across the file and so cannot stream — the
 * upload size cap is what keeps this bounded.
 */
export async function getObjectBuffer(key: string): Promise<Buffer> {
  if (storageBackend() === 'disk') return readFile(diskPath(key))
  const result = await client().send(
    new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }),
  )
  if (!result.Body) {
    throw new Error(`Object body missing for key: ${key}`)
  }
  return Buffer.from(await result.Body.transformToByteArray())
}

export async function deleteObject(key: string): Promise<void> {
  if (storageBackend() === 'disk') {
    // Like S3, deleting a key that does not exist is not an error.
    await rm(diskPath(key), { force: true })
    return
  }
  await client().send(
    new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }),
  )
}

/**
 * Every key under `prefix`, following the listing's pagination.
 *
 * `prefix` MUST end in `/`. A bare prefix is a substring match on S3, so
 * `listObjectKeys('alice')` would also return Bob-if-he-were-called-`alice2`'s
 * objects; requiring the separator makes the prefix a folder boundary instead.
 * This is enforced rather than documented because the only caller today feeds
 * the result to a delete.
 */
export async function listObjectKeys(prefix: string): Promise<string[]> {
  if (!prefix.endsWith('/') || prefix === '/') {
    throw new Error(
      `Refusing to list on an unbounded prefix: ${JSON.stringify(prefix)}. ` +
        'A prefix must name a folder and end in "/".',
    )
  }

  if (storageBackend() === 'disk') return listDiskKeys(prefix)

  const keys: string[] = []
  let continuationToken: string | undefined

  do {
    const page = await client().send(
      new ListObjectsV2Command({
        Bucket: env.S3_BUCKET,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    )
    for (const object of page.Contents ?? []) {
      const key = object.Key
      // S3 promises every key it returns starts with the prefix we asked for.
      // Checking anyway costs nothing and means a mis-implemented endpoint
      // cannot widen a delete beyond the caller's intent.
      if (typeof key === 'string' && key.startsWith(prefix)) keys.push(key)
    }
    continuationToken = page.IsTruncated
      ? page.NextContinuationToken
      : undefined
  } while (continuationToken)

  return keys
}

/** Every key under a folder on disk, as `listObjectKeys` returns them. */
async function listDiskKeys(prefix: string): Promise<string[]> {
  const keys: string[] = []
  const walk = async (folder: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(folder, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const full = path.join(folder, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) {
        keys.push(path.relative(diskRoot(), full).split(path.sep).join('/'))
      }
    }
  }
  await walk(diskPath(prefix))
  return keys
}

/**
 * Deletes every object under `prefix` and returns how many went.
 *
 * One `DeleteObject` per key rather than a batched `DeleteObjects`: the batch
 * API sends a content checksum that not every S3-compatible endpoint accepts,
 * and the only caller clears a handful of evaluation fixtures. Correct and
 * portable beats one fewer round trip here.
 */
export async function deleteObjectsUnderPrefix(
  prefix: string,
): Promise<number> {
  const keys = await listObjectKeys(prefix)
  for (const key of keys) await deleteObject(key)
  return keys.length
}
