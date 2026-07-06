# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 1/8 completed

### SI-03.1 — Infra: MinIO + Redis no Compose + config
- **Status:** completed
- **Tests:** no tests (infra)
- **Observations:**
  - MinIO healthcheck usa `curl` contra `/minio/health/live`; bucket bootstrap via serviço one-shot `createbuckets` (image `minio/mc`) com `mc mb --ignore-existing`.
  - Configs novos (`storage`, `queue`) registrados no `ConfigModule.forRoot` load array de `app.module.ts`.
  - `STORAGE_ACCESS_KEY`/`STORAGE_SECRET_KEY` são `required` no Joi (sem default) para satisfazer o AC de boot-fail; demais chaves têm defaults.
  - Atualizei também o runtime `.env` (não versionado) além do `.env.example`, para o ambiente subir funcional.

### SI-03.2 — Entidade `Video` + migration
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.3 — Storage service (cliente S3 + presign)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.4 — VideosService + produtor BullMQ
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.5 — Endpoints de upload (controller + module + DTOs)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.6 — Endpoints de entrega (metadata + streaming + download)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.7 — Infra: container do worker + bootstrap standalone
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.8 — Processamento FFmpeg + ciclo de status
- **Status:** pending
- **Tests:** —
- **Observations:** none
