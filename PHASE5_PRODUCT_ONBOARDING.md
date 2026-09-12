# GUIA CANÔNICO DE ONBOARDING DE PRODUTOS
## PUB AUTONOMOUS PRODUCT FACTORY (PHASE 5)

Este documento estabelece o protocolo operacional e técnico formal para admissão de qualquer produto de software da holding PUB na esteira autônoma do **PUB DEV LOOP (PDL)**.

---

## 1. PRINCÍPIO DA NÃO-INFERÊNCIA

O PDL **nunca descobre silenciosamente regras críticas de um produto**.
Nenhum agente ou processo pode assumir comandos de teste, arquivos protegidos ou branches de produção sem uma declaração explícita no catálogo versionado.

Qualquer repositório ou branch não previamente catalogada é **rejeitada por padrão** (`DENY_BY_DEFAULT`).

---

## 2. ESTRUTURA DO CONTRATO DO PRODUTO (`ProductManifest`)

Cada produto onboarded na fábrica deve implementar a interface canônica `ProductManifest`:

```typescript
export interface ProductManifest {
  /** Identificador canônico do produto na organização */
  productId: string;

  /** URL HTTPS canônica do repositório GitHub */
  repository: string;

  /** Organização proprietária autorizada (ex: pubcoreagencia) */
  organization: string;

  /** Branch protegida padrão (ex: main) */
  defaultBranch: string;

  /** Padrões de branches autorizadas para trabalho autônomo */
  developmentBranchPolicy: string[];

  /** Comando determinístico de execução de testes unitários/integração */
  testCommand: string;

  /** Comando opcional de build */
  buildCommand?: string;

  /** Comando opcional de validação estática / lint */
  validationCommand?: string;

  /** Padrões glob de arquivos permitidos para edição autônoma */
  allowedPaths: string[];

  /** Padrões glob de arquivos estritamente protegidos (imutáveis por agentes) */
  protectedPaths: string[];

  /** Nível de autonomia máximo autorizado para o produto (0 a 5) */
  maxAutonomyLevel: AutonomyLevel;
}
```

---

## 3. PRODUTOS PREVIAMENTE ONBOARDED E ATIVOS

| Product ID | Repositório | Default Branch | Branch Policy | Test Command | Autonomia Máx |
| :--- | :--- | :---: | :---: | :--- | :---: |
| `pub-rate-calculator` | `pubcoreagencia/pub-rate-calculator.git` | `main` | `feat/*`, `fix/*` | `node test/validate.mjs` | Level 5 |
| `pub-dev-loop-template` | `pubcoreagencia/pub-dev-loop-template.git` | `main` | `feat/*`, `fix/*` | `npm test` | Level 5 |
| `pub-shopee-scraper` | `pubcoreagencia/pub-shopee-scraper.git` | `main` | `feat/*`, `fix/*` | `npm test` | Level 5 |
| `pub-github-mcp` | `pubcoreagencia/pub-github-mcp.git` | `main` | `feat/*`, `fix/*` | `npm test` | Level 5 |
| `pubcore` | `pubcoreagencia/pubcore.git` | `main` | `feat/*`, `fix/*` | `npm test` | Level 4 |

---

## 4. PROCEDIMENTO PASSO-A-PASSO PARA NOVO ONBOARDING

1. **Auditoria de Repositório**:
   - Garantir que o repositório reside sob a organização autorizada `pubcoreagencia`.
   - Garantir que a branch `main` possui suíte de testes determinística sem dependências externas não mockadas.
2. **Definição de Fronteiras de Caminho**:
   - Identificar caminhos sensíveis (`.github/**`, `.env*`, `package.json`, credenciais) e incluí-los obrigatoriamente em `protectedPaths`.
3. **Registro no Catálogo**:
   - Incluir o manifesto em `src/pdl/products/catalog.ts` sob `CANONICAL_PUB_PRODUCTS`.
4. **Validação Pré-Voo**:
   - Executar `npm run typecheck` no PDL.
   - Disparar validação de autorização de ingestão via `POST /tasks/ingest`.
