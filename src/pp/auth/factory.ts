import type { Pool } from 'pg';
import type { AuthProvider } from './provider.js';
import { SupabaseAuthProvider } from './supabase-provider.js';
import { SovereignAuthProvider } from './sovereign-provider.js';
import { CompositeAuthProvider } from './composite-provider.js';
import type { KeyManager } from './sovereign/key-manager.js';

export interface AuthFactoryOptions {
  pool: Pool;
  providerName?: 'supabase' | 'sovereign' | 'composite' | string;
  keyManager?: KeyManager;
}

export function getAuthProvider(options: AuthFactoryOptions): AuthProvider {
  const provider = (options.providerName ?? process.env.AUTH_PROVIDER ?? 'supabase').toLowerCase();

  const sovereignProvider = new SovereignAuthProvider(options.pool, options.keyManager);

  if (provider === 'sovereign') {
    return sovereignProvider;
  }

  const supabaseProvider = new SupabaseAuthProvider();

  // In transitional parallel operation (Phase 4), when AUTH_PROVIDER is 'supabase' (or 'composite'),
  // return CompositeAuthProvider so that Sovereign Ed25519 tokens (from claimed users)
  // AND existing Supabase tokens are both accepted seamlessly without requiring premature cutover.
  return new CompositeAuthProvider(sovereignProvider, supabaseProvider);
}

