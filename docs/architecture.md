# Architecture Decision Record — MVP

## Contexto

A IoT Platform API será um domínio independente do SGM. O banco IoT não compartilha tabelas nem chaves estrangeiras com o banco do SGM. A integração ocorre por HTTP entre backends.

## Decisões

### ADR-001 — API REST no primeiro MVP

Usar HTTPS/REST entre ESP32 e API. O dispositivo envia heartbeat/eventos e consulta comandos pendentes por polling. MQTT fica fora do primeiro marco para reduzir componentes operacionais. Reavaliar quando latência, volume ou comunicação bidirecional justificarem um broker.

### ADR-002 — Persistência no PostgreSQL

PostgreSQL/Neon será a fonte persistente de eventos, comandos e configurações. Não armazenar estado de negócio apenas na memória de funções serverless.

### ADR-003 — Execução local de agendamentos críticos

A API distribui configurações e registra resultados. O ESP32 mantém uma cópia local dos agendamentos necessários e os executa mesmo sem internet. O relógio deve ser sincronizado e a política para perda de sincronismo deve ser explícita.

### ADR-004 — Comando não equivale a confirmação física

Manter estados distintos para solicitação, entrega, confirmação de recebimento e resultado de execução. A confirmação de que a iluminação realmente está ligada exige sensor/feedback independente do estado lógico do GPIO ou do relé.

## Limites de confiança

- ESP32 autentica com credencial operacional individual, revogável e armazenada como hash no servidor.
- Backend do SGM autentica na integração por Client ID e Client Secret próprios; não reutiliza tokens de usuários humanos nem `CRON_SECRET`.
- Frontend do SGM não recebe credenciais de integração nem credenciais dos dispositivos.
- Cada dispositivo só pode consultar comandos e enviar eventos em seu próprio escopo.
- Todas as rotas validam payloads e limites de tamanho.

## Autenticação e autorização — proposta arquitetural consolidada

Esta seção registra a proposta consolidada para o MVP; as decisões explicitamente pendentes continuam aguardando aprovação. **Ainda não está implementada**: o Express expõe somente `GET /health`, e os modelos abaixo exigirão aprovação e migrations antes de serem adicionados ao Prisma.

### Identidades e credenciais

- O SGM autentica a integração usando Client ID e Client Secret aleatório, com pelo menos 32 bytes de entropia. O Client ID identifica a integração; cada credencial também possui um identificador público para permitir a sobreposição de chaves na rotação. O segredo é apresentado uma única vez na emissão e nunca é armazenado em texto puro.
- O ESP32 autentica com uma credencial operacional opaca e individual. `deviceId` e `deviceUid` são identificadores, não credenciais. A identidade do dispositivo é derivada da credencial validada, nunca de um ID enviado no body ou query.
- Segredos aleatórios de alta entropia são armazenados como SHA-256 e comparados em tempo constante. O uso de HMAC com pepper permanece uma opção de defesa adicional, não uma decisão do MVP.
- Credenciais SGM e ESP32 não terão expiração automática no MVP. A validade SGM será mantida por rotação controlada; a credencial ESP32 só deixa de autenticar por revogação, além do bloqueio operacional enquanto o dispositivo estiver `DISABLED`.
- Na rotação SGM, as credenciais antiga e nova podem coexistir por até 24 horas. A antiga pode ser revogada antes desse limite e, após revogada, nunca autentica novamente. O segredo nunca é armazenado em texto puro.
- Todas as credenciais trafegam somente por HTTPS. JWTs de usuários humanos do SGM, `CRON_SECRET` e usuários técnicos fictícios não são reutilizados.
- O SGM continua responsável por autenticar usuários humanos e aplicar seu RBAC. A IoT API autentica o serviço SGM. Um identificador humano enviado pelo SGM é apenas metadado de auditoria, não prova de identidade para a IoT API.
- A primeira credencial SGM é criada por processo operacional controlado, fora de endpoints públicos. O segredo é entregue uma vez ao SGM e seu hash é persistido na IoT API. A administração de integrações não é um endpoint público do MVP.
- A arquitetura deve manter a identidade de serviço desacoplada do formato atual da credencial, permitindo futura adoção de OAuth 2.0 Client Credentials sem reutilizar JWT humano.

### Autorização SGM

O cliente de serviço possui scopes globais e grants por loja. Para uma operação que exige um ou mais scopes em uma loja, a permissão efetiva é a interseção:

