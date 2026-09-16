import type { Pool } from 'pg';
import type { AuthProvider } from './provider.js';
import { SupabaseAuthProvider } from './supabase-provider.js';
import { SovereignAuthProvider } from './sovereign-provider.js';
import type { KeyManager } from './sovereign/key-manager.js';

export interface AuthFactoryOptions {
  pool: Pool;
  providerName?: 'supabase' | 'sovereign' | string;
  keyManager?: KeyManager;
}

export function getAuthProvider(options: AuthFactoryOptions): AuthProvider {
  const provider = (options.providerName ?? process.env.AUTH_PROVIDER ?? 'supabase').toLowerCase();

  if (provider === 'sovereign') {
    return new SovereignAuthProvider(options.pool, options.keyManager);
  }

  // Default: Supabase
  return new SupabaseAuthProvider();
}
