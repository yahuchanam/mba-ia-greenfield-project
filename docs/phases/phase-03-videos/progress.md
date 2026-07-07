# phase-03-videos — Progress

**Status:** completed
**SIs:** 8/8 completed

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
- **Status:** completed
- **Tests:** 6 passing (1 module compilation + 5 E2E: 201/401/400/409/403)
- **Observations:**
  - `VideosModule` já existia (SI-03.4); aqui adicionei `VideosController` + 3 DTOs e importei `ChannelsModule`.
  - **Guard:** nada de `@UseGuards` — o `JwtAuthGuard` é global (`APP_GUARD`), rotas protegidas por padrão; 401 sem sessão é automático. `@ApiBearerAuth('access-token')` no controller.
  - **Resolução de canal:** adicionei `ChannelsService.findByUserId(userId)`; o controller resolve o canal do usuário autenticado (via `@CurrentUser().sub`) e passa `channel.id` ao `VideosService`. Helper privado `resolveChannelId` lança `NotChannelOwnerException` se (defensivamente) não houver canal — todo usuário registrado tem um (`createUserWithChannel` no register da Fase 02).
  - **Status codes:** POST /videos → 201 (default); /parts e /complete → `@HttpCode(200)`; /abort → `@HttpCode(204)`.
  - **E2E do cenário "complete em upload finalizado":** usei `abort` (204, não precisa de ETags reais) para finalizar o upload antes do `complete` → 409 `UPLOAD_ALREADY_FINALIZED`.
  - OpenAPI: cada handler com `@ApiOperation` + `@ApiResponse` por status, erros via `getSchemaPath(ApiErrorEnvelope)` (envelope compartilhado).
  - **Bug latente de infra pego na suíte completa:** `test:e2e` rodava `jest` SEM `--runInBand`, então as suítes E2E rodavam em paralelo compartilhando o mesmo DB. Meu suite (register→login, precisa do user persistir) corria com o `cleanAllTables` do `auth.e2e` → user truncado no meio → 401. As 3 suítes antigas conviviam porque só `auth.e2e` mexia em users. Corrigido adicionando `--runInBand` ao script `test:e2e` (alinha com a regra documentada do projeto). Isoladamente o suite já passava; só a suíte completa expôs a corrida.

### SI-03.6 — Endpoints de entrega (metadata + streaming + download)
- **Status:** completed
- **Tests:** 12 (integração: 2 upload + 6 delivery com presign/fetch real contra MinIO; E2E delivery: 4)
- **Observations:**
  - Métodos no `VideosService`: `getPublicMetadata(publicId, requesterChannelId?)`, `getStreamUrl`, `getDownloadUrl`. Nova exceção `VideoNotReadyException` (409 VIDEO_NOT_READY).
  - **Visibilidade:** só o `getPublicMetadata` aplica visibilidade por dono (não-ready de terceiro → 404, não vaza). `stream`/`download` são status-based: não-ready → 409 (per Error Catalog). Metadata carrega `channel` via `relations: ['channel']` (lado dono do ManyToOne).
  - **Optional-auth descartado:** cheguei a criar um `OptionalJwtAuthGuard` para o dono ver o próprio rascunho via HTTP, mas isso forçava `VideosModule` a importar o `AuthModule` inteiro (JWT/mail/users config), inflando o teste de compilação do módulo. Como o plano só exige anônimo→404 no HTTP (ação 3) e a visibilidade-por-dono é capacidade de serviço (coberta pelo teste de integração), mantive `GET /videos/:publicId` como `@Public` anônimo. Guard removido (sem código morto).
  - `metadata`/`stream` são `@Public`; `download` é protegido (guard global → 401 sem sessão). Movi `@ApiBearerAuth` do nível de classe para por-método (rotas `@Public` não podem anunciar bearer, per regra de controllers).
  - `stream`/`download` presign a `source_key`; download com `attachment` + filename derivado da extensão.

