"use client";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * S34: the ONLY place this app creates a Supabase client in the browser,
 * and it is used for exactly one thing — `storage.uploadToSignedUrl()` for
 * the course-package zip (`CourseZipUploadButton.tsx`). It holds the
 * public anon key only (same `NEXT_PUBLIC_*` values already inlined into
 * every page) and is never used for auth or any table query; the signed
 * upload TOKEN (from our own server, `course-import/init`) is what
 * actually authorizes the upload, not this client's own permissions.
 */
let cached: SupabaseClient | null = null;
export function getBrowserSupabaseStorageClient(): SupabaseClient | null {
  if (cached) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  cached = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  return cached;
}
