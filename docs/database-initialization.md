# Database Initialization

O projeto atualmente não possui um migration runner nativo integrado ao runtime.

Para inicializar o PostgreSQL em um ambiente novo (ex: Railway), execute os scripts SQL na ordem exata contra a base de dados utilizando o cliente `psql` ou o painel de Queries do Railway.

## Mecanismo Mínimo de Inicialização

Execute os seguintes comandos no terminal onde o `psql` estiver disponível, substituindo `$DATABASE_URL` pela string de conexão do Railway:

```bash
psql $DATABASE_URL -f db/migrations/001_initial_prototype_schema.sql
psql $DATABASE_URL -f db/migrations/002_prototype_events.sql
psql $DATABASE_URL -f db/migrations/003_prototype_promotions.sql
psql $DATABASE_URL -f db/migrations/004_prototype_messages.sql
```

Todos os scripts são estritamente idempotentes (`IF NOT EXISTS`, `ON CONFLICT`, etc.), portanto podem ser re-executados com segurança.
