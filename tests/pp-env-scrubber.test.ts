import { describe, it, expect } from 'vitest';
import { buildPreviewEnvironment } from '../src/pp/preview/env-scrubber.js';

describe('Preview Environment Isolation (P0-A)', () => {
  it('does not inherit DATABASE_URL or arbitrary API keys from parent process', () => {
    const parentEnv = {
      PATH: '/usr/bin',
      DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
      OPENROUTER_API_KEY: 'sk-12345',
      SOME_SECRET: 'secret-value'
    };
    
    const env = buildPreviewEnvironment(parentEnv, {}, 3000);
    
    expect(env.PATH).toBe('/usr/bin');
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
    expect(env.SOME_SECRET).toBeUndefined();
  });

  it('applies PORT correctly', () => {
    const env = buildPreviewEnvironment({ PATH: '/bin' }, {}, 8080);
    expect(env.PORT).toBe('8080');
  });

  it('preserves PATH and other allowed variables', () => {
    const parentEnv = {
      PATH: '/bin:/usr/bin',
      NODE_ENV: 'production',
      HOME: '/home/user'
    };
    const env = buildPreviewEnvironment(parentEnv, {}, 3000);
    expect(env.PATH).toBe('/bin:/usr/bin');
    expect(env.NODE_ENV).toBe('production');
    expect(env.HOME).toBe('/home/user');
  });

  it('allows explicit configuration via configEnv', () => {
    const env = buildPreviewEnvironment({}, { NODE_ENV: 'development', CUSTOM_VAR: '123' }, 3000);
    expect(env.NODE_ENV).toBe('development');
    expect(env.CUSTOM_VAR).toBe('123');
  });

  it('prevents configEnv from reintroducing critical secrets', () => {
    const env = buildPreviewEnvironment({}, { DATABASE_URL: 'malicious', GITHUB_TOKEN: 'leak' }, 3000);
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });
});
