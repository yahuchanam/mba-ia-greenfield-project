# CLAUDE.md

## Project Overview

StreamTube — a video sharing platform (YouTube-like). Users can upload, manage, and publish videos. Anonymous users can watch freely; social features (comments, subscriptions, likes) require authentication.

More info in the project overview: [docs/project-plan.md](docs/project-plan.md)

## Repository Structure

This is a monorepo with two main areas:

- `nestjs-project/` — Backend API (NestJS 11, TypeScript, Express). Contains modules for users, channels, videos, comments, etc.
- `docs/` — Project documentation, architecture diagrams, and planning.
- `next-frontend/` (Next.js) — not yet initialized

## Architecture (C4 Container Diagram)

See `docs/diagrams/software-arch.mermaid` for the full diagram. Key containers:

- **Frontend** (Next.js) → calls API via REST, streams from Object Storage
- **API** (Nest.js) → business rules, auth, reads/writes DB, uploads to storage, publishes jobs to queue, sends emails
- **Video Worker** (FFmpeg) → consumes jobs from queue, processes videos, updates DB and storage
- **Database** (PostgreSQL) → users, channels, videos, comments, likes
- **Object Storage** (S3/MinIO) → video files and thumbnails
- **Message Queue** (BullMQ + Redis) → video processing job queue
- **Email Service** (SMTP) → account confirmation and password recovery

## Videos (Phase 03 — Upload & Processing)

The video pipeline lives in `nestjs-project/src/videos/` (API side) and
`nestjs-project/src/worker/` (background worker). See the phase plan in
[docs/phases/phase-03-videos/](docs/phases/phase-03-videos/) and the decisions in
[docs/decisions/technical-decisions-phase-03-videos.md](docs/decisions/technical-decisions-phase-03-videos.md).

**Data model:** `videos` table (migration `…-CreateVideos`), owned by a `Channel`.
Key columns: `public_id` (short URL-safe id via `nanoid` + UNIQUE), `status`
(`draft → processing → ready | failed`), `source_key` / `thumbnail_key` (object
keys), `duration_seconds`, `metadata` (jsonb), `error_reason`.

**Upload (10GB, non-blocking):** presigned **multipart** upload straight to object
storage — bytes never pass through the API. The API only pre-registers the draft,
issues presigned part URLs, and completes/aborts the upload.

- `POST /videos` — pre-register draft + start multipart upload (owner only)
- `POST /videos/:publicId/parts` — presigned `UploadPart` URLs
- `POST /videos/:publicId/complete` — finalize, store `source_key`, transition to
  `processing`, and enqueue the `process-video` job
- `POST /videos/:publicId/abort` — cancel the in-progress upload

**Delivery:** presigned `GetObject` URLs (storage serves Range/206 natively).

- `GET /videos/:publicId` — metadata (anonymous sees `ready` only; owner sees any state)
- `GET /videos/:publicId/stream` — short-TTL presigned URL to stream (anonymous, `ready`)
- `GET /videos/:publicId/download` — presigned URL with `attachment` (authenticated)

**Queue:** BullMQ over Redis. `VideosService` is the producer (`process-video` job:
`{ videoId, publicId, sourceKey }`, `attempts: 3` + exponential backoff).

**Worker:** a **separate container** (`video-worker`, `Dockerfile.worker`, FFmpeg
installed only in this image) booting a NestJS standalone context
(`NestFactory.createApplicationContext`, no HTTP) via `src/worker/main.ts`. The
`@Processor('process-video')` consumer downloads the source, runs `ffprobe`
(duration + metadata) and `ffmpeg` (thumbnail frame) via direct `child_process`
spawn, uploads the thumbnail, and transitions `processing → ready` only after
everything is durable. Exhausted retries dead-letter the job → `status = failed`
with `error_reason`. Run it with `npm run start:worker:dev`.

