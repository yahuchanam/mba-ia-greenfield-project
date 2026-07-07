---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-07-04T22:26:36-0300"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-04T22:22:23-0300"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-07-04T16:53:05-0300"
---

# Fase 03 — Upload e Processamento de Vídeos

## Objective

Entregar o pipeline de vídeos do backend (`nestjs-project`): armazenamento de objetos (MinIO/S3), fila de processamento em segundo plano (BullMQ + Redis) com worker FFmpeg em container separado, upload de até 10GB sem passar pela API (presigned multipart), pré-cadastro do vídeo como rascunho, processamento automático (duração/metadados + thumbnail), URL única por vídeo (`nanoid`), e entrega por streaming/download direto do storage (presigned GetObject).

---

## Step Implementations

### SI-03.1 — Infra: MinIO + Redis no Compose + config

**Description:** Subir a infraestrutura nova da fase (object storage + broker) no Docker Compose e expor sua configuração tipada, seguindo o padrão de config da Fase 01.

**Technical actions:**

1. Adicionar serviço `minio` ao `compose.yaml` + step de bootstrap (`mc mb`) criando os buckets `videos` e `thumbnails` (per `phase-03-videos/TD-03`).
2. Adicionar serviço `redis` ao `compose.yaml` (per `phase-03-videos/TD-01`).
3. Criar `src/config/storage.config.ts` e `src/config/queue.config.ts` via `registerAs` namespaced e estender o schema Joi em `src/config/env.validation.ts` (per `## Inherited Conventions` — phase 01); hosts usam os nomes de serviço Compose (`minio`, `redis`), nunca `localhost`.
4. Atualizar `.env.example` com as chaves de storage (endpoint, credenciais, buckets) e de Redis, mantendo valores shell-safe (aspas quando necessário).

**Tests:** _(empty — Infra)_

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` sobe `minio` e `redis` com status `running`.
- Os buckets `videos` e `thumbnails` existem no MinIO após o boot.
- Boot da API falha (Joi) quando uma variável obrigatória de storage/redis está ausente.

---

### SI-03.2 — Entidade `Video` + migration

**Description:** Modelar a tabela de vídeos ligada ao canal, com id público único e enum de status, e criar a migration correspondente.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` com os campos do `### Data Model → Video` (enum `status` com `draft`/`processing`/`ready`/`failed`, `public_id` único) (per `phase-03-videos/TD-06`, `phase-03-videos/TD-08`, `phase-03-videos/TD-03`).
2. Definir a relação `Video` belongs to `Channel` (FK `channel_id`, on delete cascade).
3. Criar a migration `CreateVideos` — tabela `videos`, tipo enum `videos_status_enum`, índices (`unique(public_id)`, `channel_id`, `status`) (per `## Inherited Conventions` — typeorm migrations); incluir `DROP TYPE IF EXISTS` do enum no `down`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: `unique(public_id)`, default `status = draft`, FK `channel_id`, valores do enum | `src/videos/entities/video.entity.integration-spec.ts` |
| `CreateVideos` (migration) | Integration: aplica e reverte, cria/remove tabela + enum | `src/database/migrations.integration-spec.ts` (estender) |

**Dependencies:** none _(a tabela `channels` é herdada da Fase 02)_

**Acceptance criteria:**

- Inserir dois vídeos com o mesmo `public_id` viola a constraint `unique`.
- Um vídeo recém-criado sem `status` explícito persiste com `status = draft`.
- Remover um canal remove em cascata seus vídeos.
- A migration aplica e reverte deixando o schema limpo (sem enum órfão).

---

### SI-03.3 — Storage service (cliente S3 + presign)

**Description:** Encapsular o acesso ao object storage num serviço reutilizável (API e worker), expondo as primitivas de multipart e de URL presigned.

**Technical actions:**

