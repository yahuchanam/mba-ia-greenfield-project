---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-07-04T15:52:46-0300"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-04T22:22:23-0300"
  docs/phases/phase-03-videos/library-refs.md: "2026-07-04T22:25:27-0300"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-07-04T16:53:05-0300"
  docs/phases/phase-01-configuracao-base/context.md: "2026-07-04T16:53:05-0300"
  docs/phases/phase-02-auth/context.md: "2026-07-04T16:53:05-0300"
  docs/phases/phase-02-auth-frontend/context.md: "2026-07-04T16:53:05-0300"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-07-04T15:52:46-0300"
---

# phase-03-videos — Context

## Scope

**Phase name:** Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified in project-plan.md._ Per the decisions doc, `next-frontend/` UI is **deferred** — this is a backend-only phase (see `## Inherited Deferred Capabilities` and TD-02/TD-07 marked Cross-layer for the client-facing contract fixed here without frontend code).

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:**

- `nestjs-project` — owns the whole phase: videos module (entity, migration, controller, service, repository), object-storage integration, processing queue, FFmpeg worker, streaming/download endpoints, and the new Docker Compose services (storage, queue, worker).
- `next-frontend` — **deferred this phase.** Would consume the streaming/download contract (TD-07) and the upload handshake (TD-02); no frontend code is written in Phase 03.

**Deferred subprojects:** `next-frontend` (frontend video UI deferred to a later phase).

**Sequencing notes:** `> Depende de: Fase 01, Fase 02` — Phase 03 builds on the base setup (config/DB) and the auth/channels foundation.

**Neighbors (for boundary detection only):**

- **Phase 02:** Fluxo completo de criação de conta, confirmação por e-mail, login, logout e recuperação de senha.
- **Phase 04:** Edição das informações do vídeo, fluxo de rascunho e publicação, painel de administração do canal e página pública.

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Message Queue Technology | decided | A (BullMQ + Redis) | `@nestjs/bullmq@^11.x`, `bullmq@^5.x` |
| phase-03-videos/TD-02 | phase | Cross-layer | 10GB Upload Strategy (non-blocking) | decided | B (Presigned Multipart Upload) | — |
| phase-03-videos/TD-03 | phase | Backend | Object Storage Client & Bucket/Key Organization | decided | A (`@aws-sdk/client-s3` v3 + presigner) | `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x` |
| phase-03-videos/TD-04 | phase | Backend | Video Worker Runtime & Deployment | decided | A (separate container, shared codebase via Nest standalone context) | — |
| phase-03-videos/TD-05 | phase | Backend | FFmpeg Integration for Metadata & Thumbnail | decided | B (direct `child_process` spawn of ffprobe/ffmpeg) | — |
| phase-03-videos/TD-06 | phase | Backend | Unique Video URL Identifier | decided | A (`nanoid` + UNIQUE constraint) | `nanoid@^3.3.x` (CommonJS line) |
| phase-03-videos/TD-07 | phase | Cross-layer | Streaming & Download Delivery | decided | B (presigned `GetObject`) | — |
| phase-03-videos/TD-08 | phase | Backend | Video Status Lifecycle & Processing-Failure Handling | decided | A (minimal `draft → processing → ready \| failed` + DLQ) | — |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase, related_phases: [3])

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-03 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-04 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-08 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-04, phase-03-videos/TD-05, phase-03-videos/TD-08 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-05 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-06 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-07 |
| Download do vídeo pelo usuário | phase-03-videos/TD-07 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** the only genuinely open decision here is "which broker," and the project's guiding constraint is *reuse the existing stack*. pg-boss delivers durable jobs, retries, backoff, and native dead-letter on the PostgreSQL already running, avoiding a Redis or RabbitMQ container for a workload that is one job type at low volume. It also lets the draft-video INSERT and the job enqueue share a transaction (TD-08), closing the dual-write gap. BullMQ is the stronger choice only if Redis is wanted for other reasons (caching, rate-limit store) — not the case in this phase. _(Decision diverged to **A — BullMQ + Redis**; see the decisions doc's Note for rationale: ecosystem standard, DB is not a broker / Outbox Pattern, SPOF & table-bloat avoidance, forward alignment with Phases 05–06.)_
**Libraries:** `@nestjs/bullmq@^11.x`, `bullmq@^5.x`

### phase-03-videos/TD-02