```text
scopesEfetivos = scopesGlobaisDoCliente ∩ scopesConcedidosParaALoja
```

Todos os scopes exigidos pela operação devem estar nessa interseção, e o cliente precisa ter um grant explícito para a loja. Um grant não amplia os scopes globais. A API determina a loja do dispositivo pelo relacionamento persistido `Device → Sector → Store`; não confia no `storeId` da URL para decidir o escopo do recurso.

Exemplos:

- Scopes globais `{devices:read, commands:create}` e grant da Loja A `{devices:read}` permitem consultar dispositivos da Loja A, mas não criar comandos nela.
- Mesmo com `commands:create` global, a ausência de grant para a Loja B nega comandos destinados a dispositivos dessa loja.
- Se a URL indicar Loja A, mas o dispositivo pertencer à Loja B, a autorização é avaliada contra a Loja B e negada sem grant correspondente.

Scopes planejados incluem `stores:read`, `sectors:read`, `devices:read`, `devices:create`, `devices:provision`, `devices:activate`, `devices:disable`, `commands:create`, `commands:read`, `events:read` e `credentials:revoke`. Os nomes e a granularidade finais ainda dependem da matriz de endpoints aprovada. Não usar wildcard no MVP.

### Estados operacionais e credenciais ESP32

- `PROVISIONING` não pode fazer polling nem executar comandos. O endpoint de enrollment é uma exceção controlada pelo token de uso único; não permite cadastro público de dispositivos.
- `ACTIVE` pode fazer polling, ACK, informar resultados e enviar eventos, sempre usando a identidade do próprio dispositivo.
- `DISABLED` bloqueia polling, ACK, resultados e ingestão de eventos mesmo que a credencial ainda esteja válida.
- Desativação operacional não revoga automaticamente credenciais. Para perda, comprometimento ou substituição, a revogação é explícita e irreversível. Novo provisionamento emite uma nova credencial.
- Ativação é uma transição administrativa explícita e validada, não uma atualização genérica de status. Um dispositivo pode ser reativado com a credencial anterior se ela continuar válida e não revogada; credencial revogada exige novo enrollment e emissão de outra credencial.

### Enrollment idempotente

O dispositivo começa em `PROVISIONING`. O SGM solicita um token de enrollment vinculado ao dispositivo existente; a transferência é feita por configuração serial controlada durante a instalação. O token não cria dispositivos e não deve aparecer em logs, histórico do terminal ou artefatos da instalação.

O enrollment tem validade padrão de 24 horas, configurável por variável de ambiente ou configuração centralizada. O prazo calculado deve ser persistido em `expiresAt`. Enrollment expirado não pode ser consumido pela primeira vez. A validade configurável não altera a idempotência após consumo descrita abaixo.

1. O ESP32 gera 32 bytes de segredo operacional usando fonte criptográfica adequada ao modelo e firmware. Não usar `random()`, MAC, relógio ou outra fonte previsível.
2. O ESP32 persiste o segredo de forma durável antes de enviar a requisição, para poder repetir a operação se a resposta se perder.
3. O ESP32 envia token de enrollment e segredo por HTTPS.
4. A API calcula e persiste somente os hashes. O consumo do enrollment, a criação da credencial e a auditoria obrigatória ocorrem na mesma transação.
5. O registro `DeviceEnrollment.consumedCredentialId` aponta para a credencial criada. Uma repetição com o mesmo token e o mesmo segredo compara o hash recebido com o hash dessa credencial e retorna sucesso idempotente, sem criar outra credencial nem retornar o segredo.
6. Reutilizar o token com segredo diferente resulta em conflito, sem criar ou substituir credencial. Credencial revogada nunca é reativada por repetição.
7. A expiração limita o primeiro consumo. Uma repetição idêntica após a expiração pode apenas confirmar o consumo anterior; não pode criar uma nova credencial.

O consumo bloqueia a linha do enrollment e revalida token, estado e expiração dentro da transação. `consumedAt` e `consumedCredentialId` são gravados atomicamente com a credencial. Uma segunda requisição concorrente espera pela primeira e então segue a regra de hash idêntico ou conflito. Se a criação da credencial ou a auditoria obrigatória falhar, a transação inteira é revertida.

