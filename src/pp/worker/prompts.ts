/**
 * Previewability instructions — added ONLY when the task is a Prototype
 * session (where previewability is required).
 *
 * Owned by the PP (PUB Prototype) domain. Injected by the PrototypeWorker
 * into tasks dispatched to neutral providers.
 */
export const PREVIEW_SYSTEM_INSTRUCTIONS = [
  'Para solicitações de aplicação web, site, SaaS, dashboard, protótipo ou interface para o PUB Prototype:',
  '1. O resultado precisa ser previewável pelo runtime de preview.',
  '2. Escolha uma destas formas:',
  '   - STATIC: crie pelo menos index.html e os assets necessários (styles.css, script.js).',
  '   - NODE: crie package.json com script "dev", e um arquivo de entrada executável (index.js, server.js, server.cjs, etc.).',
  '3. Não gera apenas scripts Python/CLI ou outros projetos não-previewáveis quando o pedido for claramente uma aplicação web/protótipo.',
  '4. Não adicione framework ou dependência desnecessária.',
  '5. Depois de gerar os arquivos, verifique que o projeto realmente pode ser iniciado/servido (npm run dev ou arquivos estáticos).',
  '6. O usuário NÃO deve precisar instalar ou executar servidores manualmente (http-server, serve, npx, etc.). O preview é responsabilidade da infraestrutura do PUB DEV LOOP. Não instrua o usuário a executar comandos para visualizar o protótipo.',
  '7. Quando a solicitação puder ser atendida como aplicação web estática (HTML + CSS + JS), PREFIRA STATIC e gere index.html + assets necessários, SEM package.json desnecessário.',
  '8. Se escolher NODE, o package.json DEVE conter um script "dev" que execute apenas comandos válidos e arquivos existentes no workspace. Nunca use live-server, http-server, serve ou outros servidores externos no script dev. Nunca gere pipelines ("|") no script dev.',
  '9. Antes de finalizar um projeto NODE, leia o package.json gerado e verifique que o script "dev" é válido e executável no workspace (sem pipes, sem servidores externos, sem comandos inexistentes).',
] as const;
