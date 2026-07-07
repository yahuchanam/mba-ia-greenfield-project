---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.6
target_file: nestjs-project/test/videos-delivery.e2e-spec.ts
---

# Endpoint Test Plan — Entrega de Vídeos (metadata, streaming, download)

## Application Overview

Os endpoints de entrega expõem metadados e autorizam a reprodução/baixa via URLs presigned direto do storage: `GET /videos/:publicId` devolve metadados (respeitando visibilidade), `GET /videos/:publicId/stream` devolve uma URL presigned GET curta (anônimo permitido só para `ready`), e `GET /videos/:publicId/download` devolve uma URL presigned com `attachment` (exige autenticação). Estes cenários exercem o contrato HTTP e as regras de visibilidade/estado; a assinatura real de URLs contra o MinIO é coberta inline no SI-03.6.

## Test Scenarios

### 1. Streaming (GET /videos/:publicId/stream)

**Setup:** `beforeEach` trunca as tabelas de teste; bootstrap do módulo Nest via `Test.createTestingModule` reproduzindo a config global de `main.ts`. Semeia vídeos em estados variados (`ready`, `processing`) ligados a um canal.

#### 1.1. stream-de-video-ready-retorna-url

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-05T01:30:00Z

**Steps:**
  1. GET /videos/:publicId/stream (anônimo) de um vídeo em `status = ready`
    - expect: status `200`
    - expect: corpo contém `url` (string, URL presigned GET)

#### 1.2. stream-de-video-processing-retorna-409

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-05T01:30:00Z

**Steps:**
  1. GET /videos/:publicId/stream de um vídeo em `status = processing`
    - expect: status `409`
    - expect: `error: "VIDEO_NOT_READY"`

### 2. Download (GET /videos/:publicId/download)

**Setup:** além do setup base, semeia um vídeo `ready` e um usuário autenticado.

#### 2.1. download-sem-sessao-retorna-401

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-05T01:30:00Z

**Steps:**
  1. GET /videos/:publicId/download sem header `Authorization` de um vídeo `ready`
    - expect: status `401`
    - expect: nenhuma URL presigned é retornada

### 3. Metadados e visibilidade (GET /videos/:publicId)

**Setup:** semeia um vídeo em `status = draft` pertencente a um canal de OUTRO usuário; o solicitante é anônimo ou um terceiro autenticado.

#### 3.1. rascunho-de-terceiro-retorna-404

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-07-05T01:30:00Z

**Steps:**
  1. GET /videos/:publicId de um rascunho pertencente a outro canal (solicitante não-dono)
    - expect: status `404`
    - expect: `error: "VIDEO_NOT_FOUND"` (não vaza a existência do rascunho)
