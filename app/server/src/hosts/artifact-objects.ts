import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { type ArtifactRef } from '@secondbrain/contracts/hosts';
import { config } from '../config.js';
import { regionOf } from '../uploads/store.js';
import { verifyArtifact } from './artifacts.js';
import { HostServiceError } from './service.js';

// Accept an opaque object ID in a dedicated private prefix. The owner controls the bucket and endpoint.
export async function readMediaObject(input: ArtifactRef): Promise<Buffer> {
  const { b2KeyId, b2AppKey, b2Bucket, b2S3Endpoint } = config;
  if (!b2KeyId || !b2AppKey || !b2Bucket || !b2S3Endpoint) throw new HostServiceError(503, 'Private media store unavailable');
  const client = new S3Client({ endpoint: b2S3Endpoint, region: regionOf(b2S3Endpoint), forcePathStyle: true,
    credentials: { accessKeyId: b2KeyId, secretAccessKey: b2AppKey }, responseChecksumValidation: 'WHEN_REQUIRED' });
  try {
    const object = await client.send(new GetObjectCommand({ Bucket: b2Bucket, Key: 'host-pilot/inputs/' + input.id }),
      { abortSignal: AbortSignal.timeout(30_000) });
    if (!object.Body) throw new HostServiceError(404, 'Private media object unavailable');
    const stream = object.Body.transformToWebStream();
    const reader = stream.getReader();
    try {
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > input.bytes) throw new HostServiceError(422, 'Private media object size mismatch');
        chunks.push(value);
      }
      if (bytes !== input.bytes) throw new HostServiceError(422, 'Private media object size mismatch');
      const data = Buffer.concat(chunks, bytes);
      verifyArtifact(data, input.sha256);
      return data;
    } finally { await reader.cancel().catch(() => {}); }
  } catch (error) {
    if (error instanceof HostServiceError) throw error;
    throw new HostServiceError(502, 'Private media object fetch failed');
  } finally { client.destroy(); }
}
