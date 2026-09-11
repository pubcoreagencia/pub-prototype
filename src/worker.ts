import { execSync } from 'node:child_process';

function githubCredentialHelper(): string {
  const lines = [
    '!f() {',
    '  local op="" proto="" hst="" path=""',
    '  while IFS= read -r line; do',
    '    case "$line" in',
    '      operation=*) op="${line#operation=}" ;;',
    '      protocol=*)  proto="${line#protocol=}" ;;',
    '      host=*)      hst="${line#host=}" ;;',
    '      path=*)      path="${line#path=}" ;;',
    '    esac',
    '  done',
    '  if [ "$op" = "get" ] && [ -n "$GITHUB_TOKEN" ]; then',
    '    echo "protocol=$proto"',
    '    echo "host=$hst"',
    '    echo "username=x-access-token"',
    '    echo "password=$GITHUB_TOKEN"',
    '  fi',
    '}; f',
  ];
  return lines.join('\n');
}

export function configureGitCredentials(): void {
  if (!process.env.GITHUB_TOKEN) {
    console.log('No GITHUB_TOKEN set — public repos only.');
    return;
  }
  process.env.GIT_CONFIG_COUNT = '1';
  process.env.GIT_CONFIG_KEY_0 = 'credential.helper';
  process.env.GIT_CONFIG_VALUE_0 = githubCredentialHelper();
  console.log('Git credential helper configured (no file, env-based).');
}

const GIT_AUTHOR_NAME = process.env.GIT_AUTHOR_NAME ?? 'PUB Prototype Worker';
const GIT_AUTHOR_EMAIL = process.env.GIT_AUTHOR_EMAIL ?? 'worker@pub-prototype.internal';

export function configureGitIdentity(): void {
  try {
    execSync(`git config --global user.name "${GIT_AUTHOR_NAME}"`, { stdio: 'pipe' });
    execSync(`git config --global user.email "${GIT_AUTHOR_EMAIL}"`, { stdio: 'pipe' });
    execSync('git config --global init.defaultBranch main', { stdio: 'pipe' });
    execSync('git config --global --add safe.directory "*"', { stdio: 'pipe' });
    console.log(`Git identity configured: ${GIT_AUTHOR_NAME} <${GIT_AUTHOR_EMAIL}>`);
  } catch (err) {
    console.warn('Failed to configure git identity globally:', (err as Error).message);
  }
}
