import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface PartInfo {
  partNumber: number;
  size: number;
  etag: string;
}

/** The bucket as the uploads module sees it. The real one is S3 on B2; tests swap in a fake. */
export interface ObjectStore {
  createMultipart(key: string, contentType?: string): Promise<string>;
  presignPart(key: string, uploadId: string, partNumber: number, expiresSec: number): Promise<string>;
  listParts(key: string, uploadId: string): Promise<PartInfo[]>;
  complete(key: string, uploadId: string, parts: PartInfo[]): Promise<void>;
  abort(key: string, uploadId: string): Promise<void>;
  head(key: string): Promise<{ size: number } | null>;
  remove(key: string): Promise<void>;
}

export interface S3Config {
  endpoint: string;
  keyId: string;
  appKey: string;
  bucket: string;
}

/** `https://s3.us-west-004.backblazeb2.com` -> `us-west-004`. */
export function regionOf(endpoint: string): string {
  const m = /^https?:\/\/s3\.([a-z0-9-]+)\./.exec(endpoint);
  return m?.[1] ?? 'us-east-1';
}

export function s3Store(cfg: S3Config): ObjectStore {
  const client = new S3Client({
    endpoint: cfg.endpoint,
    region: regionOf(cfg.endpoint),
    credentials: { accessKeyId: cfg.keyId, secretAccessKey: cfg.appKey },
    forcePathStyle: true,
    // B2 rejects the checksum headers SDK v3 adds by default, and a browser can't send them on a presigned PUT.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  const Bucket = cfg.bucket;

  return {
    async createMultipart(key, contentType) {
      const out = await client.send(
        new CreateMultipartUploadCommand({ Bucket, Key: key, ...(contentType ? { ContentType: contentType } : {}) }),
      );
      if (!out.UploadId) throw new Error('B2 returned no upload id');
      return out.UploadId;
    },
    presignPart(key, uploadId, partNumber, expiresSec) {
      return getSignedUrl(client, new UploadPartCommand({ Bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }), {
        expiresIn: expiresSec,
      });
    },
    async listParts(key, uploadId) {
      const parts: PartInfo[] = [];
      let marker: string | undefined;
      for (;;) {
        const out = await client.send(
          new ListPartsCommand({ Bucket, Key: key, UploadId: uploadId, PartNumberMarker: marker, MaxParts: 1000 }),
        );
        for (const p of out.Parts ?? []) {
          if (p.PartNumber && p.ETag) parts.push({ partNumber: p.PartNumber, size: Number(p.Size ?? 0), etag: p.ETag });
        }
        if (!out.IsTruncated || !out.NextPartNumberMarker) break;
        marker = out.NextPartNumberMarker;
      }
      return parts;
    },
    async complete(key, uploadId, parts) {
      await client.send(
        new CompleteMultipartUploadCommand({
          Bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
        }),
      );
    },
    async abort(key, uploadId) {
      await client.send(new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId: uploadId })).catch(() => {});
    },
    async head(key) {
      try {
        const out = await client.send(new HeadObjectCommand({ Bucket, Key: key }));
        return { size: Number(out.ContentLength ?? 0) };
      } catch (err) {
        const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (status === 404) return null;
        throw err;
      }
    },
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
  };
}