1. Criar `src/storage/storage.module.ts` + `src/storage/storage.service.ts` instanciando `S3Client` com `endpoint` + `forcePathStyle: true` a partir de `storage.config` (per `phase-03-videos/TD-03`).
2. Implementar as primitivas de multipart: `createMultipartUpload`, `getUploadPartUrls` (presign de `UploadPart`), `completeMultipartUpload`, `abortMultipartUpload` (per `phase-03-videos/TD-02`).
3. Implementar `getPresignedGetUrl(key, { attachment? })` para streaming e download (per `phase-03-videos/TD-07`), montando as chaves `videos/{public_id}/source.<ext>` e `thumbnails/{public_id}/thumb.jpg`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration: contra o MinIO do Compose — multipart init/complete, presign PUT/GET com upload/download real | `src/storage/storage.service.integration-spec.ts` |
| `StorageModule` | Unit: compilation | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.1 _(precisa do MinIO e da storage.config)_

**Acceptance criteria:**

- Uma URL presigned de `UploadPart` aceita o PUT de uma parte direto no MinIO sem passar pela API.
- `completeMultipartUpload` monta o objeto final e ele fica legível na chave `videos/{public_id}/source.<ext>`.
- Uma URL presigned GET com `attachment` responde com `Content-Disposition: attachment`.

---

### SI-03.4 — VideosService + produtor BullMQ

**Description:** Implementar a lógica de negócio dos vídeos: id público único, orquestração do upload (rascunho → completar/abortar) e enfileiramento do processamento.

**Technical actions:**

1. Criar `src/videos/videos.service.ts` com geração de `public_id` via `nanoid` + retry-on-conflict contra a constraint `unique` (espelhando o padrão de nickname de `channels`) (per `phase-03-videos/TD-06`).
2. Implementar `createDraft(channel, dto)` — persiste `Video` em `status = draft` e inicia o multipart via `StorageService`, retornando `publicId` + `uploadId` (per `phase-03-videos/TD-08`, `phase-03-videos/TD-02`).
3. Implementar `getPartUrls`, `completeUpload` (grava `source_key`, transiciona para `processing`, enfileira o job) e `abortUpload` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-08`).
4. Registrar `BullModule.forRoot` (conexão Redis via `queue.config`) + `registerQueue('process-video')` e o produtor `@InjectQueue('process-video')` com `attempts`/`backoff` (per `phase-03-videos/TD-01`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` | Unit: geração de `public_id` + retry em colisão (mock repo), transições de status (mock storage/queue) | `src/videos/videos.service.spec.ts` |
| `VideosService` | Integration: `createDraft`/`completeUpload` contra DB + MinIO reais, com job realmente enfileirado | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.2, SI-03.3

**Acceptance criteria:**

- `createDraft` persiste um vídeo em `status = draft` com `public_id` único de ~11 caracteres URL-safe.
- Uma colisão de `public_id` é reprocessada com um novo id, sem erro para o chamador.
- `completeUpload` deixa o vídeo em `status = processing` e um job `process-video` enfileirado com o `videoId`.

---

### SI-03.5 — Endpoints de upload (controller + module + DTOs)

**Description:** Expor o handshake de upload multipart via HTTP e montar o módulo de vídeos, restrito ao dono do canal.

**Route:** POST /videos
**Test Specs:** see `nestjs-project/specs/videos-upload.plan.md`

**Technical actions:**

1. Criar `src/videos/videos.module.ts` (`TypeOrmModule.forFeature([Video])` + `BullModule.registerQueue('process-video')` + `StorageModule`) e registrá-lo no `AppModule` (per `phase-03-videos/TD-01`).
2. Criar `src/videos/videos.controller.ts` com `POST /videos`, `POST /videos/:publicId/parts`, `POST /videos/:publicId/complete`, `POST /videos/:publicId/abort` conforme `### API Contracts` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-08`).
3. Criar os DTOs (`CreateVideoDto`, `RequestPartsDto`, `CompleteUploadDto`) com `class-validator` + decoradores `@nestjs/swagger` (per `phase-02-auth/TD-06`, `openapi-docs-nestjs/TD-01`).
4. Aplicar guard de autenticação + verificação de posse do canal, mapeando `403 FORBIDDEN_NOT_CHANNEL_OWNER` / `404 VIDEO_NOT_FOUND` conforme `### Authorization Matrix` e `### Error Catalog`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosModule` | Unit: compilation | `src/videos/videos.module.spec.ts` |

