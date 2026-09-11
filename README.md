# PUB PROTOTYPE (PP)

Ambiente de prototipação rápida de interfaces e produtos da **PUB Core Holding**.

Consulte o [MASTER_CONTEXT.md](./MASTER_CONTEXT.md) para diretrizes de governança, arquitetura charter e alinhamento executivo da holding, e o [ARCHITECTURE.md](./ARCHITECTURE.md) para a especificação arquitetural do subsistema.

---

## Mission & Architecture

O **PUB Prototype (PP)** é um subsistema soberano de prototipação rápida, projetado para operar de forma autônoma e desacoplada do **PUB DEV LOOP (PDL)**:

- **Repository Independence**: Código-fonte, migrações, configuração e runtime 100% autônomos, sem dependências internas ou chaves estrangeiras físicas para o banco de dados do PDL.
- **Autonomous Prototyping**: Loop conversacional rápido para criação e evolução iterativa de protótipos multi-arquivos com versionamento e checkpoints imutáveis.
- **Dynamic Previews**: Suporte integrado a previews ao vivo no navegador para aplicações estáticas e servidores dinâmicos Node.js com isolamento de porta.
- **Decoupled Handoff to PDL**: Mecanismo de promoção de protótipos aprovados via contrato de ingestão assíncrono (correlation ID), transferindo a especificação de produto para formalização de engenharia no PDL sem acoplamento de runtime.

---

## Quickstart

### 1. Installation

```bash
npm install
```

### 2. Configuration

Copy the example configuration file:

```bash
cp .env.example .env
```

Configure your PostgreSQL connection and LLM API keys in `.env`.

### 3. Database Migrations

Run all sovereign prototype database migrations from `db/migrations/`:

```bash
# Apply migrations sequentially using psql or your migration runner:
# db/migrations/001_initial_prototype_schema.sql
# db/migrations/002_prototype_events.sql
# db/migrations/003_prototype_promotions.sql
# db/migrations/004_prototype_messages.sql
```

### 4. Running Services

Start the Prototype API server:

```bash
npm run pp:api
```

Start the Prototype Worker daemon:

```bash
npm run pp:worker
```

### 5. Development & Testing

```bash
# Typecheck
npm run typecheck

# Build dist
npm run build

# Run unit and integration tests
npm test
```

---

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `PORT` | HTTP port for Prototype API | `3001` |
| `DATABASE_URL` | PostgreSQL connection string | `postgres://localhost:5432/pub_prototype` |
| `PP_BASE_DIR` | Directory for prototype workspaces | `./workspaces` |
| `OPENROUTER_API_KEY` | LLM API key for OpenRouter models | - |
| `ANTHROPIC_API_KEY` | LLM API key for Anthropic models | - |
| `GEMINI_API_KEY` | LLM API key for Google Gemini models | - |

---

## Governance & Provenance

- **Canonical Identifier**: `pub-prototype`
- **Holding Vertical**: Tecnologia (PUB Core Holding)
- **Extraction Provenance**: See [EXTRACTION_PROVENANCE.md](./EXTRACTION_PROVENANCE.md) for forensic baseline details.
- **Autonomous Log**: See [AUTONOMOUS_CYCLE.md](./AUTONOMOUS_CYCLE.md) for 24/7 holding cycle history.

---

## License
Proprietary — PUB Core Agência.