**Recommendation:** it is the only option that satisfies *both* hard requirements at 10GB: bytes never pass through the API (performance) **and** the upload is resumable (the plan's "retomar em caso de falha"). It builds directly on the S3 SDK chosen in TD-03 with no extra protocol dependency. Option A is a reasonable simplification if resumability is dropped, but 10GB single-PUT is exactly the fragility the plan warns about. Option C's benefit is already provided natively by multipart.
**Libraries:** —

### phase-03-videos/TD-03

**Recommendation:** it is the same S3 API in dev (MinIO via `endpoint`+`forcePathStyle`) and prod (S3), directly satisfying the plan's "MinIO local, S3 in production" intent with zero code divergence, and it is the SDK whose presigned-multipart and presigned-GET primitives TD-02 and TD-07 depend on. Suggested layout: separate `videos` and `thumbnails` buckets, keys namespaced by the video's unique id.
**Libraries:** `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`

### phase-03-videos/TD-04

**Recommendation:** it is the only option that honours the diagram (worker isolated from the API) while maximizing reuse of the existing entities, storage service, config, and migrations through NestJS DI. FFmpeg lives only in the worker image, keeping CPU-heavy processing off the API. Option B violates the intended architecture; Option C throws away the project's conventions.
**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** the command surface is tiny and fixed (one ffprobe probe + one frame extract), so a maintained-but-thin wrapper buys little while adding a dependency that is itself in maintenance mode. Raw spawn gives full control over args, exit codes, and stderr, deterministic ffprobe JSON, and a clean mock boundary for tests — a better fit for the project's strict-typing, few-dependencies posture. Choose Option A only if the processing pipeline is expected to grow many filter chains where the fluent API pays off.
**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** it directly satisfies "short and never-conflicting": a compact, URL-safe, non-enumerable id backed by a UNIQUE constraint (with a regenerate-on-conflict retry, mirroring the nickname pattern already in `channels`). UUID v4 works with zero deps but yields long, un-YouTube-like URLs; sequential ids leak information. The single small dependency is justified by the short, opaque URL the plan calls for.
**Libraries:** `nanoid@^3.3.x` (CommonJS line — see library-refs.md for the ESM pin rationale)

### phase-03-videos/TD-07

**Recommendation:** it is the design the architecture diagram already prescribes (client streams from storage, not through the API), it keeps multi-GB playback/download bandwidth entirely off the Node API, and MinIO/S3 serve Range/206 natively so `<video>` seeking and resumable download work out of the box. The same presign primitive serves both streaming and download (via `response-content-disposition`). Short TTLs plus issuing the URL only after the API's auth/visibility check contain the trade-off. Choose Option A only if per-byte API-side control (e.g. strict private streaming) outweighs the bandwidth cost — not the case for an anonymous-viewable platform.
**Libraries:** —

### phase-03-videos/TD-08

**Recommendation:** it is exactly the cycle the enunciado and plan name ("rascunho → processando → pronto/erro"), keeps the state machine small and fully testable, and maps one-to-one onto the chosen queue's retry + dead-letter mechanics for failure handling. Add the granular `uploading`/`uploaded` states (Option B) only if orphaned-upload cleanup or upload/processing failure distinction becomes a real requirement — it isn't in Phase 03's scope.
**Libraries:** —

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.
**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.
**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`. Initial files for Phase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.
**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.
**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.
**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.

**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap, so the plugin-architecture benefit did not justify the extra abstraction layer.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.
**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.
**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.
**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.
**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.
**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.
**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.

**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size and base64-readability for a single token format across the codebase.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes. Hyphens can always be added in a future iteration if user feedback justifies it.
**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** Three reasons. (1) **Architectural fit.** The strict-BFF model in `next-frontend-config-base/TD-03` already nominates the Route Handler as the only NestJS caller; cookie-based sessions are the natural match, and Auth.js's framework adds layers between the BFF and the cookie that buy nothing because the backend is the auth authority. (2) **Smaller blast radius.** A ~50-LOC session helper is grep-friendly, debuggable, and test-friendly via the existing MSW+BFF integration test pattern; a misconfigured Auth.js callback is a longer fault-isolation loop. (3) **Compatibility with Next.js 16 / React 19.** Built-in `next/headers` `cookies()` is the canonical primitive both runtimes already use. Option C is rejected as unsafe (`localStorage` for refresh tokens) and architecturally regressive.
**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** Three reasons. (1) **Defense in depth on the cookie content** — `httpOnly` blocks JS, encryption blocks accidental log/proxy inspection; the marginal cost is one ~3KB dep. (2) **Single cookie to manage** simplifies logout (one `session.destroy()` call) and avoids the orphan-cookie failure mode of Option A. (3) **Room to carry minimal user metadata** (`userId`, `email`, `channelSlug`) lets `app/layout.tsx` RSC render the authenticated chrome without a per-render `/auth/me` round-trip. Option C is rejected: it solves a problem the project does not have at the cost of infrastructure it does not own.
**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** The single-flight detail is non-trivial and goes in the helper from day one — tested by MSW with a "two concurrent intercepted upstream calls; one refresh expected" assertion. Option B's client-driven pattern is rejected because it doesn't replace Option A (RSC still needs server-side refresh). Option C's pre-emptive timer is rejected because the failure modes (multiple tabs, sleep/wake) outweigh the latency saving and force a `"use client"` shell near the root.
**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** Three reasons. (1) **Decoupled from TD-05** — works with Route Handlers OR Server Actions; the form code does not change if TD-05 is revisited later. (2) **Aligned with shadcn's canonical form primitive** — the project already commits to `radix-nova` shadcn; `npx shadcn@latest add form` produces react-hook-form wrappers. (3) **Zod-first developer ergonomics match the rest of the FE foundation.** Option B is rejected for impedance with shadcn's primitive; Option C is rejected for per-field boilerplate.
**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Three reasons. (1) **Strict-BFF alignment.** `next-frontend-config-base/TD-03` named Route Handlers as the BFF surface; Option A keeps every mutation visible under `app/api/**`. (2) **Test scaffold already exists** for Route-Handlers-as-functions; Option A reuses it with zero invention. (3) **Single mutation surface** — Phase 02 sets the precedent for Phases 03–07; uniformity beats per-mutation idiom-picking. Option B fragments the BFF surface; the migration A→B is per-form if ever needed.
**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** Two reinforcing reasons. (1) **No first-render flicker, no round-trip** — the session is delivered in the same response as the page HTML; the Client Provider hydrates with the correct initial state. (2) **No new BFF endpoint** — the cookie is the source of truth, RSC reads it, the Provider broadcasts it. The `router.refresh()` requirement after mid-session mutations is a small price. Option B is rejected for the double-read-and-flicker; Option C is dominated by B.
**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** Three reasons. (1) **First-paint-correct** — the user sees the right outcome on the first paint, no skeleton, no flicker. (2) **Single integration pattern across both flows** — confirmation is RSC-only; reset is RSC + Client form (TD-04, TD-05 patterns reused). (3) **Email-prefetch behavior** is solved at the backend's idempotent-confirmation level. Option B adds redirects for no clean gain; Option C is dominated.
**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** `@nestjs/swagger` — é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo. Nestia tem mérito técnico real mas o custo de migração do stack de validação inviabiliza-a sem uma decisão upstream de supersede de TD-06. Manual authoring é descartado.

**Revisions:**
- 2026-05-12 — Esclarece que o CLI plugin (`classValidatorShim: true`) cobre apenas inferência de schemas de DTOs a partir de `class-validator`; documentação de operações, respostas tipadas por status code, contratos de erro (alinhados ao envelope de phase-02-auth/TD-07) e exemplos exigem decoradores explícitos (`@ApiOperation`, `@ApiResponse`, `@ApiBody`, `@ApiParam`, `@ApiQuery`, `@ApiExtraModels`).
**Libraries:** @nestjs/swagger

### openapi-docs-nestjs/TD-02

**Recommendation:** Ambos (Runtime UI + `openapi.json` exportado) — o custo marginal sobre a opção runtime-only é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam. Runtime-only sozinho compromete o pipeline de codegen futuro; artefato-only sozinho pune a experiência de desenvolvimento. Combinar é dominante.
**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** Apenas em dev/staging (desabilitada em prod via env flag) — alinha com a postura defensiva já estabelecida em phase 02 (throttler, refresh rotation) e não compromete consumidores legítimos (o `openapi.json` commitado em TD-02 cumpre o papel de "spec consultável fora da UI"). Re-abrir como sempre-exposta (com ou sem Basic Auth) é trivial no futuro se um caso de uso de API pública aparecer.
**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions... })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function. _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options. _(from phase 01)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| "Telas de frontend" | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | deferred_to_next_phase — UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | deferred_to_next_phase — logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements POST `/api/auth/logout` (BFF route handler + `session.destroy()`) so the contract is ready when the chrome lands. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | deferred_to_next_phase — `/forgot-password` ships this phase sending the e-mail; the reset-password destination screen is absent from Figma → link destination remains a 404 until a later phase delivers the screen. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | a tela de confirmação da conta não será implementada nesta fase corrente, será adiada — the umbrella bullet's full coverage requires the confirmação and reset-password destination screens; both are deferred per rows above. |

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit (branch logic, mock repo) + Integration (DB contract) |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (JWT, cache, queue) | Unit: real lib with test config |
| Service with side-effect dep (email, storage, queue) | Integration: real capture/adapter (e.g. Mailpit, local S3/MinIO) |
| Module with configured imports | Unit: compilation test (`Test.createTestingModule({ imports: [Module] }).compile()`) |
| Controller (`*.controller.ts`) | E2E only — do NOT write unit tests |
| DTO (`*.dto.ts`) | E2E: one validation-wiring test per endpoint |
| Guard (delegates to service) | E2E + Unit if complex internal logic |
| Guard (simple, delegates to Passport) | E2E only |
| Strategy (Passport) | E2E via guard |
| Pipe (custom transformation/validation) | Unit |
| Interceptor (response transform, logging) | Unit and/or E2E |
| Exception Filter | Unit + E2E |
| Middleware | E2E |

_Test-execution constraints (from `nestjs-project/CLAUDE.md`): all `npm`/`npx`/`tsc`/test commands run inside `docker compose exec nestjs-api`; integration + e2e suites share one DB and must run `--runInBand`; suffixes `*.spec.ts` (unit), `*.integration-spec.ts` (integration, real DB), `*.e2e-spec.ts` (HTTP via supertest, in `test/`)._
