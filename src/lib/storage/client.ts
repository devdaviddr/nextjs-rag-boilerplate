import 'server-only'

import {
  DeleteObjectCommand,
  GetObjectCommand,
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
