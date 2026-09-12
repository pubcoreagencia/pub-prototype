# MODELO DE SEGURANÇA E GOVERNANÇA — PHASE 5
## PUB AUTONOMOUS PRODUCT FACTORY

Este documento descreve o modelo de defesa em profundidade, isolamento de execução, redação de credenciais e fronteiras de autorização da fábrica autônoma PUB.

---

## 1. PRINCÍPIOS FUNDAMENTAIS DE SEGURANÇA

1. **Deny-by-Default Universal**:
   - Organizações não cadastradas são rejeitadas com HTTP 400.
   - Branches não explicitamente autorizadas por política são bloqueadas.
   - Nenhuma task externa pode injetar comandos arbitrários de commit/push sem passar pelas validações de governança.
2. **Evidência Não-Confiável (`Untrusted Runtime Evidence`)**:
   - Saídas de testes, logs de compilador e relatórios de erro produzidos dentro do workspace são classificados como dados não-confiáveis de runtime.
   - A especificação canônica (`ExecutionSpec`) é **estritamente imutável**; mensagens de erro nunca alteram objetivos, critérios de aceite ou restrições de segurança.
3. **Isolamento de Workspaces**:
   - Cada tentativa de execução ocorre em diretório temporário isolado (`mkdtemp`).
   - Nenhuma escrita afeta workspaces de outras tarefas ou de outros produtos.
4. **Zero Cross-Database Joins e Zero Vazamentos de Credenciais**:
   - Os bancos `pub_prototype_e2e` e `pub_dev_loop_e2e` são completamente estanques.
   - Credenciais sensíveis (`OPENROUTER_API_KEY`, `GITHUB_TOKEN`, `PGPASSWORD`) são sanitizadas via pipeline determinístico (`secret-redaction.ts`) e nunca chegam a logs, payloads JSONB ou mensagens de commit.

---

## 2. NÍVEIS FORMAIS DE AUTONOMIA

| Nível | Identificador | Capacidades Autorizadas | Restrições |
| :---: | :--- | :--- | :--- |
| **0** | `LEVEL_0_ANALYSIS` | Leitura de repositório, análise diagnóstica, planejamento. | Proibida qualquer mutação em disco. |
| **1** | `LEVEL_1_PROTOTYPE` | Edições exploratórias locais no PUB PROTOTYPE (PP). | Sem acesso a repositórios remotos. |
| **2** | `LEVEL_2_LOCAL_WORKSPACE` | Edições no workspace efêmero do PDL. | Proibido commit ou push. |
| **3** | `LEVEL_3_TEST_VALIDATION` | Edições + execução de suíte de testes unitários. | Proibido commit ou push. |
| **4** | `LEVEL_4_BRANCH_COMMIT` | Criação de commits locais em branch de desenvolvimento autorizada. | Proibido push remoto. |
| **5** | `LEVEL_5_REMOTE_PUSH` | Criação de commits e push atômico para o GitHub em branch de desenvolvimento autorizada. | Estritamente proibido push em branches protegidas (`main`, `production`, `release/*`). |

---

## 3. PONTOS DE APROVAÇÃO HUMANA (HUMAN GOVERNANCE GATES)

A autonomia de engenharia opera dentro de limites restritos. A intervenção e aprovação humana é obrigatória em 3 marcos invioláveis:

```text
[ IDEIA / REQUISITO ]
          ↓
[ PP ITERATION ]
          ↓
  (GATE 1: PROTOTYPE APPROVAL)  ← Apenas operador humano autoriza transição
          ↓
[ HTTP HANDOFF / INGESTION ]
          ↓
[ PDL TASKINTAKESERVICE ]
          ↓
[ SEALED EXECUTIONSPEC (Level 1-5) ]
          ↓
[ AUTONOMOUS ENGINEERING & TESTS ]
          ↓
[ PUSH EM BRANCH DE FEATURE (feat/*) ]
          ↓
  (GATE 2: RELEASE APPROVAL)    ← Apenas líder técnico humano autoriza PR/Merge para branch principal
          ↓
  (GATE 3: PRODUCTION DEPLOY)   ← Apenas governança de infraestrutura autoriza deploy comercial
```

---

## 4. PROTEÇÃO CONTRA PROMPT INJECTION E PATH TRAVERSAL

- **Path Traversal**: Qualquer caminho que tente resolver fora da raiz do repositório (`..`, paths absolutos externos) dispara `SECURITY_VIOLATION` imediato e encerra a execução com fail-closed.
- **Proteção de Arquivos Críticos**: Tentativas de alterar arquivos em `protectedPaths` (`.github/**`, `.env*`, etc.) são detectadas pela `validateModifiedPaths` e resultam em aborto de finalização.
- **Sanitização de Instruções**: O formatador de prompts de correção delimita explicitamente dados de erro sob blocos marcados de evidência não-confiável, impedindo que textos maliciosos de teste instruam o modelo a burlar critérios de aceite.
