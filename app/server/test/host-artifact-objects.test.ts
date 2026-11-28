import { createHash, randomUUID } from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';
import { afterEach, expect, it, vi } from 'vitest';
import { readMediaObject } from '../src/hosts/artifact-objects.js';
import { config } from '../src/config.js';

vi.mock('../src/config.js', () => ({ config: {
  b2KeyId: 'example', b2AppKey: 'example', b2Bucket: 'sample', b2S3Endpoint: 'https://objects.example',
} }));
afterEach(() => vi.restoreAllMocks());

it('imports only from the configured private object prefix and checks size and digest', async () => {
  const data = Buffer.from('some text');
  const identity = { id: randomUUID(), bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
  const send = vi.spyOn(S3Client.prototype, 'send').mockImplementation(async () => ({
    Body: { transformToWebStream: () => new Response(data).body },
  }));
  await expect(readMediaObject(identity)).resolves.toEqual(data);
  expect(send.mock.calls[0]?.[0]).toMatchObject({ input: { Key: 'host-pilot/inputs/' + identity.id, Bucket: config.b2Bucket } });
  await expect(readMediaObject({ ...identity, bytes: 1 })).rejects.toMatchObject({ status: 422 });
  await expect(readMediaObject({ ...identity, sha256: '0'.repeat(64) })).rejects.toMatchObject({ status: 422 });
});
