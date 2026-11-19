import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export type SupabaseConnectionStatus = 'connected' | 'local' | 'syncing' | 'error';

const rawUrl = String(import.meta.env?.VITE_SUPABASE_URL ?? '').trim();
const rawAnonKey = String(
  import.meta.env?.VITE_SUPABASE_ANON_KEY ?? import.meta.env?.VITE_SUPABASE_PUBLISHABLE_KEY ?? ''
).trim();

function isValidHttpUrl(value: string): boolean {
  if (!value || value === 'MY_SUPABASE_URL') return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function createSafeSupabaseClient(): SupabaseClient | null {
  if (!isValidHttpUrl(rawUrl) || !rawAnonKey || rawAnonKey === 'MY_SUPABASE_ANON_KEY') {
    return null;
  }
  try {
    return createClient(rawUrl, rawAnonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  } catch {
    return null;
  }
}

export const supabase: SupabaseClient | null = createSafeSupabaseClient();
export const isSupabaseConfigured: boolean = supabase !== null;
