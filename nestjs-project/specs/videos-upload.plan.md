---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.5
target_file: nestjs-project/test/videos-upload.e2e-spec.ts
---

# Endpoint Test Plan — Upload de Vídeos (multipart presigned)

## Application Overview

O fluxo de upload pré-cadastra o vídeo como rascunho e conduz um multipart upload presigned direto ao storage: `POST /videos` inicia (draft + `uploadId`), `POST /videos/:publicId/parts` devolve URLs presigned por parte, `POST /videos/:publicId/complete` conclui e enfileira o processamento, e `POST /videos/:publicId/abort` cancela. Todos os endpoints exigem o dono do canal; os bytes nunca passam pela API. Estes cenários exercem o contrato HTTP (status, corpo e códigos de erro de domínio), não o storage real — a integração com MinIO é coberta inline no SI-03.3/SI-03.4.

## Test Scenarios

### 1. Criação de rascunho (POST /videos)

**Setup:** `beforeEach` trunca as tabelas de teste e semeia um usuário autenticado dono de um canal; bootstrap do módulo Nest via `Test.createTestingModule` reproduzindo a config global (`ValidationPipe`, exception filter) de `main.ts`.

#### 1.1. cria-rascunho-e-inicia-multipart

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-05T01:30:00Z

**Steps:**
  1. POST /videos autenticado como dono do canal com body `{ title, filename, contentType }` válido
    - expect: status `201`
    - expect: corpo contém `publicId` (string ~11 chars URL-safe), `status: "draft"` e `uploadId`
    - expect: existe uma linha em `videos` com esse `public_id`, `status = draft` e `channel_id` do dono

#### 1.2. rejeita-sem-sessao

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-05T01:30:00Z

**Steps:**
  1. POST /videos sem header `Authorization` com body válido
    - expect: status `401`
    - expect: nenhum vídeo é criado no banco

#### 1.3. rejeita-body-invalido

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-05T01:30:00Z

**Steps:**
  1. POST /videos autenticado com body faltando `title`
    - expect: status `400`
    - expect: corpo segue o envelope `{ statusCode, error, message }`

### 2. Progresso e conclusão do upload

**Setup:** além do setup base, semeia um vídeo rascunho do próprio canal com `uploadId` em andamento; para cenários de posse, semeia também um segundo canal/usuário.

#### 2.1. complete-em-upload-ja-finalizado

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-05T01:30:00Z

**Steps:**
  1. POST /videos/:publicId/complete no vídeo cujo upload já foi concluído/abortado, com body `{ parts }`
    - expect: status `409`
    - expect: `error: "UPLOAD_ALREADY_FINALIZED"`

#### 2.2. parts-em-video-de-outro-canal

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-07-05T01:30:00Z

**Steps:**
  1. POST /videos/:publicId/parts autenticado como um usuário que NÃO é dono do canal do vídeo, com `{ partNumbers }`
    - expect: status `403`
    - expect: `error: "FORBIDDEN_NOT_CHANNEL_OWNER"`
