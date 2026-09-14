export function buildPreviewEnvironment(
  parentEnv: NodeJS.ProcessEnv,
  configEnv: Record<string, string | undefined> = {},
  port: number
): NodeJS.ProcessEnv {
  // Allowlist-first approach
  const allowedKeys = [
    'PATH',
    'NODE_ENV',
    'npm_config_userconfig',
    'HOME',
    'USER',
    'LANG',
    'LC_ALL'
  ];

  const env: NodeJS.ProcessEnv = {};

  // 1. Copy explicitly allowed keys from parent
  for (const key of allowedKeys) {
    if (parentEnv[key] !== undefined) {
      env[key] = parentEnv[key];
    }
  }

  // 2. Add config environment variables (provided by project)
  // Ensure we don't accidentally re-introduce secrets if a configEnv
  // tries to copy from parentEnv. (The caller should not pass secrets in configEnv).
  // But just to be safe, we explicitly block known secrets even from configEnv.
  const blockedPrefixes = ['DATABASE_URL', 'OPENROUTER_', 'GITHUB_', 'PROTOTYPE_BOT_TOKEN', 'AWS_', 'NPM_TOKEN'];

  for (const [key, value] of Object.entries(configEnv)) {
    let isBlocked = false;
    for (const prefix of blockedPrefixes) {
      if (key.toUpperCase().startsWith(prefix)) {
        isBlocked = true;
        break;
      }
    }
    if (!isBlocked && value !== undefined) {
      env[key] = value;
    }
  }

  // 3. Always apply PORT
  env.PORT = String(port);

  return env;
}
