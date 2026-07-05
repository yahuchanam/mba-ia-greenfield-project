---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-07-04T21:25:22-0300"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-04T21:00:40-0300"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-07-04T16:53:05-0300"
---

# Fase 03 — Upload e Processamento de Vídeos

## Objective

Entregar o pipeline de vídeos do backend (`nestjs-project`): armazenamento de objetos (MinIO/S3), fila de processamento em segundo plano (BullMQ + Redis) com worker FFmpeg em container separado, upload de até 10GB sem passar pela API (presigned multipart), pré-cadastro do vídeo como rascunho, processamento automático (duração/metadados + thumbnail), URL única por vídeo (`nanoid`), e entrega por streaming/download direto do storage (presigned GetObject).

---

## Step Implementations

<!-- SIs will be written in Phase B -->

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

<!-- phase-a-complete -->

## Dependency Map

<!-- Dep Map will be written in Phase B -->

---

## Deliverables

<!-- Deliverables will be written in Phase B -->
