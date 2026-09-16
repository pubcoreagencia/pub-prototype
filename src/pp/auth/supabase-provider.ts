import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { AuthProvider } from './provider.js';
import type { AuthenticatedUser } from './auth.js';

export class SupabaseAuthProvider implements AuthProvider {
  readonly name = 'supabase';
  private client: SupabaseClient | null = null;

  constructor(url?: string, anonKey?: string) {
    const supabaseUrl = url ?? process.env.SUPABASE_URL;
    const supabaseAnonKey = anonKey ?? (process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY);
    if (supabaseUrl && supabaseAnonKey) {
      try {
        this.client = createClient(supabaseUrl, supabaseAnonKey);
      } catch (err) {
        console.warn('[SupabaseAuthProvider] Failed to initialize Supabase client:', err);
      }
    }
  }

  isConfigured(): boolean {
    return Boolean(this.client);
  }

  async verifyAccessToken(token: string): Promise<AuthenticatedUser | null> {
    if (!this.client || !token) return null;
    const cleanToken = token.startsWith('Bearer ') || token.startsWith('bearer ') ? token.slice(7).trim() : token.trim();
    if (!cleanToken) return null;

    try {
      const { data, error } = await this.client.auth.getUser(cleanToken);
      if (error || !data?.user) {
        console.warn('[SupabaseAuthProvider] Token verification failed:', error?.message);
        return null;
      }
      const sbUser = data.user;
      return {
        id: sbUser.id,
        email: sbUser.email || 'user@pubprototype.internal',
        name: (sbUser.user_metadata?.name as string) || (sbUser.user_metadata?.full_name as string) || null,
        avatarUrl: (sbUser.user_metadata?.avatar_url as string) || null,
        createdAt: new Date(sbUser.created_at),
        updatedAt: new Date(),
        role: 'MEMBER',
      };
    } catch (err) {
      console.warn('[SupabaseAuthProvider] Unexpected error during token verification:', err);
      return null;
    }
  }
}
