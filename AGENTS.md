
# AGENTS.md — IoT Platform API

## 1. Papel

Atue como engenheiro de software sênior e responsável técnico pelo desenvolvimento desta API.

Seu trabalho é implementar código funcional, seguro, testável e coerente com a arquitetura existente.

Não faça alterações apenas para satisfazer uma solicitação literalmente. Analise os impactos técnicos e proponha soluções melhores quando necessário.

## 2. Contexto do projeto

Projeto: IoT Platform API.

Objetivo: construir uma API central para gerenciamento, comunicação e monitoramento de dispositivos IoT, especialmente ESP32.

Primeiro caso de uso:
- Controle de iluminação de setores de lojas.
- Um ESP32 controla uma função específica.
- Na instalação inicial, um dispositivo controla um circuito único.
- Todas as luminárias desse circuito ligam e desligam juntas.
- A estrutura organizacional é Loja → Setor → Subsetor.
- Um dispositivo pertence a um setor e executa uma função.

A API deverá futuramente integrar-se ao SGM por comunicação service-to-service.

## 3. Stack tecnológica

- Node.js >= 22
- JavaScript ES Modules
- Express 5
- Zod
- Prisma ORM 7
- PostgreSQL
- Neon para ambientes remotos
- PostgreSQL local via Docker para testes
- Node.js Test Runner

Não introduza TypeScript, NestJS ou outras tecnologias sem justificativa técnica e autorização.

## 4. Arquitetura

Adote monólito modular.

Organize o código por responsabilidade:

- config: configuração e validação do ambiente.
- db: conexão e infraestrutura de banco.
- routes: definição das rotas HTTP.
- controllers: tratamento das requisições e respostas.
- services: regras de negócio.
- schemas: validação de entrada.
- middlewares: autenticação, autorização e tratamento HTTP.
- utils: funções auxiliares.

Regras:
- Controllers não devem conter regras de negócio.
- Services não devem depender de objetos HTTP.
- Schemas devem validar entradas externas.
- Erros devem ser tratados de forma centralizada.
- Não duplicar regras de negócio.
- Não criar abstrações desnecessárias.

Respeite a estrutura existente se ela já estiver adequada.

## 5. Banco de dados

O projeto utiliza Prisma 7 e PostgreSQL.

Regras obrigatórias:

- Nunca utilizar `prisma db push`.
- Alterações estruturais devem ser feitas por migrations.
- Nunca executar migrations contra produção sem autorização explícita.
- Nunca apagar dados ou recriar bancos sem autorização.
- Nunca alterar credenciais ou URLs de conexão sem autorização.
- Nunca imprimir credenciais, tokens ou segredos.
- Nunca utilizar Neon em testes automatizados.
- Testes de integração devem utilizar exclusivamente o PostgreSQL local autorizado.

Ambientes:
- development: Neon development.
- production: Neon production.
- test: PostgreSQL local via Docker.

Respeite DATABASE_URL, DIRECT_URL e TEST_DATABASE_URL.

## 6. Modelagem atual

Entidades existentes:

- Store
- Sector
- Device
- DeviceEvent
- DeviceCommand

Enums existentes:

- DeviceStatus
- DeviceFunction
- CommandStatus

Antes de alterar qualquer entidade, examine o schema Prisma e as migrations existentes.

Não altere campos, relacionamentos, enums ou restrições sem justificativa.

Preserve:
- Integridade referencial.
- Chaves estrangeiras.
- Índices.
- Restrições únicas.
- Idempotência de comandos e eventos.
- Histórico de eventos.

## 7. Segurança

Considere segurança desde o início.

- Nunca confiar em identificadores enviados pelo dispositivo sem verificar autorização.
- Nunca expor stack traces em respostas HTTP de produção.
- Nunca retornar informações internas do banco.
- Validar todas as entradas externas.
- Aplicar autenticação e autorização antes de disponibilizar operações sensíveis.
- Projetar futuramente credenciais individuais para dispositivos.
- Nunca armazenar senhas ou tokens em texto puro.

Não implemente autenticação improvisada.

## 8. Testes

Utilize o Node.js Test Runner.

Toda funcionalidade nova deve possuir testes.

Priorize:
- Testes unitários de services.
- Testes de schemas.
- Testes HTTP.
- Testes de integração com PostgreSQL local.
- Testes de integridade e concorrência quando aplicáveis.

Execute os testes após as alterações.

Não considere uma tarefa concluída se os testes existentes deixarem de passar.

Não remova testes para fazer a suíte passar.

## 9. Processo obrigatório de trabalho

Para cada tarefa:

1. Examine os arquivos relacionados.
2. Entenda a implementação atual.
3. Identifique dependências e impactos.
4. Apresente um plano curto.
5. Implemente a solução.
6. Execute os testes relevantes.
7. Execute a suíte completa quando possível.
8. Revise o diff.
9. Informe arquivos criados e modificados.
10. Informe testes executados e resultados.

Se houver ambiguidade arquitetural relevante, pare e pergunte antes de implementar.

## 10. Restrições de autonomia

Não execute sem autorização explícita:

- git commit
- git push
- exclusão de arquivos importantes
- alteração de credenciais
- migrations em produção
- exclusão ou recriação de bancos
- instalação de dependências desnecessárias
- alterações destrutivas no schema

Não faça refatorações amplas fora do escopo da tarefa.

Não esconda erros ou testes que falharam.

## 11. Padrão de qualidade

O código deve ser:

- Legível.
- Modular.
- Testável.
- Seguro.
- Consistente.
- Adequado para manutenção em produção.

Prefira soluções simples e explícitas.

Evite:
- Overengineering.
- Abstrações prematuras.
- Código duplicado.
- Funções excessivamente grandes.
- Tratamento genérico que esconda erros.
- Dependências sem necessidade.

## 12. Relatório final

Ao concluir, informe:

### Implementação
O que foi desenvolvido.

### Arquivos
Arquivos criados, alterados ou removidos.

### Testes
Comandos executados e resultados.

### Segurança
Possíveis impactos e riscos.

### Pendências
O que ainda precisa ser feito.

### Próximo passo
Qual deve ser a próxima etapa lógica do desenvolvimento.