### SI-03.7 — Infra: container do worker + bootstrap standalone
- **Status:** completed
- **Tests:** 1 passing (compilação do `WorkerModule` contra Postgres+Redis reais, sem HTTP)
- **Observations:**
  - `WorkerModule` é autossuficiente: própria `ConfigModule.forRoot` (mesmo load array + `envValidationSchema` da API) + `TypeOrmModule.forRootAsync` + `BullModule.forRootAsync`/`registerQueue`. O standalone context não herda o graph do `AppModule`, então tudo é re-declarado.
  - Boot via `NestFactory.createApplicationContext(WorkerModule)` em `src/worker/main.ts` (sem servidor HTTP); `enableShutdownHooks` para drain/close limpo. A conexão BullMQ segura o event loop, mantendo o processo vivo mesmo antes de existir `@Processor` (que entra na SI-03.8).
  - **Bug pego pelo teste:** `forFeature([Video])` sozinho fazia o TypeORM entrar em loop de retry de conexão (~30s até falhar) com `Entity metadata for Video#channel was not found` — o worker não importa `AuthModule`/`ChannelsModule`/`UsersModule`, então o fecho de metadata da relação `Video → Channel ⟷ User` não existia. Fix: `forFeature([Video, Channel, User])` (Channel/User só para fechar o metadata; o worker não usa os repositórios deles). Esse hang era a causa do jest não emitir resultado antes do timeout.
  - `Dockerfile.worker` = base `node:25.6.0-slim` + `apt install ffmpeg` (traz `ffmpeg` e `ffprobe`, ambos em `/usr/bin`); só a imagem do worker carrega os binários (API fica lean, per TD-04/TD-05). Serviço `video-worker` no `compose.yaml` (mesmo volume/env da API, `depends_on` db/minio/redis, **sem porta exposta**). Idle via `tail` como o `nestjs-api`; boot manual via `npm run start:worker:dev`.
  - Scripts npm adicionados: `start:worker` / `start:worker:dev` / `start:worker:prod` (`nest start --entryFile worker/main`).
  - Validação de infra fora do teste: imagem buildou, `which ffmpeg/ffprobe` OK, container `video-worker` sobe (`Up`, PORTS vazio).

### SI-03.8 — Processamento FFmpeg + ciclo de status
- **Status:** completed
- **Tests:** 10 unit (`video-processing.service.spec.ts` — args + parse ffprobe + boundary de spawn mockado) + 2 integração (`video-processing.integration-spec.ts` — job real contra Redis+MinIO+FFmpeg+Postgres: `processing→ready` com duração/metadata/thumbnail e `→failed` com `error_reason`)
- **Observations:**
  - `VideoProcessingService` dirige ffprobe/ffmpeg via `child_process.spawn` direto (TD-05, Opção B — zero deps). Seams puros expostos para unit test: `buildFfprobeArgs`, `buildThumbnailArgs`, `parseProbe`; o método privado `run(cmd, args)` é o único boundary de spawn (mockado via `jest.mock('node:child_process')`).
  - **Source baixado para arquivo temporário** (`mkdtemp` + `pipeline(Body, createWriteStream)`), não bufferizado em memória — vídeos podem ter até 10GB (TD-02). `workDir` sempre limpo no `finally`.
  - Dois métodos novos no `StorageService` (a "parte get/put direta" deferida na SI-03.3): `downloadToFile(key, dest)` (GET do bucket `videos` → arquivo) e `putThumbnail(key, buffer)` (PUT no bucket `thumbnails`, `ContentType: image/jpeg`). Bucket routing fica dentro do StorageService (single responsibility), consistente com o resto da classe.
  - **Ciclo de status (TD-08):** `ready` só é escrito via load-mutate-`save` depois que thumbnail está no storage e metadata persistida — nunca há estado parcial `ready`. Usei `save` (não `update`) no ready porque o `QueryDeepPartialEntity` do TypeORM rejeita o objeto jsonb `metadata` no `.update()`; `save` é também o padrão do `VideosService`.
  - **`@Processor('process-video')` (`VideoProcessor extends WorkerHost`)** registrado como provider no `WorkerModule`. Tratamento de falha via `@OnWorkerEvent('failed')` com guarda `job.attemptsMade >= job.opts.attempts` — `failed` + `error_reason` escritos **uma única vez**, só quando as tentativas se esgotam (dead-letter); enquanto há retries, o vídeo fica em `processing`.
  - **FFmpeg só existe na imagem do worker (TD-05):** o integration-spec é auto-gated por `spawnSync('ffprobe'/'ffmpeg', ['-version']).status === 0` → `describe.skip` no container `nestjs-api` (lean, sem ffmpeg) e roda de verdade no container `video-worker`. Por isso a validação completa roda a suíte unit+integração no `nestjs-api` (o spec do worker aparece como `skipped`) **e** o integration-spec do worker no `video-worker` (2/2 passando contra ffmpeg+redis+minio+pg reais).
  - **DoD:** unit+integração no `nestjs-api` = 31 suites / 177 pass / 2 skipped (o worker integration, gated); integração do worker no `video-worker` = 2/2 pass; e2e = 61/61; `tsc --noEmit` = 0; `lint` = 0 errors (40 warnings pré-existentes em specs de auth/channels/mail).