Um token interceptado pode disputar o primeiro consumo. A transferência serial controlada e a ativação somente após verificação operacional limitam o impacto; o dispositivo deve continuar sem acesso a comandos enquanto estiver em `PROVISIONING`. Secure Boot e proteção de flash/NVS são mitigadores contra extração física, não garantias absolutas, especialmente em ESP32 sem secure element. A fonte de entropia deve ser validada para o modelo concreto e a versão do ESP-IDF adotados ([documentação ESP-IDF sobre RNG](https://docs.espressif.com/projects/esp-idf/en/latest/esp32/api-reference/system/random.html)).

### Modelo de dados proposto — ainda não incluído no Prisma

Todos os relacionamentos físicos propostos usam UUID e `ON DELETE RESTRICT`; credenciais e clientes são desativados/revogados, não apagados. Os tipos e nomes finais devem ser validados antes da migration.

| Modelo | Campos e constraints propostos |
|---|---|
| `ServiceClient` | `id UUID`; `clientId String @unique`; `name String`; `status` (`ACTIVE`/`DISABLED`); `scopes String[]`; `createdAt`, `updatedAt Timestamptz(3)`. Um cliente tem várias credenciais e grants. |
| `ServiceCredential` | `id UUID` público; `serviceClientId UUID`; `secretHash String @unique`; `createdAt Timestamptz(3)`; `expiresAt Timestamptz(3)?`; `revokedAt Timestamptz(3)?`; `lastUsedAt Timestamptz(3)?`. FK para `ServiceClient`; índice por cliente e validade/revogação. Sem expiração automática inicial; o cliente pode ter mais de uma credencial ativa durante a rotação de até 24 horas. |
| `ServiceStoreGrant` | `serviceClientId UUID`; `storeId UUID`; `scopes String[]`; timestamps. Chave primária composta `(serviceClientId, storeId)` e FKs para `ServiceClient` e `Store`. |
| `DeviceCredential` | `id UUID` público; `deviceId UUID`; `secretHash String @unique`; `createdAt Timestamptz(3)`; `expiresAt Timestamptz(3)?`; `revokedAt Timestamptz(3)?`; `lastUsedAt Timestamptz(3)?`. FK para `Device`; índice por dispositivo e validade/revogação. Sem expiração automática no MVP; `revokedAt` é monotônico. |
| `DeviceEnrollment` | `id UUID`; `deviceId UUID`; `tokenHash String @unique`; `expiresAt Timestamptz(3)` obrigatório, com padrão de 24 horas configurável; `consumedAt Timestamptz(3)?`; `consumedCredentialId UUID? @unique`; `revokedAt Timestamptz(3)?`; `createdByServiceClientId UUID?`. FKs para `Device`, credencial consumida e, se informado, `ServiceClient`. Cada enrollment aponta para zero ou uma credencial; uma credencial não pode estar associada a mais de um enrollment. |
| `SecurityAuditEvent` | `id UUID`; `occurredAt Timestamptz(3)`; `actorType`, `actorId`, `action`, `outcome`; `resourceType?`, `resourceId?`, `reasonCode?`, `requestId?`; `metadata Json?` limitado e sem segredos. Índices por tempo, actor e recurso. Registro append-only, sem FKs a recursos cuja remoção/desativação não deve apagar o histórico. |

Uma migration futura deve incluir `CHECK` garantindo que `consumedAt` e `consumedCredentialId` sejam ambos nulos ou ambos preenchidos. A aplicação também valida que a credencial vinculada pertence ao mesmo dispositivo. `lastUsedAt` será opcional e atualizado de forma limitada/amostrada para não criar uma escrita por requisição. As credenciais SGM e ESP32 não expiram automaticamente no MVP; `expiresAt` permanece nullable para permitir evolução futura sem presumir essa política agora.

### Auditoria append-only

`SecurityAuditEvent` é separado de `DeviceEvent`. A política para operações críticas é **Fail-Closed**: a auditoria obrigatória e a alteração correspondente são gravadas na mesma transação; se a auditoria falhar, a transação reverte. A auditoria obrigatória inclui emissão, consumo e revogação de enrollment; emissão, rotação e revogação de credenciais; criação, alteração e revogação de grants; ativação e desativação de dispositivos; e operações administrativas de segurança.

Não exigir uma escrita na tabela de auditoria para cada autenticação bem-sucedida. `lastUsedAt` é atualizado de forma amostrada ou controlada. Tentativas negadas e suspeitas seguem política própria de logs/métricas, com limites de volume e sem credenciais; não são gravadas individualmente em `SecurityAuditEvent`. Nunca registrar segredos, hashes ou headers `Authorization`.

- A camada de aplicação oferece somente inserção.
- O usuário PostgreSQL de runtime deve ter `SELECT` e `INSERT`, sem `UPDATE` ou `DELETE`. O usuário de migrations conserva permissões DDL.
- Trigger que rejeita `UPDATE`/`DELETE` é alternativa se a separação de usuários não for possível; não é adotada antes dessa confirmação.
- Auditoria obrigatória e operação crítica são gravadas na mesma transação (Fail-Closed). Falha ao gravar auditoria reverte a operação.
- A possibilidade de separar os usuários na Neon e no PostgreSQL local permanece pendente.

### Rate limiting — política aprovada, mecanismo pendente

O rate limiting deve usar chaves que identificam a origem sem expor segredos:

- Enrollment: por endereço IP.
- ESP32: por identificador público da credencial.
- SGM: por identificador público da credencial.

O segredo nunca é chave de rate limiting. Limites devem ser configuráveis por rota ou categoria de operação. Como a API será executada em ambiente serverless, o limitador não pode depender de memória local: requer armazenamento compartilhado e operações atômicas. A tecnologia e os limites concretos serão definidos na etapa de implantação; Redis/KV não são escolhidos nesta especificação.

### Concorrência e ordem de locks proposta

| Operação | Ordem de locks |
|---|---|
| SGM sobre recurso de loja | `ServiceClient` → `ServiceCredential` → `ServiceStoreGrant` → dispositivo/recurso → comando/evento |
| Emissão de enrollment pelo SGM | `ServiceClient` → `ServiceCredential` → `ServiceStoreGrant` → `Device` → `DeviceEnrollment` |
| ESP32 operacional | `Device` → `DeviceCredential` → comando/evento |
| Desativação comum | `Device` em lock exclusivo; credenciais não são revogadas automaticamente |
| Revogação de credencial ESP32 | `Device` → `DeviceCredential` em lock exclusivo |
| Revogação de credencial SGM | `ServiceClient` → `ServiceCredential` em lock exclusivo |
| Alteração de grants | `ServiceClient` em lock exclusivo → grants em ordem determinística |
| Consumo de enrollment | `Device` → `DeviceEnrollment` em lock exclusivo → cria/valida credencial |

Operações críticas mantêm locks compartilhados nos registros que autorizam a operação; revogações e alterações administrativas usam locks exclusivos, na mesma ordem. Quem obtiver os locks primeiro pode concluir antes da alteração. Após o commit de desativação ou revogação, novas operações são negadas; não há cancelamento retroativo de transações já em andamento. O protocolo deve ser validado com testes concorrentes PostgreSQL e monitoramento de deadlocks.

A emissão de enrollment exige autenticação válida do SGM, scope efetivo de provisionamento e grant para a loja do dispositivo. A loja é determinada pelo relacionamento persistido `Device → Sector → Store`, e a emissão só é permitida quando o dispositivo está em `PROVISIONING`. A criação do enrollment e o registro obrigatório de auditoria ocorrem na mesma transação. Essa operação segue a ordem global de locks acima e é distinta do consumo do enrollment pelo ESP32, descrito em `Enrollment idempotente`.

### Endpoints planejados — não implementados

Administração inicial de integrações permanece operacional e fora da API. Endpoints de negócio futuros:

**SGM:**

- `POST /v1/sgm/devices/:deviceId/enrollments`
- `POST /v1/sgm/devices/:deviceId/activate`
- `POST /v1/sgm/devices/:deviceId/disable`
- `POST /v1/sgm/devices/:deviceId/credentials/:credentialId/revoke`

**ESP32:**

- `POST /v1/device/enroll`
- `POST /v1/device/me/commands/poll`
- `POST /v1/device/me/commands/:commandId/ack`
- `POST /v1/device/me/commands/:commandId/result`
- `POST /v1/device/me/events`

As rotas operacionais devem derivar a identidade do ESP32 da credencial autenticada. Não adicionar endpoint público de cadastro de dispositivos nem endpoint administrativo genérico que contorne ativação, desativação ou revogação.

### Decisões ainda pendentes

- Separação dos usuários PostgreSQL de runtime e migrations; se inviável, avaliar trigger append-only.
- Mecanismo e limites concretos de rate limiting compartilhado, definidos na implantação.
- Detalhes operacionais para registrar tentativas negadas/suspeitas e controlar sua retenção/volume.
- Nome da variável ou parâmetro centralizado que controla o prazo do enrollment; o padrão aprovado é 24 horas.

Não presumir valores para esses itens nem implementá-los sem decisão. A arquitetura serverless não usa estado de autenticação em memória como fonte de verdade e não introduz subscriber MQTT persistente.

## Estado dos serviços de cadastro

Os serviços internos de `Store`, `Sector` e `Device`, com validação Zod, não são montados no Express. A API ainda não possui autenticação e autorização adequadas; por isso, nenhum endpoint de gerenciamento é exposto.

Antes de publicar esses endpoints, implementar e revisar:

- autenticação servidor-servidor para operações administrativas chamadas pelo backend do SGM;
- credenciais individuais, armazenadas como hash e revogáveis, para operações autenticadas pelos dispositivos;
- autorização que limite o acesso do usuário de serviço à loja e o acesso de cada dispositivo ao próprio escopo;
- middleware de autenticação/autorização antes dos handlers, validação HTTP dos schemas e tradução segura de erros de domínio para respostas HTTP.

Os serviços de domínio devem continuar sem responsabilidade HTTP. As rotas e controllers só devem ser adicionados e montados quando essas proteções estiverem implementadas.

## Consistência e confiabilidade

- Eventos carregam um identificador único gerado no dispositivo; restrição única por dispositivo evita duplicação.
- Comandos possuem identificador, expiração e chave de idempotência.
- A retirada de comandos da fila deve ser atômica no PostgreSQL para impedir entrega concorrente duplicada.
- Operações de retry devem ser seguras e não podem repetir efeitos físicos sem política de idempotência no firmware.
- Registrar horário de ocorrência no dispositivo e horário de recebimento no servidor.

## Ciclo de vida de comandos e eventos no MVP

- Comandos de iluminação representam um estado desejado (`ON` ou `OFF`), nunca uma operação de alternância.
- O comando é persistido como `QUEUED`. No polling, um claim transacional no PostgreSQL seleciona e marca os comandos disponibilizados na resposta como `DELIVERED`.
- `DELIVERED` indica disponibilização pela API, não confirmação de recebimento pelo ESP32. `ACKNOWLEDGED` registra essa confirmação; `SUCCEEDED` e `FAILED` registram o resultado informado pelo dispositivo e não são, por si só, confirmação independente do estado físico. `SUCCEEDED`, `FAILED` e `EXPIRED` são terminais.
- O polling só disponibiliza comandos a dispositivos com status administrativo `ACTIVE`; comandos podem permanecer na fila enquanto o dispositivo está `PROVISIONING` e expirar antes de ser ativado.
- Comandos sem confirmação podem ser disponibilizados novamente após 30 segundos, sem máximo de tentativas antes de `expiresAt`. `attempts` conta disponibilizações; `deliveredAt` registra a disponibilização mais recente.
- A expiração é materializada sob demanda durante polling e transições do comando. Um worker agendado poderá ser considerado se for necessário atualizar comandos inativos sem novas requisições.
- Comandos do SGM exigem `idempotencyKey`, única por dispositivo. Repetir a chave com a mesma intenção retorna o comando original; mudar dispositivo, tipo, payload ou expiração gera conflito.
- Eventos são deduplicados por dispositivo e `eventId`. `receivedAt` é o horário confiável de ingestão e ordena eventos recebidos; a última ocorrência `STATE_REPORTED` nessa ordem significa apenas o último estado reportado recebido pela API, não uma confirmação independente do estado físico atual.
- Eventos de confirmação e resultado carregam `commandId` no payload. O service verifica que o comando pertence ao dispositivo; o banco ainda não mantém uma FK entre evento e comando.
- Um resultado de execução exige que o comando já esteja `ACKNOWLEDGED`; o evento de confirmação deve ser recebido primeiro. Eventos atrasados são registrados, mas não substituem estados terminais.
- Uma evolução futura poderá adicionar `bootId` e sequência monotônica por dispositivo para detectar lacunas, duplicações e reordenação entre reinicializações. Isso requer protocolo e suporte no firmware.

## Topologia inicial

SGM backend → IoT Platform API → PostgreSQL/Neon

ESP32 → IoT Platform API → PostgreSQL/Neon

A API será implantada como funções serverless na Vercel. Não executar broker MQTT ou processos persistentes dentro dessas funções.
