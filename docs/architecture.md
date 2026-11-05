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

- ESP32 autentica com credencial individual, revogável e armazenada como hash no servidor.
- Backend do SGM autentica na integração usando segredo de serviço guardado em variável de ambiente.
- Frontend do SGM não recebe credenciais de integração nem credenciais dos dispositivos.
- Cada dispositivo só pode consultar comandos e enviar eventos em seu próprio escopo.
- Todas as rotas validam payloads e limites de tamanho.

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
