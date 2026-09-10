import 'server-only'

import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'

import { env } from '@/lib/env'

/**
 * S3-compatible client — talks to the self-hosted MinIO service by default,
 * but works unmodified against any S3-compatible endpoint (R2, real S3, etc).
 * `forcePathStyle` is required for MinIO (virtual-hosted-style bucket URLs
 * don't resolve against it).
 */
const client = new S3Client({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  forcePathStyle: true,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  },
})

export async function putObject(
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  await client.send(
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
  const result = await client.send(
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
  const result = await client.send(
    new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }),
  )
  if (!result.Body) {
    throw new Error(`Object body missing for key: ${key}`)
  }
  return Buffer.from(await result.Body.transformToByteArray())
}

export async function deleteObject(key: string): Promise<void> {
  await client.send(
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

  const keys: string[] = []
  let continuationToken: string | undefined

  do {
    const page = await client.send(
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
