# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 3/8 completed

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
  - **Boot-bug pego ao subir a API:** adicionar `@OneToMany` em `Channel` apontando para `Video` quebra o boot (`Entity metadata for Channel#videos was not found`) porque `autoLoadEntities` só carrega entidades registradas via `forFeature`, e `VideosModule` só nasce na SI-03.5. Correção: mantive só o lado dono (`@ManyToOne` em `Video`, sem selector de inverse) e deixei o `@OneToMany` reverso em `Channel` para a SI-03.5 (quando `Video` estiver registrado). App agora sobe limpo (HTTP 200).
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
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.5 — Endpoints de upload (controller + module + DTOs)
- **Status:** pending
- **Tests:** —
- **Observations:**
  - Ao criar o `VideosModule` (com `TypeOrmModule.forFeature([Video])`), adicionar o lado inverso `@OneToMany(() => Video, (v) => v.channel) videos: Video[]` em `Channel` e o selector de inverse no `@ManyToOne` do `Video` (deixado de fora na SI-03.2 para não quebrar o boot).

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
