# IoT Platform API

API independente para centralizar a comunicação entre dispositivos IoT (ESP32), aplicações corporativas e serviços de persistência.

O primeiro caso de uso será monitoramento e controle de iluminação por setor, com possibilidade de expansão para telemetria e automação de ativos.

> **Status:** estrutura inicial do projeto. Ainda não há endpoints de produção nem integração com dispositivos reais.

## Objetivos

- Registrar dispositivos e associá-los a setores.
- Receber heartbeat e eventos enviados pelos dispositivos.
- Expor estado e histórico para sistemas autorizados, como o SGM.
- Enfileirar comandos remotos de forma rastreável.
- Permitir que rotinas críticas continuem funcionando localmente no ESP32 quando a conexão com a internet cair.

## Arquitetura

```text
                  +----------------------+
                  |      SGM (atual)     |
                  | React / Node.js      |
                  +----------+-----------+
                             |
                       HTTPS / REST
                             |
                  +----------v-----------+
                  |   IoT Platform API   |
                  |   Node.js / Express  |
                  +-----+----------+-----+
                        |          |
                  PostgreSQL      HTTPS
                    (Neon)          |
                               +----v-----+
                               |  ESP32   |
                               | relés /  |
                               | sensores |
                               +----------+
```

### Princípios arquiteturais

1. **Separação de domínios:** API e banco IoT independentes do SGM. Não haverá dependência de chave estrangeira entre os bancos.
2. **HTTP/HTTPS no MVP:** comunicação REST com autenticação individual por dispositivo. MQTT poderá ser avaliado quando houver necessidade concreta de comunicação em tempo real ou maior volume de dispositivos.
3. **Persistência externa:** estado, eventos e comandos ficam no PostgreSQL; não depender de memória local de funções serverless.
4. **Execução resiliente:** agendamentos essenciais devem ser sincronizados e executados localmente pelo ESP32. A nuvem não será o único mecanismo de temporização.
5. **Rastreabilidade:** solicitação, entrega, confirmação e resultado de um comando são etapas distintas.
6. **Segurança:** HTTPS, credenciais individuais revogáveis, validação de entrada e autorização por dispositivo/integração.

## Stack planejada

| Camada | Tecnologia |
|---|---|
| Runtime | Node.js 22 LTS |
| Linguagem | JavaScript (ES Modules) |
| API | Express |
| Validação | Zod |
| ORM | Prisma |
| Banco | PostgreSQL (Neon) |
| Hospedagem inicial | Vercel |
| Dispositivo | ESP32 |

As versões e dependências serão fixadas no `package.json` durante a primeira etapa de implementação.

## Estrutura de diretórios

```text
.
├── docs/
│   └── architecture.md
├── prisma/
│   └── migrations/
├── src/
│   ├── config/
│   ├── middlewares/
│   ├── modules/
│   │   ├── commands/
│   │   ├── devices/
│   │   ├── events/
│   │   ├── integrations/
│   │   │   └── sgm/
│   │   └── sectors/
│   ├── shared/
│   │   ├── errors/
│   │   └── utils/
│   ├── app.js
│   └── server.js
├── tests/
│   ├── integration/
│   └── unit/
├── .env.example
├── .gitignore
└── README.md
```

### Organização dos módulos

Cada módulo de domínio poderá conter suas próprias rotas, controller, service e schemas de validação. A regra de negócio fica nos services; controllers tratam HTTP e não acessam o Prisma diretamente.

- `devices`: cadastro, autenticação, heartbeat e estado de conexão.
- `events`: ingestão, deduplicação e consulta de eventos.
- `commands`: criação, entrega, expiração e resultado de comandos.
- `sectors`: setores e associação de dispositivos.
- `integrations/sgm`: endpoints destinados à integração servidor-servidor com o SGM.

## Fluxos principais previstos

### Telemetria

1. ESP32 envia heartbeat ou evento autenticado.
2. API valida identidade, formato e autorização do dispositivo.
3. Evento é persistido com identificador único do dispositivo e horário de ocorrência.
4. SGM consulta estado e histórico por endpoints de integração.

### Comando remoto

1. Usuário solicita uma ação no SGM.
2. Backend do SGM valida permissões e chama a IoT Platform API.
3. API registra o comando com identificador, validade e estado inicial.
4. ESP32 consulta a fila e recebe comandos destinados a ele.
5. ESP32 confirma recebimento e reporta o resultado da execução.
6. API mantém o histórico de cada transição.

**Importante:** resposta HTTP de sucesso confirma apenas que a API recebeu a solicitação. Não comprova que o relé comutou nem que a iluminação realmente acendeu. Para confirmação física será necessário feedback elétrico/sensor apropriado.

## Variáveis de ambiente

Consulte [`.env.example`](.env.example). Nunca versione credenciais reais, tokens ou strings de conexão.

## Desenvolvimento

Os comandos de instalação, migração, execução e testes serão adicionados quando a aplicação e o schema inicial do Prisma forem implementados.

## Roadmap

- [ ] Estrutura inicial e documentação.
- [ ] Configuração Node.js, Express e validação de ambiente.
- [ ] Configuração Prisma e banco PostgreSQL Neon exclusivo.
- [ ] Modelo inicial de setores e dispositivos.
- [ ] Autenticação individual dos ESP32.
- [ ] Heartbeat e ingestão de eventos.
- [ ] Fila de comandos com entrega atômica e idempotência.
- [ ] Firmware ESP32 para telemetria e controle em bancada.
- [ ] Integração backend-backend com o SGM.
- [ ] Testes, observabilidade e preparação para produção.

## Escopo de segurança e operação

Este projeto pode futuramente controlar cargas elétricas. O firmware e a instalação devem prever estado seguro após reinicialização, perda de rede, falha de alimentação e falha do dispositivo. O ESP32/relé não substitui dispositivos de proteção elétrica, intertravamentos ou comandos locais de emergência. A instalação em circuitos reais deve ser projetada e validada por profissional habilitado.