_E2E do fluxo de upload (init→parts→complete/abort, 401/403/404/409, wiring de `ValidationPipe`) são autorados por `/plan-test-specs`._

**Dependencies:** SI-03.4

**Acceptance criteria:**

- `POST /videos` autenticado como dono retorna `201` com `{ publicId, status: "draft", uploadId }`.
- `POST /videos` sem sessão retorna `401`.
- `POST /videos/:publicId/complete` sobre um upload já finalizado retorna `409 UPLOAD_ALREADY_FINALIZED`.
- `POST /videos/:publicId/parts` em vídeo de outro canal retorna `403 FORBIDDEN_NOT_CHANNEL_OWNER`.

---

### SI-03.6 — Endpoints de entrega (metadata + streaming + download)

**Description:** Entregar metadados, streaming e download via URLs presigned direto do storage, respeitando visibilidade (anônimo só vê `ready`) e exigindo autenticação no download.

**Route:** GET /videos/:publicId
**Test Specs:** see `nestjs-project/specs/videos-delivery.plan.md`

**Technical actions:**

1. Adicionar ao `VideosService`: `getPublicMetadata` (aplica visibilidade), `getStreamUrl` (presign GET, exige `status = ready`) e `getDownloadUrl` (presign GET com `attachment`) (per `phase-03-videos/TD-07`, `phase-03-videos/TD-08`).
2. Adicionar ao `VideosController`: `GET /videos/:publicId`, `GET /videos/:publicId/stream`, `GET /videos/:publicId/download` conforme `### API Contracts`.
3. Aplicar as regras de `### Authorization Matrix`: metadata/stream anônimos só para `ready` (senão `404 VIDEO_NOT_FOUND`); download exige autenticação (`401`); `409 VIDEO_NOT_READY` quando `status != ready`.
4. Documentar os três endpoints com decoradores `@nestjs/swagger` (per `openapi-docs-nestjs/TD-01`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` (delivery) | Integration: presign real, regra de `ready`, visibilidade por dono | `src/videos/videos.service.integration-spec.ts` (estender) |

_E2E de streaming/download (200 com URL presigned, `404`/`409`/`401`, visibilidade) são autorados por `/plan-test-specs`._

**Dependencies:** SI-03.5

**Acceptance criteria:**

- `GET /videos/:publicId/stream` de um vídeo `ready` retorna `200` com uma `url` presigned GET.
- `GET /videos/:publicId/stream` de um vídeo `processing` retorna `409 VIDEO_NOT_READY`.
- `GET /videos/:publicId/download` sem sessão retorna `401`.
- `GET /videos/:publicId` de um rascunho de terceiro retorna `404 VIDEO_NOT_FOUND` (não vaza existência).

---

### SI-03.7 — Infra: container do worker + bootstrap standalone

**Description:** Rodar o worker de vídeo como container separado da API, com FFmpeg instalado, bootando um contexto Nest standalone (sem servidor HTTP) que reaproveita entidades/serviços via DI.

**Technical actions:**

1. Criar `Dockerfile.worker` a partir da imagem base do projeto, instalando `ffmpeg`/`ffprobe` via apt (per `phase-03-videos/TD-04`, `phase-03-videos/TD-05`).
2. Criar o entrypoint `src/worker/main.ts` via `NestFactory.createApplicationContext(WorkerModule)` — `WorkerModule` importa apenas os providers de fila, storage, config e TypeORM (sem controllers/HTTP) (per `phase-03-videos/TD-04`).
3. Adicionar o serviço `video-worker` ao `compose.yaml` (build `Dockerfile.worker`, `depends_on` de `redis`/`minio`/`db`, mesmas variáveis de ambiente da API).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `WorkerModule` | Unit: compilation (`createApplicationContext` resolve os providers de fila/storage/db) | `src/worker/worker.module.spec.ts` |

**Dependencies:** SI-03.1, SI-03.4

**Acceptance criteria:**

- O container `video-worker` sobe e conecta na fila Redis sem expor porta HTTP.
- O worker resolve `StorageService` e o repositório de `Video` via DI (mesmo codebase da API).
- A imagem do worker tem `ffmpeg` e `ffprobe` disponíveis no PATH.

---

### SI-03.8 — Processamento FFmpeg + ciclo de status

**Description:** Consumir o job `process-video`, extrair duração/metadados e thumbnail via FFmpeg, persistir os resultados e conduzir o ciclo de status até `ready` ou `failed`.

**Technical actions:**

1. Criar `src/worker/video-processing.service.ts` — `ffprobe -v quiet -print_format json -show_format -show_streams` via `child_process` spawn, com parse do JSON para `duration_seconds` + `metadata` (per `phase-03-videos/TD-05`).
2. Extrair thumbnail (`ffmpeg -ss <t> -i <input> -frames:v 1 thumb.jpg`) e gravá-la em `thumbnails/{public_id}/thumb.jpg` via `StorageService` (per `phase-03-videos/TD-05`, `phase-03-videos/TD-03`).
3. Criar o `@Processor('process-video')` consumer: baixa o source, chama o processamento, persiste `duration_seconds`/`metadata`/`thumbnail_key` e transiciona `processing → ready` (só após tudo durável) (per `phase-03-videos/TD-04`, `phase-03-videos/TD-08`).
4. Implementar o tratamento de falha: com `attempts`/`backoff` esgotados, o job vai para dead-letter e o handler seta `status = failed` + `error_reason` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-08`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingService` | Unit: parse do JSON do ffprobe + construção de args (mock do boundary de spawn) | `src/worker/video-processing.service.spec.ts` |
| `process-video` consumer | Integration: job real contra Redis + MinIO + FFmpeg — `draft→ready` no caminho feliz e `→failed` com `error_reason` no caminho de falha | `src/worker/video-processing.integration-spec.ts` |

**Dependencies:** SI-03.7, SI-03.3, SI-03.4

**Acceptance criteria:**

- Após o processamento com sucesso, o vídeo fica `ready` com `duration_seconds`, `metadata` e `thumbnail_key` preenchidos.
- A thumbnail existe na chave `thumbnails/{public_id}/thumb.jpg` e é servível por presign GET.
- Um source inválido, esgotadas as tentativas, deixa o vídeo em `status = failed` com `error_reason` não nulo.
- Nenhum vídeo alcança `ready` com metadados ou thumbnail ausentes (sem estado parcial).

---

## Technical Specifications

### Data Model

#### Video

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated (convenção das entidades existentes `users`/`channels`) |
| public_id | varchar(16) | unique, not null — id curto URL-safe via `nanoid` (por `phase-03-videos/TD-06`) |
| channel_id | uuid | FK → `channels(id)`, not null, on delete cascade |
| title | varchar(255) | not null — informado no pré-cadastro rascunho |
| status | enum `videos_status_enum` | not null, default `draft` — valores `draft`, `processing`, `ready`, `failed` (por `phase-03-videos/TD-08`) |
| upload_id | varchar | nullable — `UploadId` do multipart S3 em andamento (por `phase-03-videos/TD-02`); limpo após complete/abort |
| source_key | varchar | nullable — chave do objeto de origem `videos/{public_id}/source.<ext>` (por `phase-03-videos/TD-03`); preenchida no complete |
| thumbnail_key | varchar | nullable — chave `thumbnails/{public_id}/thumb.jpg` (por `phase-03-videos/TD-03`); preenchida pelo worker |
| duration_seconds | int | nullable — extraída via `ffprobe` (por `phase-03-videos/TD-05`) |
| metadata | jsonb | nullable — metadados técnicos do `ffprobe` (codec, resolução, bitrate) (por `phase-03-videos/TD-05`) |
| error_reason | text | nullable — motivo do erro quando `status = failed` (por `phase-03-videos/TD-08`) |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | default now(), auto-update |

**Relations:** `Channel` has many `Video` (one-to-many); `Video` belongs to `Channel` via `channel_id`.
**Indexes:** unique on `public_id`; index on `channel_id`; index on `status` (consultas do worker e listagens por estado).
**Enum:** `videos_status_enum` criado na migration (padrão TypeORM já usado em `verification_tokens_type_enum` na Fase 02).

### API Contracts

Contrato REST do módulo de vídeos. Documentado via `@nestjs/swagger` (decoradores `@ApiOperation`/`@ApiResponse`/`@ApiBody`) seguindo `openapi-docs-nestjs/TD-01`. Envelope de erro herdado de `phase-02-auth/TD-07` (`{ statusCode, error, message }`).

#### POST /videos (SI-03.4)

Pré-cadastra o vídeo como rascunho e inicia o multipart upload no storage (por `phase-03-videos/TD-08` + `phase-03-videos/TD-02`).

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {access_token}

**Request body:**
- title: string, required — título do rascunho
- filename: string, required — nome original (define a extensão da `source_key`)
- contentType: string, required — MIME do vídeo (ex.: `video/mp4`)

**Response 201:**
- publicId: string — id curto do vídeo (`nanoid`)
- status: string — `draft`
- uploadId: string — `UploadId` do multipart S3

**Error responses:**
- 401 (não autenticado): sem sessão válida
- 400 validation error: corpo fora do schema

---

#### POST /videos/:publicId/parts (SI-03.4)

Retorna URLs presigned para envio das partes direto ao storage (por `phase-03-videos/TD-02`). O cliente sobe cada parte direto no MinIO/S3 — bytes nunca passam pela API.

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {access_token}

**Request body:**
- partNumbers: number[], required — números das partes que o cliente vai enviar

**Response 200:**
- parts: array de `{ partNumber: number, url: string }` — URL presigned `UploadPart` por parte

**Error responses:**
- 401 (não autenticado)
- 403 FORBIDDEN_NOT_CHANNEL_OWNER: vídeo pertence a outro canal
- 404 VIDEO_NOT_FOUND: `publicId` inexistente
- 409 UPLOAD_ALREADY_FINALIZED: upload já concluído/abortado

---

#### POST /videos/:publicId/complete (SI-03.4)

Conclui o multipart upload, grava a `source_key`, transiciona para `processing` e enfileira o job de processamento (por `phase-03-videos/TD-02` + `phase-03-videos/TD-08` + `phase-03-videos/TD-01`).

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {access_token}

**Request body:**
- parts: array de `{ partNumber: number, etag: string }`, required — partes retornadas pelo storage

**Response 200:**
- publicId: string
- status: string — `processing`

**Error responses:**
- 401 (não autenticado)
- 403 FORBIDDEN_NOT_CHANNEL_OWNER
- 404 VIDEO_NOT_FOUND
- 409 UPLOAD_ALREADY_FINALIZED: complete em upload já finalizado
- 409 INVALID_MULTIPART_STATE: partes ausentes/divergentes do `uploadId`

---

#### POST /videos/:publicId/abort (SI-03.4)

Aborta o multipart upload em andamento (por `phase-03-videos/TD-02`). Idempotente sobre rascunho não finalizado.

**Request headers:**
- Authorization: Bearer {access_token}

**Response 204:** No content.

**Error responses:**
- 401 (não autenticado)
- 403 FORBIDDEN_NOT_CHANNEL_OWNER
- 404 VIDEO_NOT_FOUND
- 409 UPLOAD_ALREADY_FINALIZED

---

#### GET /videos/:publicId (SI-03.6)

Metadados do vídeo. Anônimo só enxerga vídeos `ready`; dono enxerga qualquer estado do próprio vídeo.

**Response 200:**
- publicId: string
- title: string
- status: string — `draft` | `processing` | `ready` | `failed`
- durationSeconds: number | null
- thumbnailUrl: string | null — URL presigned GET da thumbnail quando `ready`
- channel: `{ nickname: string, name: string }`

**Error responses:**
- 404 VIDEO_NOT_FOUND: inexistente OU não visível ao solicitante (rascunho/processando de terceiro)

---

#### GET /videos/:publicId/stream (SI-03.6)

Autoriza a reprodução e devolve URL presigned GET curta para o cliente streamar direto do storage (Range/206 nativos), por `phase-03-videos/TD-07`. Anônimo permitido para vídeos `ready`.

**Response 200:**
- url: string — URL presigned `GetObject`, TTL curto

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_READY: `status != ready`

---

#### GET /videos/:publicId/download (SI-03.6)

Autoriza o download e devolve URL presigned GET com `response-content-disposition: attachment` (por `phase-03-videos/TD-07`). Requer usuário autenticado.

**Request headers:**
- Authorization: Bearer {access_token}

**Response 200:**
- url: string — URL presigned `GetObject` (attachment), TTL curto

**Error responses:**
- 401 (não autenticado)
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_READY

### Authorization Matrix

`Anonymous` = sem sessão · `Authenticated` = qualquer usuário logado · `Owner` = usuário dono do canal do vídeo. Guards herdados da Fase 02 (`phase-02-auth`).

| Endpoint | Anonymous | Authenticated | Owner |
|----------|-----------|---------------|-------|
| POST /videos | ✗ | ✗ | ✓ (cria no próprio canal) |
| POST /videos/:publicId/parts | ✗ | ✗ | ✓ |
| POST /videos/:publicId/complete | ✗ | ✗ | ✓ |
| POST /videos/:publicId/abort | ✗ | ✗ | ✓ |
| GET /videos/:publicId | ✓ (só `ready`) | ✓ (só `ready`; dono vê qualquer estado) | ✓ |
| GET /videos/:publicId/stream | ✓ (só `ready`) | ✓ (só `ready`) | ✓ |
| GET /videos/:publicId/download | ✗ | ✓ | ✓ |

**Regra de visibilidade:** vídeos em `draft`/`processing`/`failed` só são visíveis ao dono; para terceiros retornam `404 VIDEO_NOT_FOUND` (não vaza existência). Publicação/rascunho como fluxo de negócio é escopo da Fase 04 — aqui `ready` já é assistível por anônimo (plataforma de vídeo pública).

### Error Catalog

Envelope herdado de `phase-02-auth/TD-07`: `{ statusCode, error, message }` com `error` = código de domínio. Códigos novos desta fase:

| error | HTTP | Trigger |
|-------|------|---------|
| VIDEO_NOT_FOUND | 404 | `publicId` inexistente ou não visível ao solicitante |
| VIDEO_NOT_READY | 409 | stream/download de vídeo com `status != ready` |
| FORBIDDEN_NOT_CHANNEL_OWNER | 403 | upload/gestão de vídeo pertencente a outro canal |
| UPLOAD_ALREADY_FINALIZED | 409 | `parts`/`complete`/`abort` sobre upload já concluído ou abortado |
| INVALID_MULTIPART_STATE | 409 | `complete` sem partes válidas ou com `uploadId` divergente |

_Erros transversais herdados (não redefinidos aqui): `401` não autenticado e `400 validation error` (schema DTO via `class-validator`, `phase-02-auth/TD-06`)._ A falha de processamento não é erro HTTP de request — é refletida no `status = failed` do vídeo com `error_reason` (por `phase-03-videos/TD-08`).

### Events/Messages

Fila BullMQ sobre Redis (por `phase-03-videos/TD-01`). Um único tipo de job. Worker em container separado com FFmpeg (por `phase-03-videos/TD-04`).

#### process-video

**Payload:**

```json
{ "videoId": "uuid", "publicId": "string", "sourceKey": "string" }
```

**Producer:** `VideosService` no endpoint `POST /videos/:publicId/complete` (por `phase-03-videos/TD-02` → enfileira via `phase-03-videos/TD-01`)
**Consumer:** worker BullMQ (`NestFactory.createApplicationContext`, container dedicado, por `phase-03-videos/TD-04`)
**Trigger:** dispara na conclusão do multipart upload; o vídeo transiciona `draft → processing`
**Delivery semantics:** at-least-once — `attempts` + `backoff` do BullMQ; esgotadas as tentativas, o job vai para dead-letter (`failed` state), e o handler seta `status = failed` + `error_reason` no vídeo (por `phase-03-videos/TD-08`)

**Processamento (passos do consumer, por `phase-03-videos/TD-05` + `phase-03-videos/TD-03`):**
1. Lê o objeto de origem do storage (`source_key`).
2. `ffprobe -v quiet -print_format json -show_format -show_streams` → parse de `duration_seconds` + `metadata` (`child_process` spawn, por `phase-03-videos/TD-05`).
3. `ffmpeg -ss <t> -i <input> -frames:v 1 thumb.jpg` → extrai 1 frame como thumbnail.
4. Grava a thumbnail no storage (`thumbnail_key = thumbnails/{public_id}/thumb.jpg`).
5. Persiste `duration_seconds`, `metadata`, `thumbnail_key` e transiciona `processing → ready` (só após tudo durável — resultado parcial nunca aparece como `ready`).

**Consistência producer→broker:** com broker dedicado há gap potencial de dual-write entre o INSERT/UPDATE do vídeo e o enqueue (reconhecido em `phase-03-videos/TD-01`). Mitigação canônica (Transactional Outbox) fica como opção de implementação a revisitar se consistência estrita for exigida — fora do escopo mínimo da Fase 03.

---

## Dependency Map

```
SI-03.1 (root — infra: MinIO + Redis + config)
├── SI-03.3 — depends on SI-03.1 (storage precisa do MinIO/config)
│   └── SI-03.4 — depends on SI-03.2 + SI-03.3 (service usa entity + storage + fila)
│       ├── SI-03.5 — depends on SI-03.4 (endpoints de upload)
│       │   └── SI-03.6 — depends on SI-03.5 (endpoints de entrega)
│       ├── SI-03.7 — depends on SI-03.1 + SI-03.4 (worker container + fila)
│       │   └── SI-03.8 — depends on SI-03.7 + SI-03.3 + SI-03.4 (FFmpeg + ciclo de status)
│       └── (SI-03.8 também depende de SI-03.3)
└── (SI-03.7 também depende de SI-03.1)
SI-03.2 (root — entidade Video + migration; channels herdado da Fase 02)
```

---

## Deliverables

- [x] SI-03.1 — Infra: MinIO + Redis no Compose + config
- [x] SI-03.2 — Entidade `Video` + migration
- [x] SI-03.3 — Storage service (cliente S3 + presign)
- [x] SI-03.4 — VideosService + produtor BullMQ
- [x] SI-03.5 — Endpoints de upload (controller + module + DTOs)
- [x] SI-03.6 — Endpoints de entrega (metadata + streaming + download)
- [x] SI-03.7 — Infra: container do worker + bootstrap standalone
- [x] SI-03.8 — Processamento FFmpeg + ciclo de status

**Infra (Docker Compose):**

- [x] `docker compose up -d` sobe `nestjs-api`, `db`, `mailpit`, `minio`, `redis` e `video-worker` com status `running`.
- [x] Buckets `videos` e `thumbnails` criados automaticamente no MinIO.

**Full test suites** _(comandos rodam dentro do container, per `nestjs-project/CLAUDE.md`)_:

- [x] Testes unit + integração passam (`docker compose exec nestjs-api npm test -- --runInBand`).
- [x] Testes E2E passam (`docker compose exec nestjs-api npm run test:e2e`).
- [x] Type-check passa (`docker compose exec nestjs-api npx tsc --noEmit` — exit 0).
- [x] Lint passa (`docker compose exec nestjs-api npm run lint`).
