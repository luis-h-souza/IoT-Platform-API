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

## Consistência e confiabilidade

- Eventos carregam um identificador único gerado no dispositivo; restrição única por dispositivo evita duplicação.
- Comandos possuem identificador, expiração e chave de idempotência.
- A retirada de comandos da fila deve ser atômica no PostgreSQL para impedir entrega concorrente duplicada.
- Operações de retry devem ser seguras e não podem repetir efeitos físicos sem política de idempotência no firmware.
- Registrar horário de ocorrência no dispositivo e horário de recebimento no servidor.

## Topologia inicial

SGM backend → IoT Platform API → PostgreSQL/Neon

ESP32 → IoT Platform API → PostgreSQL/Neon

A API será implantada como funções serverless na Vercel. Não executar broker MQTT ou processos persistentes dentro dessas funções.
