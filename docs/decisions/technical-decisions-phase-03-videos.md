---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-07-04
scope_description: "Backend video pipeline: object storage layout, background processing queue, non-blocking 10GB upload strategy, video worker runtime, FFmpeg metadata/thumbnail extraction, unique video URL, streaming/download delivery, and the video status lifecycle with failure handling."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers the whole phase: the videos module (entity, migration, controller, service, repository), the object-storage integration, the processing queue, the FFmpeg worker, and the streaming/download endpoints. Also owns the new Docker Compose services (storage, queue, worker).
- `next-frontend/` — **Frontend deferred.** The enunciado states this is a backend-only phase; the video UI is not built here. Two TDs are marked `Cross-layer` (TD-02 upload protocol, TD-07 streaming/download) because they fix a client-facing contract the future frontend will consume — the contract is decided here, but no frontend code is written in Phase 03.

---

## TD-01: Message Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The project plan and the architecture diagram leave the queue explicitly `TBD` — this is the phase's primary stack decision. The queue decouples the fast HTTP upload-finalization from the slow FFmpeg processing (metadata + thumbnail). It must survive worker restarts, support retries, and run in Docker Compose. The choice drives new infrastructure, the producer API in the videos module, and the worker consumer (TD-04).

**Options:**

### Option A: BullMQ + Redis (`@nestjs/bullmq` + `bullmq`)
- Redis-backed queue. First-class NestJS integration: `BullModule.registerQueue`, `@InjectQueue` producer, `@Processor`/`WorkerHost` consumer, built-in `attempts`/`backoff`, delayed jobs, and Bull Board for inspection.
- **Pros:** De-facto standard for NestJS background jobs; richest feature set (rate limiting, concurrency, stalled-job recovery, DLQ via `failed` state); huge community; excellent docs.
- **Cons:** Adds **Redis** as new infrastructure (one more Compose service + a dependency the project doesn't otherwise need). Job payloads live outside PostgreSQL — no transactional coupling with the videos table.

### Option B: pg-boss (PostgreSQL-backed)
- Queue implemented on the existing PostgreSQL 17. `boss.send(queue, data)` producer, `boss.work(queue, handler)` consumer, `retryLimit`/`retryDelay`/`retryBackoff`, native `deadLetter` queues, and LISTEN/NOTIFY low-latency dispatch.
- **Pros:** **Zero new infrastructure** — reuses the Postgres already in the stack. Jobs are rows, so enqueue can share a transaction with the video pre-registration (no dual-write gap). Native dead-letter and backoff. Simpler ops story for a single-node dev/eval setup.
- **Cons:** No official NestJS module — needs a thin custom provider wrapping the `PgBoss` instance. Lower throughput ceiling than Redis (irrelevant at this scale). Polling-based (mitigated by NOTIFY).

### Option C: RabbitMQ (`@nestjs/microservices` AMQP transport)
- Broker-based messaging via `amqplib`. The worker is a NestJS microservice consuming a queue; the API publishes with `ClientProxy`.
- **Pros:** Battle-tested broker; strong routing/exchange semantics; natural fit if the system later grows into event-driven microservices.
- **Cons:** Heaviest new infrastructure (broker + management). Retry/backoff/DLQ must be assembled manually (dead-letter exchanges, TTL). Routing power is overkill for a single job type (process-video). Most operational overhead of the three.

**Recommendation:** **Option B (pg-boss)** — the only genuinely open decision here is "which broker," and the project's guiding constraint is *reuse the existing stack*. pg-boss delivers durable jobs, retries, backoff, and native dead-letter on the PostgreSQL already running, avoiding a Redis or RabbitMQ container for a workload that is one job type at low volume. It also lets the draft-video INSERT and the job enqueue share a transaction (TD-08), closing the dual-write gap. BullMQ is the stronger choice only if Redis is wanted for other reasons (caching, rate-limit store) — not the case in this phase.

**Decision:** A (BullMQ + Redis)

**Note:** Decision deliberately diverged from the Recommendation. The recommendation optimized for "fewest new containers"; the chosen path favors the standard NestJS/Full Cycle architecture and keeps the database out of the messaging role. Rationale:

- **Ecosystem standard, purpose-built.** BullMQ is the de-facto NestJS background-job solution, highly optimized for queueing, and it offloads the work from PostgreSQL instead of adding to it.
- **The database is not a message broker (Full Cycle methodology).** Using the relational DB as a queue merely to avoid the dual-write is discouraged. The canonical solution for write-then-publish consistency is the **Transactional Outbox Pattern**: persist the video and, in the *same transaction*, insert a row into an `outbox` table; a separate process (a relay worker, or CDC such as Debezium) reads the outbox and publishes to the real broker (BullMQ/Redis). This preserves consistency without turning the relational database into a message broker. (The outbox itself is an implementation option to revisit if strict enqueue-with-transaction consistency is required — it is orthogonal to the broker choice.)
- **Concurrency & locks.** Relational databases are not designed for the extremely high-rate insert/delete churn a queue imposes; using Postgres as a queue can cause table bloat and fragmentation.
- **Single Point of Failure.** With a DB-backed queue, if the database goes down you lose not only persistence but the entire background-job subsystem. A dedicated broker isolates that failure domain.
- **False simplicity.** A DB-backed queue "saves" one container (Redis) but pushes processing load onto the database — the most expensive and hardest-to-scale-horizontally component in the architecture. The apparent simplicity is paid for later in scaling cost.
- **Forward alignment.** Redis introduced here is reusable by later phases whose workloads genuinely call for it (view counters and anti-abuse dedup in Phases 05–06; a distributed rate-limit store for `@nestjs/throttler` under multi-instance deploys), avoiding a broker migration down the line.

---

## TD-02: 10GB Upload Strategy (non-blocking)

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** A 10GB upload must not pass through the Node/Nest API as a buffered or even streamed request body — holding a multi-GB request ties up the event loop, memory, and a worker for the whole transfer, and the enunciado explicitly fails any design that "passes the file through the API in a way that blocks the system." The handshake sequence is a client-facing contract (decided here; the frontend consumes it later). Depends on TD-03 (storage client).

**Options:**

### Option A: Presigned URL — single PUT direct to storage
- API pre-registers the draft video (TD-08) and returns a presigned `PutObjectCommand` URL (`@aws-sdk/s3-request-presigner`). The client uploads the bytes **directly to MinIO/S3**; the API never touches the file. Client then calls a "finalize" endpoint to enqueue processing.
- **Pros:** API stays free during transfer — zero file bytes through Nest. Simplest of the direct-to-storage options. Native S3/MinIO. Minimal new code.
- **Cons:** A single PUT of 10GB is not resumable — a dropped connection restarts the whole upload. S3 single-PUT max is 5GB (MinIO is more lenient but the pattern is fragile at 10GB).

### Option B: Presigned **Multipart** Upload direct to storage
- API starts an S3 multipart upload (`CreateMultipartUpload`), hands the client presigned URLs per part (`UploadPart`), the client uploads parts directly to MinIO/S3 in parallel/resumable fashion, then the API completes the upload (`CompleteMultipartUpload`) and enqueues processing.
- **Pros:** Handles 10GB cleanly (parts up to 5GB each, 10k parts). **Resumable** — a failed part is retried without restarting. Parallel parts = faster. Still zero bytes through the API. Aligns with the plan's "retomar em caso de falha" note.
- **Cons:** More endpoints/state (init → part URLs → complete/abort). Client must orchestrate part splitting. More moving parts to test.

### Option C: tus resumable protocol (`@tus/server`) mounted on the API
- Run a tus server (disk or S3 store) as an endpoint; the client uses a tus client for resumable, chunked uploads.
- **Pros:** Purpose-built resumable protocol; robust pause/resume; S3 store offloads to MinIO.
- **Cons:** With the disk store the bytes **do** transit the API host (defeats the non-blocking goal); the S3 store adds a protocol + dependency layer over what multipart already gives natively. New protocol for the frontend to adopt. Heaviest option for this stack.

**Recommendation:** **Option B (Presigned Multipart Upload)** — it is the only option that satisfies *both* hard requirements at 10GB: bytes never pass through the API (performance) **and** the upload is resumable (the plan's "retomar em caso de falha"). It builds directly on the S3 SDK chosen in TD-03 with no extra protocol dependency. Option A is a reasonable simplification if resumability is dropped, but 10GB single-PUT is exactly the fragility the plan warns about. Option C's benefit is already provided natively by multipart.

**Decision:** B (Presigned Multipart Upload)

---

## TD-03: Object Storage Client & Bucket/Key Organization

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Storage itself is *given* (MinIO in dev, S3-compatible in prod) — the open choice is the client library and the bucket/key layout, which is a cross-component contract shared by the API (presign, finalize), the worker (read source, write thumbnail), and Compose (bucket bootstrap). MinIO reached via `endpoint` + `forcePathStyle`.

**Options:**

### Option A: `@aws-sdk/client-s3` v3 (+ `@aws-sdk/s3-request-presigner`)
- Official modular AWS SDK v3. `S3Client({ endpoint, forcePathStyle: true, credentials })` points at MinIO; same code targets real S3 by swapping env. Provides `CreateMultipartUpload`/`UploadPart`/`GetObjectCommand` and `getSignedUrl` needed by TD-02 and TD-07.
- **Pros:** First-class TypeScript, tree-shakeable, the canonical presign + multipart API. One client works for MinIO **and** S3 — honours "MinIO now, S3 later" with no code change. Actively maintained.
- **Cons:** Verbose command/middleware style. Larger transitive dependency surface than the MinIO SDK.

### Option B: `minio` JS SDK
- MinIO's own client (`presignedPutObject`, `presignedGetObject`, `fPutObject`).
- **Pros:** Slightly terser API; MinIO-native.
- **Cons:** Optimised for MinIO — the "swap to AWS S3 in prod" story is weaker. Multipart presign ergonomics are less standard than the AWS SDK. Diverges from the S3 vocabulary the rest of the ecosystem uses.

**Bucket/key layout (applies to the chosen client):** two buckets — `videos` (source + processed) and `thumbnails` — or one bucket with prefixes. Proposed key scheme keyed by the unique id (TD-06): `videos/{publicId}/source.<ext>` and `thumbnails/{publicId}/thumb.jpg`. Buckets auto-created on stack startup (Compose init step / `mc mb`).

**Recommendation:** **Option A (`@aws-sdk/client-s3` v3)** — it is the same S3 API in dev (MinIO via `endpoint`+`forcePathStyle`) and prod (S3), directly satisfying the plan's "MinIO local, S3 in production" intent with zero code divergence, and it is the SDK whose presigned-multipart and presigned-GET primitives TD-02 and TD-07 depend on. Suggested layout: separate `videos` and `thumbnails` buckets, keys namespaced by the video's unique id.

**Decision:** A (`@aws-sdk/client-s3` v3 + presigner)

---

## TD-04: Video Worker Runtime & Deployment

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** The architecture diagram shows the Video Worker as a **separate container** from the API, consuming the queue and holding FFmpeg. The decision is how the worker process is built and deployed relative to the NestJS app — it drives the new Compose service, the Dockerfile, and code sharing (entities, storage service, config) between API and worker.

**Options:**

### Option A: Separate container, same codebase — NestJS standalone application context
- A second Compose service built from the same image, started with a different entrypoint that boots a Nest **standalone** app (`NestFactory.createApplicationContext`) wiring only the worker/queue/storage providers (no HTTP server). Reuses the videos entity, storage service, and config via DI.
- **Pros:** Matches the diagram (separate container, independent scaling/restart). Maximal reuse — one codebase, shared entities/services/config, shared migrations. FFmpeg installed only in this image. Clean DI, testable with the project's existing patterns.
- **Cons:** Slightly more Compose/Dockerfile wiring (two entrypoints). Must keep the worker's module graph lean so it doesn't boot HTTP-only providers.

### Option B: Same container as the API (in-process worker)
- The API process also runs the queue consumer (e.g. `@Processor` in the same Nest app).
- **Pros:** Simplest wiring — one service, one process.
- **Cons:** **Contradicts the architecture diagram.** FFmpeg CPU work competes with the API event loop and request handling — the exact coupling the phase is designed to avoid. Can't scale or restart processing independently. FFmpeg bloats the API image.

### Option C: Separate standalone Node worker (no NestJS)
- A plain Node script in its own container consuming the queue directly.
- **Pros:** Leanest runtime; no Nest bootstrap overhead.
- **Cons:** Loses DI, config, TypeORM entity reuse, and the project's conventions — duplicated storage/DB wiring and divergent code style. More drift risk between API and worker.

**Recommendation:** **Option A (separate container, shared codebase via Nest standalone context)** — it is the only option that honours the diagram (worker isolated from the API) while maximizing reuse of the existing entities, storage service, config, and migrations through NestJS DI. FFmpeg lives only in the worker image, keeping CPU-heavy processing off the API. Option B violates the intended architecture; Option C throws away the project's conventions.

**Decision:** A (separate container, shared codebase via Nest standalone context)

---

## TD-05: FFmpeg Integration for Metadata & Thumbnail

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** Inside the worker (TD-04), each job must probe the source video for duration/metadata and extract one frame as a thumbnail. FFmpeg/ffprobe binaries are installed in the worker image (apt). The decision is how the Node worker drives them — it affects dependencies, error handling, and testability. The worker reads the source from storage and writes the thumbnail back (TD-03).

**Options:**

### Option A: `fluent-ffmpeg` wrapper
- Fluent JS API over ffmpeg (`ffmpeg(input).screenshots(...)`, `ffmpeg.ffprobe(...)`).
- **Pros:** Readable, chainable API; handles arg building and event wiring; familiar to many.
- **Cons:** In **maintenance mode** (sparse releases); an extra dependency layer over a tiny command set; still requires the binaries installed anyway. Typing gaps.

### Option B: Direct `child_process` spawn of `ffprobe` + `ffmpeg`
- Spawn `ffprobe -v quiet -print_format json -show_format -show_streams` (parse JSON for duration/metadata) and `ffmpeg -ss <t> -i input -frames:v 1 thumb.jpg`.
- **Pros:** **Zero extra dependencies**; full control over exact args and exit-code/stderr handling; deterministic JSON from ffprobe; trivial to unit-test by mocking the spawn boundary. No reliance on an unmaintained wrapper.
- **Cons:** Manual arg construction and stream/error plumbing (small, but hand-written). No convenience helpers.

**Recommendation:** **Option B (direct `child_process` spawn)** — the command surface is tiny and fixed (one ffprobe probe + one frame extract), so a maintained-but-thin wrapper buys little while adding a dependency that is itself in maintenance mode. Raw spawn gives full control over args, exit codes, and stderr, deterministic ffprobe JSON, and a clean mock boundary for tests — a better fit for the project's strict-typing, few-dependencies posture. Choose Option A only if the processing pipeline is expected to grow many filter chains where the fluent API pays off.

**Decision:** B (direct `child_process` spawn of ffprobe/ffmpeg)

---

## TD-06: Unique Video URL Identifier

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a short, unique, collision-free public identifier used in its URL and (per TD-03) in its storage keys. It is a cross-component value — it appears in the videos table, the API routes, and the object keys — so the generation strategy is a contract, not an implementation detail. The plan stresses "URL curta e única que nunca conflite."

**Options:**

### Option A: `nanoid` (short URL-safe id, e.g. 11–12 chars)
- Cryptographically strong random id from a URL-safe alphabet, stored as the video's `public_id` with a UNIQUE constraint.
- **Pros:** Short and YouTube-like (`/watch/V1StGXR8_Z5`); URL-safe by default; collision probability negligible at this scale; tiny dependency. UNIQUE constraint + retry gives a hard guarantee.
- **Cons:** Adds one small dependency. Not sortable/sequential.

### Option B: UUID v4 (`crypto.randomUUID()`)
- Built-in Node UUID as the public id.
- **Pros:** Zero dependency (native); ubiquitous; effectively collision-free.
- **Cons:** Long and ugly in URLs (36 chars with hyphens) — contradicts the "URL curta" goal.

### Option C: Database sequence / auto-increment id in the URL
- Use the row's serial PK (or a `hashids`-style encoding of it) as the URL id.
- **Pros:** Guaranteed unique by the DB; no extra generation.
- **Cons:** Sequential ids are **enumerable** (scraping, guessing counts, leaking volume); exposing the PK couples the URL to storage internals. Encoding to hide it re-introduces a dependency anyway.

**Recommendation:** **Option A (`nanoid`)** — it directly satisfies "short and never-conflicting": a compact, URL-safe, non-enumerable id backed by a UNIQUE constraint (with a regenerate-on-conflict retry, mirroring the nickname pattern already in `channels`). UUID v4 works with zero deps but yields long, un-YouTube-like URLs; sequential ids leak information. The single small dependency is justified by the short, opaque URL the plan calls for.

**Decision:** A (`nanoid` + UNIQUE constraint)

---

## TD-07: Streaming & Download Delivery

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Anonymous viewers must play a video without downloading it whole (seek/scrub via byte ranges) and authenticated users must be able to download it. How bytes reach the client is a client-facing contract. The architecture diagram already draws the frontend streaming **directly from storage** (`Rel(frontend, storage, "Streams", "HTTPS")`). Depends on TD-03.

**Options:**

### Option A: API proxies bytes with HTTP Range / 206 Partial Content
- The video route reads the requested `Range` header, fetches that byte range from storage (`GetObjectCommand` with `Range`), and streams back `206 Partial Content` with `Content-Range`/`Accept-Ranges`.
- **Pros:** Full control (auth checks, visibility rules, view counting per request) at the API. Storage stays private (no public/presigned exposure). Standard `<video>` seeking works.
- **Cons:** **Every byte transits the API** — reintroduces exactly the bandwidth/event-loop pressure the phase avoids for uploads. Doesn't match the diagram. API becomes the streaming bottleneck.

### Option B: Presigned `GetObject` URL — client streams directly from storage
- The API authorizes the request and returns a short-lived presigned GET URL; the browser's `<video>`/download hits MinIO/S3 directly, which natively serves Range/206.
- **Pros:** **Matches the diagram** (frontend ↔ storage). API never streams bytes — no bandwidth bottleneck. MinIO/S3 handle Range/206 natively. One presign call covers both streaming and download (optionally `response-content-disposition: attachment` for download).
- **Cons:** URL is time-limited and, while valid, bypasses per-request API checks (mitigated by short TTL + issuing only after auth/visibility checks). Per-view accounting happens at presign time, not per byte.

### Option C: Hybrid — presigned GET for streaming, API-mediated for download
- Streaming via presigned URL (Option B); download via an API route that sets attachment headers.
- **Pros:** Fine-grained control over the download path if needed.
- **Cons:** Two code paths for one concern; download still either proxies bytes (Option A's cost) or ends up presigning anyway (then it's just Option B with extra steps).

**Recommendation:** **Option B (presigned `GetObject`)** — it is the design the architecture diagram already prescribes (client streams from storage, not through the API), it keeps multi-GB playback/download bandwidth entirely off the Node API, and MinIO/S3 serve Range/206 natively so `<video>` seeking and resumable download work out of the box. The same presign primitive serves both streaming and download (via `response-content-disposition`). Short TTLs plus issuing the URL only after the API's auth/visibility check contain the trade-off. Choose Option A only if per-byte API-side control (e.g. strict private streaming) outweighs the bandwidth cost — not the case for an anonymous-viewable platform.

**Decision:** B (presigned `GetObject` — client streams directly from storage)

---

## TD-08: Video Status Lifecycle & Processing-Failure Handling

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** The video row is pre-registered as a draft when the upload starts and moves through states as processing runs, ending in a terminal ready/error state. The status enum is a cross-component contract (DB enum + API responses + worker transitions), and the failure behavior must be defined explicitly. Depends on TD-01 (queue retries/DLQ) and TD-04 (worker).

**Options:**

### Option A: Minimal lifecycle — `draft → processing → ready | failed`
- Draft on pre-registration; `processing` when the finalize endpoint enqueues the job; `ready` on success (duration/metadata/thumbnail persisted); `failed` if the worker exhausts retries (queue `retryLimit` then dead-letter → the DLQ handler sets `failed`, optionally with an error reason).
- **Pros:** Simple, covers exactly the plan's "rascunho → processando → pronto/erro." Few states to test and reason about. Maps cleanly onto pg-boss/BullMQ retry + dead-letter.
- **Cons:** Doesn't distinguish "upload in progress" from "processing"; a failed upload stays `draft` until cleaned up.

### Option B: Granular lifecycle — `draft → uploading → uploaded → processing → ready | failed`
- Adds explicit `uploading` (multipart in progress) and `uploaded` (bytes stored, job not yet done) states between draft and processing.
- **Pros:** Precise visibility into where a video is; easier orphan/stuck-upload cleanup; distinguishes upload failure from processing failure.
- **Cons:** More states, transitions, and tests for marginal benefit at this scope; some states are transient and rarely observed by clients.

**Failure handling (applies to either):** the worker relies on the queue's retry with backoff (TD-01); after the retry limit the job is dead-lettered and a handler sets the video to `failed` with an error reason. `ready` is only reached after thumbnail + metadata are durably persisted, so partial results never surface as ready.

**Recommendation:** **Option A (minimal `draft → processing → ready | failed`)** — it is exactly the cycle the enunciado and plan name ("rascunho → processando → pronto/erro"), keeps the state machine small and fully testable, and maps one-to-one onto the chosen queue's retry + dead-letter mechanics for failure handling. Add the granular `uploading`/`uploaded` states (Option B) only if orphaned-upload cleanup or upload/processing failure distinction becomes a real requirement — it isn't in Phase 03's scope.

**Decision:** A (minimal `draft → processing → ready | failed` + DLQ)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Message Queue Technology | pg-boss (PostgreSQL-backed) | A (BullMQ + Redis) |
| TD-02 | Cross-layer | 10GB Upload Strategy | Presigned Multipart Upload (direct to storage) | B (Presigned Multipart Upload) |
| TD-03 | Backend | Object Storage Client & Bucket/Key Layout | `@aws-sdk/client-s3` v3 + presigner | A (`@aws-sdk/client-s3` v3 + presigner) |
| TD-04 | Backend | Video Worker Runtime & Deployment | Separate container, shared codebase (Nest standalone context) | A (separate container, shared codebase) |
| TD-05 | Backend | FFmpeg Integration (metadata + thumbnail) | Direct `child_process` spawn (ffprobe/ffmpeg) | B (direct `child_process` spawn) |
| TD-06 | Backend | Unique Video URL Identifier | `nanoid` + UNIQUE constraint | A (`nanoid` + UNIQUE constraint) |
| TD-07 | Cross-layer | Streaming & Download Delivery | Presigned `GetObject` (client ↔ storage, native Range/206) | B (presigned `GetObject`) |
| TD-08 | Backend | Video Status Lifecycle & Failure Handling | Minimal `draft → processing → ready \| failed` + DLQ | A (minimal `draft → processing → ready \| failed` + DLQ) |
