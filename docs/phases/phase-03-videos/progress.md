# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 4/8 completed

### SI-03.1 — Infra: MinIO + Redis no Compose + config
- **Status:** completed
- **Tests:** no tests (infra)
- **Observations:**
  - MinIO healthcheck usa `curl` contra `/minio/health/live`; bucket bootstrap via serviço one-shot `createbuckets` (image `minio/mc`) com `mc mb --ignore-existing`.
  - Configs novos (`storage`, `queue`) registrados no `ConfigModule.forRoot` load array de `app.module.ts`.
  - `STORAGE_ACCESS_KEY`/`STORAGE_SECRET_KEY` são `required` no Joi (sem default) para satisfazer o AC de boot-fail; demais chaves têm defaults.
  - Atualizei também o runtime `.env` (não versionado) além do `.env.example`, para o ambiente subir funcional.

### SI-03.2 — Entidade `Video` + migration
- **Status:** completed
- **Tests:** 6 passing (4 entity + 2 migration)
- **Observations:**
  - Migration `CreateVideos` gerada via TypeORM CLI (`migration:generate`); ajustei o `down` para `DROP TYPE IF EXISTS` do enum.
  - `timestamptz` para created_at/updated_at (per Data Model), diferente das entidades legadas que usam `timestamp` — sem impacto nos testes.
  - **Boot-bug pego ao subir a API:** adicionar `@OneToMany` em `Channel` apontando para `Video` quebra o boot (`Entity metadata for Channel#videos was not found`) porque `autoLoadEntities` só carrega entidades registradas via `forFeature`, e `VideosModule` só nasce na SI-03.5. Correção: mantive só o lado dono (`@ManyToOne` em `Video`, sem selector de inverse). Decisão consolidada na SI-03.4: o inverse `Channel.videos` **não é adicionado** (quebra contextos parciais de teste e não tem consumidor). App sobe limpo (HTTP 200).
  - **Fix (fora do escopo estrito da entidade, mas dentro do arquivo de teste estendido):** o `beforeAll` de `migrations.integration-spec.ts` usava `Promise.all` para os `DROP TABLE ... CASCADE`; com a FK `videos → channels` isso passou a deadlockar. Convertido para drop sequencial (uma conexão, ordem-independente com CASCADE).

### SI-03.3 — Storage service (cliente S3 + presign)
- **Status:** completed
- **Tests:** 4 passing (1 module compilation + 3 integração contra MinIO real)
- **Observations:**
  - Instalado `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` `^3.1079.0` (dentro da faixa `^3.0.0` do library-refs).
  - **Decisão de layout (ambiguidade do plano):** o Data Model escreve as chaves como `videos/{public_id}/source.<ext>` / `thumbnails/{public_id}/thumb.jpg`; interpretei isso como `<bucket>/<object-key>`. Ou seja: bucket `videos` + key `{public_id}/source.<ext>` (e bucket `thumbnails` + key `{public_id}/thumb.jpg`). `buildSourceKey`/`buildThumbnailKey` retornam o object-key (sem o prefixo do bucket); as colunas `source_key`/`thumbnail_key` guardarão esse object-key. Downstream (SI-03.4/03.6) consome os métodos do StorageService, então a consistência é garantida.
  - Métodos de get/put diretos (usados pelo worker para ler source e gravar thumbnail) NÃO entram aqui — ficam para a SI-03.8 (fora do escopo de "multipart + presign" da SI-03.3).
  - Multipart de parte única funciona no complete (a última/única parte não tem mínimo de 5MiB).

### SI-03.4 — VideosService + produtor BullMQ
- **Status:** completed
- **Tests:** 8 passing (5 unit + 3 integração DB+MinIO+Redis; sem open handles)
- **Observations:**
  - Instalado `nanoid@^3.3.15` (linha CommonJS, per pin do library-refs), `@nestjs/bullmq@^11.0.4`, `bullmq@^5.79.2`.
  - **VideosModule criado aqui (não na SI-03.5):** o service precisa de `forFeature([Video])` + `BullModule.forRootAsync`/`registerQueue`, então o módulo nasce nesta SI. A SI-03.5 vai só adicionar controller + DTOs a ele.
  - **Decisão final sobre a relação: SEM lado inverso `Channel.videos`.** Tentei restaurar o `@OneToMany`, mas a suíte completa mostrou que isso força `Video` a estar registrado em TODO contexto TypeORM que carrega `Channel` — quebrando ~10 specs de outros módulos que usam DataSources/módulos parciais (`Entity metadata for Channel#videos was not found`, 63 falhas). Nada no código consome a relação reversa; o lado dono `@ManyToOne(..., { onDelete: 'CASCADE' })` já garante FK + cascade. Boot validado end-to-end (HTTP 200, `VideosModule` + `BullModule` inicializados) e suíte completa verde (212 testes) sem o inverse.
  - **Regressão da SI-03.1 corrigida aqui:** `env.validation.integration-spec.ts` montava configs válidas sem `STORAGE_ACCESS_KEY`/`SECRET` (agora required) — adicionadas ao `requiredEnv` base do teste. Só apareceu ao rodar a suíte completa (DoD), não nos testes escopados da SI.
  - **`source_key` gravado no `createDraft`** (não no complete como diz a ação 3): a key é determinística (`{publicId}/source.<ext>`) e necessária para iniciar o multipart no draft; single source of truth. Estado final idêntico; ACs satisfeitos.
  - Domain exceptions de vídeo em `videos.exceptions.ts` estendendo `DomainException` (mapeadas pelo filtro herdado da Fase 02): VIDEO_NOT_FOUND, FORBIDDEN_NOT_CHANNEL_OWNER, UPLOAD_ALREADY_FINALIZED, INVALID_MULTIPART_STATE. VIDEO_NOT_READY fica para a SI-03.6.
  - Retry-on-collision do `public_id` sem transação (cada `save` é sua própria tx) — evita o problema de "transaction aborted" do SAVEPOINT; catch no unique-violation `23505`.

### SI-03.5 — Endpoints de upload (controller + module + DTOs)
- **Status:** pending
- **Tests:** —
- **Observations:**
  - `VideosModule` já foi criado na SI-03.4; aqui resta só adicionar `VideosController` + DTOs ao módulo existente e registrar o controller. (Sem relação inversa `Channel.videos` — decidido na SI-03.4.)

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
