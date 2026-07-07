---
libs:
  "@nestjs/bullmq":
    version: "^11.0.0"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-07-04T22:23:00-03:00"
  "bullmq":
    version: "^5.0.0"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-07-04T22:23:00-03:00"
  "@aws-sdk/client-s3":
    version: "^3.0.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-07-04T22:23:00-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.0.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-07-04T22:23:00-03:00"
  "nanoid":
    version: "^3.3.0"
    context7_id: "/ai/nanoid"
    fetched_at: "2026-07-04T22:23:00-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-04T22:22:23-0300"
---

# Library References — Phase 03: Upload e Processamento de Vídeos

Cache of the docs surfaces the phase actually uses, fetched via Context7. Versions are the
stable major lines compatible with the project's stack (NestJS 11, Node 22, `nodenext` +
CommonJS output, `ts-jest`). Pin the exact patch at install time; the caret ranges below are
the honest lower bounds for the current majors.

> **How the libs map to decisions:** `@nestjs/bullmq` + `bullmq` → TD-01 (queue); `@aws-sdk/client-s3` +
> `@aws-sdk/s3-request-presigner` → TD-03 (storage client), consumed by TD-02 (upload) and TD-07
> (streaming/download); `nanoid` → TD-06 (unique URL id). FFmpeg/ffprobe (TD-05) are **system
> binaries** installed via apt in the worker image — not npm libs — so they are not cached here.
> Redis (TD-01) and MinIO (TD-03) are **Docker images**, likewise out of scope for this cache.

---

## @nestjs/bullmq + bullmq

**Decision:** TD-01 — BullMQ + Redis. `@nestjs/bullmq` is the NestJS wrapper; `bullmq` is the core
Redis-backed queue engine. Both are installed; the `Job` type comes from `bullmq`.

### Root registration + queue

```typescript
// videos.module.ts (or a QueueModule)
import { BullModule } from '@nestjs/bullmq';

@Module({
  imports: [
    BullModule.forRoot({
      connection: { host: 'redis', port: 6379 }, // Compose service name — never localhost
    }),
    BullModule.registerQueue({ name: 'process-video' }),
  ],
})
export class VideosModule {}
```

Connection config should come from `@nestjs/config` (namespaced factory + Joi), mirroring the
Phase 01 convention. `host: 'redis'` = the Compose service name (Docker networking rule).

### Producer (`@InjectQueue`)

```typescript
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

@Injectable()
export class VideosService {
  constructor(@InjectQueue('process-video') private readonly queue: Queue) {}

  async enqueueProcessing(payload: { videoId: string; publicId: string; sourceKey: string }) {
    await this.queue.add('process-video', payload, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: true,
    });
  }
}
```

`attempts` + `backoff` drive the retry policy TD-08 relies on. A job that exhausts `attempts`
lands in the `failed` state — that is the "dead-letter" signal for this stack.

### Consumer (`@Processor` + `WorkerHost`) — worker container (TD-04)

```typescript
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';

@Processor('process-video')
export class VideoProcessor extends WorkerHost {
  async process(job: Job<{ videoId: string; publicId: string; sourceKey: string }>): Promise<void> {
    // ffprobe (duration/metadata) → ffmpeg (thumbnail) → persist → status processing→ready
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) {
    // retries exhausted → set video.status = 'failed' + error_reason (TD-08 DLQ handling)
  }
}
```

The worker boots via `NestFactory.createApplicationContext` (standalone, no HTTP) wiring only the
queue/storage/entity providers (TD-04). Register the processor as a provider in the worker's module.

**Note:** the `@OnWorkerEvent('failed')` fires on every failed attempt; guard the terminal
transition on `job.attemptsMade >= job.opts.attempts` so `failed` is only written once retries are
truly exhausted.

---

## @aws-sdk/client-s3 + @aws-sdk/s3-request-presigner

**Decision:** TD-03 — official S3 SDK v3. One client targets MinIO in dev and S3 in prod by
swapping env only. Presigner provides the signed URLs for TD-02 (upload) and TD-07 (delivery).

### Client (MinIO via endpoint + forcePathStyle)

```typescript
import { S3Client } from '@aws-sdk/client-s3';

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT, // e.g. http://minio:9000 — Compose service name
  region: process.env.S3_REGION ?? 'us-east-1',
  forcePathStyle: true,              // required for MinIO
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY!,
    secretAccessKey: process.env.S3_SECRET_KEY!,
  },
});
```

### Presigned multipart upload (TD-02 — 10GB, resumable, bytes never touch the API)

```typescript
import {
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// 1. init — returns UploadId
const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket, Key }));

// 2. per-part presigned PUT URLs the client uploads directly to MinIO/S3
const url = await getSignedUrl(
  s3,
  new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }),
  { expiresIn: 3600 },
);

// 3. complete — client sends back { PartNumber, ETag }[]
await s3.send(new CompleteMultipartUploadCommand({
  Bucket, Key, UploadId,
  MultipartUpload: { Parts: parts }, // [{ PartNumber, ETag }]
}));

// abort path (cancel / cleanup)
await s3.send(new AbortMultipartUploadCommand({ Bucket, Key, UploadId }));
```

`UploadPartCommand` presigns to `PUT /{Bucket}/{Key}?partNumber&uploadId`. The client orchestrates
part splitting and parallel/resumable upload; the API only issues URLs and completes/aborts.

### Presigned GET — streaming + download (TD-07)

```typescript
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// streaming: browser <video> hits MinIO/S3 directly; storage serves Range/206 natively
const streamUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket, Key }), { expiresIn: 900 });

// download: same primitive + force attachment
const downloadUrl = await getSignedUrl(
  s3,
  new GetObjectCommand({
    Bucket, Key,
    ResponseContentDisposition: `attachment; filename="${filename}"`,
  }),
  { expiresIn: 900 },
);
```

`ResponseContentType` / `ResponseContentDisposition` become query params on the signed URL
(`response-content-type`, `response-content-disposition`). Issue the URL only **after** the API's
auth/visibility check; short TTL contains the "URL bypasses per-request checks while valid" trade-off.

---

## nanoid

**Decision:** TD-06 — short, URL-safe, non-enumerable `public_id` backed by a UNIQUE constraint +
regenerate-on-conflict retry (mirrors the `channels` nickname pattern).

### Usage

```typescript
import { nanoid } from 'nanoid';

const publicId = nanoid();     // 21 chars, alphabet A-Za-z0-9_-  → "V1StGXR8_Z5jdHi6B-myT"
const shorter  = nanoid(11);   // YouTube-like length; UNIQUE + retry gives the hard guarantee
```

`customAlphabet(alphabet, size)` is available if a specific alphabet/length is wanted.

### ⚠️ Version pin — ESM/CommonJS compatibility (load-bearing for this stack)

- **`nanoid` v4+ is pure ESM.** This backend compiles to **CommonJS** (`nest build`) and tests via
  **`ts-jest`** (CommonJS transform). A top-level `import { nanoid } from 'nanoid'` transpiled to
  `require('nanoid')` **breaks at runtime / in Jest** against v4+ (`ERR_REQUIRE_ESM`).
- **Pin `nanoid@^3.3.x`** — the last CommonJS-compatible line — for zero-friction `require()`/Jest
  interop. This is the pragmatic choice for the project's `nodenext` + CommonJS + `ts-jest` setup.
- If v5 is later desired, it requires ESM interop handling (dynamic `import()` or a Jest
  `transformIgnorePatterns` exception) — out of scope for Phase 03. Prefer v3 and move on.
