import { describe, it, expect } from 'vitest';
import { buildPreviewEnvironment } from '../src/pp/preview/env-scrubber.js';

describe('Preview Environment Isolation (P0-A)', () => {
  it('does not inherit DATABASE_URL or arbitrary API keys from parent process', () => {
    const parentEnv = {
      PATH: '/usr/bin',
      DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
      OPENROUTER_API_KEY: 'sk-12345',
      SOME_SECRET: 'secret-value',
      GITHUB_TOKEN: 'ghp_123',
      AWS_ACCESS_KEY_ID: 'AKIA...',
      NPM_TOKEN: 'npm_123',
      PROTOTYPE_BOT_TOKEN: 'bot_123'
    };
    
    const env = buildPreviewEnvironment(parentEnv, {}, 3000);
    
    expect(env.PATH).toBe('/usr/bin');
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
    expect(env.SOME_SECRET).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.NPM_TOKEN).toBeUndefined();
    expect(env.PROTOTYPE_BOT_TOKEN).toBeUndefined();
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

  it('allows explicit arbitrary configuration via configEnv (denylist approach)', () => {
    const env = buildPreviewEnvironment({}, { NODE_ENV: 'development', CUSTOM_VAR: '123', VITE_API_URL: 'http://api' }, 3000);
    expect(env.NODE_ENV).toBe('development');
    expect(env.CUSTOM_VAR).toBe('123');
    expect(env.VITE_API_URL).toBe('http://api');
  });

  it('prevents configEnv from reintroducing critical secrets', () => {
    const env = buildPreviewEnvironment({}, { 
      DATABASE_URL: 'malicious', 
      GITHUB_TOKEN: 'leak',
      AWS_SECRET_ACCESS_KEY: 'leak',
      OPENROUTER_API_KEY: 'leak',
      NPM_TOKEN: 'leak',
      PROTOTYPE_BOT_TOKEN: 'leak'
    }, 3000);
    
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
    expect(env.NPM_TOKEN).toBeUndefined();
    expect(env.PROTOTYPE_BOT_TOKEN).toBeUndefined();
  });
});
