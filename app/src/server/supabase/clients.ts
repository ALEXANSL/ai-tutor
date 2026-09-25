import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getPublicSupabaseConfig, requireServiceRoleKey } from "../env";

/**
 * Per-request Supabase client acting AS the signed-in user (RLS applies).
 * Cookie writes from Server Components are ignored; the proxy refreshes sessions.
 */
export async function createUserClient(): Promise<SupabaseClient> {
  const cfg = getPublicSupabaseConfig();
  if (!cfg) throw new Error("Supabase public config is missing");
  const cookieStore = await cookies();
  return createServerClient(cfg.url, cfg.anonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) cookieStore.set(name, value, options);
        } catch {
          // Called from a Server Component: the proxy persists refreshed cookies.
        }
      },
    },
  });
}

/**
 * Service-role client: bypasses RLS. Use ONLY on the server after a role
 * check, and always scope queries to the caller's family (see forFamily).
 */
export function createServiceClient(): SupabaseClient {
  const cfg = getPublicSupabaseConfig();
  if (!cfg) throw new Error("Supabase public config is missing");
  return createClient(cfg.url, requireServiceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
