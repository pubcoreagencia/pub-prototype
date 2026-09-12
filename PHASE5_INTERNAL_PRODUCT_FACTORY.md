# BLUEPRINT ARQUITETURAL: FÁBRICA INTERNA DE PRODUTOS AUTÔNOMOS
## PUB INTERNAL AUTONOMOUS PRODUCT FACTORY (PHASE 5)

Este documento estabelece o blueprint canônico e o contrato arquitetural que transforma a infraestrutura comprovada do **PUB PROTOTYPE (PP)** e do **PUB DEV LOOP (PDL)** em uma fábrica de software contínua, governada e soberana para a holding PUB.

---

## 1. VISÃO GERAL DA ARQUITETURA

A fábrica opera sob desacoplamento absoluto em camadas:

```text
[ PUB PROTOTYPE (PP) ]
  • Exploração Rápida de Ideias
  • Iterações com Modelos LLM
  • Preview Local / Checkpoint Git
  • Sessões Estritamente Isoladas
         ↓
  (HTTP HANDOFF CANÔNICO: POST /tasks/ingest)
         ↓
[ PUB DEV LOOP (PDL) ]
  • TaskIntakeService & Validação
  • Selagem Imutável de ExecutionSpec (Autonomy Level 0-5)
  • Fila de Alta Resiliência com Fairness Multi-Produto
  • Workers Soberanos com Leases Atômicas (FOR UPDATE SKIP LOCKED)
  • In-Process Bounded Correction Loop
  • Finalização Git & Remote Push em Branches feat/*
         ↓
[ GITHUB REMOTO (pubcoreagencia/*) ]
  • Branches de Desenvolvimento Seguras
  • Pull Requests Automatizados com Testes Verificados
```

---

## 2. PILARES DE CONFORMIDADE OPERACIONAL

1. **Separação Física e Soberania**:
   - `PP` e `PDL` possuem bases de dados independentes (`pub_prototype_e2e` e `pub_dev_loop_e2e`).
   - Zero dependências de runtime compartilhadas; zero imports cruzados.
2. **Supervisão Contínua**:
   - Daemons supervisionados por monitor de processos dedicado com arquivos PID, recuperação automática de crashes e logs rotacionados estruturados.
3. **Governança Estrita e Níveis de Autonomia**:
   - Autorização de repositórios deny-by-default (`pubcoreagencia/*`).
   - 6 níveis formais de autonomia (Level 0 a Level 5) garantindo que ações de commit e push sejam expressamente permitidas pela especificação selada.
4. **Resiliência Multi-Produto com Fila Justa (Fair Queue)**:
   - Limites de concorrência por produto (`PRODUCT_CONCURRENCY_LIMIT`) impedem que um único produto com alto volume de tarefas monopolize a capacidade dos workers.
   - Recuperação atômica de leases vencidas assegura que tarefas nunca fiquem órfãs após falhas de hardware ou software.
5. **Auto-Correção Orgânica**:
   - Falhas de teste no workspace ativam o `PdlCorrectionLoop` com evidências diagnósticas sanitizadas, viabilizando auto-recuperação guiada por testes sem mutação da especificação de aceite.