**Storage:** `StorageService` (`src/storage/`) wraps the S3 client — `videos`
bucket for sources, `thumbnails` bucket for thumbnails (MinIO in dev, S3 in prod;
same client, env-only difference).

**Infra (`compose.yaml`):** `minio` + `createbuckets` (auto-creates `videos` /
`thumbnails`), `redis`, and `video-worker` join `nestjs-api` / `db` / `mailpit`.

## Docker Networking

This project runs entirely in Docker containers. When configuring connections between services (database, cache, queue, etc.), **always use the Docker Compose service name** as the host — never `localhost` or `127.0.0.1`.

Inside a container, `localhost` refers to the container itself, not the host machine or other containers. Services communicate through the Docker Compose network using their service names (e.g., `db`, `nestjs-api`).

- **Correct:** `DB_HOST=db` (the Compose service name)
- **Wrong:** `DB_HOST=localhost`

This applies to all environment variables, configuration files, and code that references service hosts.

## Working Principles

- **Single Responsibility:** each module, service, and function should have a clear, focused responsibility. Re-evaluate adherence at every step — when a module starts owning logic or entities that are not its own (e.g., a service creating an entity from another domain), extract it immediately into the proper module instead of deferring to a later corrective task.
- **Type Safety:** Strict TypeScript usage across all layers.
- **Testing:** Strong emphasis on pyramid testing at all levels to ensure reliability and maintainability.
- **Code Quality:** Use ESLint and Prettier for consistent code style. Code reviews should focus on readability, maintainability, and adherence to best practices.
- **Documentation:** Comprehensive docs for architecture, setup, and troubleshooting in `docs/`.

## Definition of Done (Technical)

A change is only considered complete when **all** of the following pass:

1. The relevant test suite passes (unit + integration + e2e affected by the change).
2. The full test suite passes before finishing the task.
3. TypeScript compiles cleanly: `npx tsc --noEmit` exits with code 0. Compilation errors must never be left as debt for future tasks.
4. Lint passes: `npm run lint`.

If any of these fails, the task is not done — fix the underlying issue before declaring completion.


## Git Conventions

- **Main branch:** `main` — never commit directly to it
- Branches: `feature/*`, `bugfix/*`, `hotfix/*`, `docs/*`
- **Commits:** short, descriptive messages focused on the "why" of the change
- **Workflow:** Git Flow conventions. Two long-lived branches:
  - `main` — stable, production-ready code 
  - `dev` — integration branch; all feature/bugfix/hotfix branches start from `dev` and merge back into `dev`
  - When `dev` is stable, it is merged into `main`

## Testing Policy

Every change must be tested. During development, run only the tests related to the modified code. Before finishing, always run the full test suite to ensure nothing is broken.

## Scope Limits

- Work on **one feature, fix, or refactoring at a time** — do not mix scopes
- Do not include cosmetic changes (formatting, renaming) alongside functional changes
- If something out of scope comes up during work, note it as a separate task instead of acting on it
- Focus on the defined scope for each task to ensure clarity and maintainability of the codebase.
- If you identify a necessary change that is out of scope, create a new issue or task for it instead of including it in the current work.

## Agent Skill Usage

When working on any task (planning, implementing, debugging, refactoring, 
reviewing, etc.), decompose the request into its underlying subtasks and 
concerns, then identify which available skills match any of them and activate 
those skills.

## Library Documentation Lookup

Before implementing any feature, you MUST use the **context7** MCP tool to look up the relevant library APIs and official documentation.

Always:

- Check the installed library version in the project manifest
- Retrieve the corresponding documentation using context7
- Cross-reference APIs to avoid deprecated or incompatible patterns
- Follow the official documentation over training data

Skip documentation lookup only for trivial operations such as:

- Variable declarations
- Basic control flow
- Simple CRUD using established project patterns

If a library is involved and there is uncertainty, documentation lookup is mandatory.
If the documentation returned does not match the installed version, flag the discrepancy before proceeding.