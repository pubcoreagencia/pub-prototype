# OPERATIONS RUNBOOK — PHASE 5
## PUB AUTONOMOUS PRODUCT FACTORY

Este runbook instrui a equipe de engenharia e operações da holding PUB sobre como operar, monitorar, intervir e diagnosticar a fábrica autônoma.

---

## 1. INICIALIZAÇÃO E GESTÃO DOS SERVIÇOS

Os serviços são gerenciados pelo `ProductionServiceSupervisor`:

### Daemons do Ecossistema
1. **PP API** (porta 4201): API de prototipagem e handoff HTTP.
2. **PP Worker** (porta 4202): Worker de prototipagem e preview recovery.
3. **PDL API** (porta 4203): API de ingestão canônica, ExecutionSpec e Observabilidade.
4. **PDL Worker** (portas 4204, 4205...): Workers autônomos de engenharia com loop de correção.

### Comandos Operacionais

- **Verificação de Liveness**:
  ```bash
  curl -s http://127.0.0.1:4201/health
  curl -s http://127.0.0.1:4203/health
  ```
- **Verificação de Readiness (Conexão ao DB + Auth)**:
  ```bash
  curl -s http://127.0.0.1:4201/ready
  curl -s http://127.0.0.1:4203/ready
  ```
- **Auditoria ao Vivo ("O que o PDL está fazendo agora?")**:
  ```bash
  curl -s http://127.0.0.1:4203/observability/active-tasks | jq .
  ```
- **Linhagem Completa de Tarefa**:
  ```bash
  curl -s http://127.0.0.1:4203/observability/tasks/<TASK_ID>/lineage | jq .
  ```

---

## 2. ROTINAS DE RECUPERAÇÃO DE FALHAS

### Falha 1: Queda Abrupta de Worker (Process Crash)
- **Comportamento Automático**: O `ProductionServiceSupervisor` detecta o código de saída, limpa o arquivo `.pid` e reinicia o processo com backoff exponencial.
- **Recuperação de Tarefa Órfã**: A tarefa que estava sob posse do worker morto atinge o vencimento da lease (`lease_deadline < NOW()`). O worker reiniciado ou workers pares executam `FOR UPDATE SKIP LOCKED` e assumem a tarefa automaticamente.

### Falha 2: Erro 429 ou Indisponibilidade de Gateway LLM
- **Comportamento Automático**: O `RouterWorker` classifica a falha como `RETRYABLE_TRANSIENT`, aciona o modelo secundário na cadeia de fallback ou aplica backoff operacional sem corromper a especificação.

### Falha 3: Esgotamento de Tentativas do Loop de Correção
- **Comportamento Automático**: Caso uma falha não possa ser corrigida após o limite máximo de tentativas (padrão: 2), a tarefa transiciona para `FAILED`, registra o histórico de diagnósticos no JSONB `tasks.result` e desiste com segurança (fail-closed), sem realizar push de código quebrado no GitHub.

---

## 3. LOGS ESTRUTURADOS E TELEMETRIA

- **Localização dos Logs**: Diretório `./logs/`
  - `logs/pp-api.log`
  - `logs/pp-worker.log`
  - `logs/pdl-api.log`
  - `logs/pdl-worker.log`
- **Formato dos Registros**:
  ```text
  [2026-09-11T21:40:00.000Z] [INFO] [PDL_WORKER] {"event":"PDL_WORKER_STARTED","intervalMs":400}
  ```
- **Redação Ativa**: Toda saída é filtrada para garantir que nenhuma chave de API (`OPENROUTER_API_KEY`, `GITHUB_TOKEN`) ou credencial de banco seja persistida em disco.
