import "server-only";
import { getServerSecret } from "../env";
import { createServiceClient } from "../supabase/clients";
import { DriveError, DRIVE_API, isValidDriveId } from "./google";

/**
 * Shared parent-owned OAuth `drive.file` connector (ADR-024, D-79): one
 * consent screen creates + auto-shares the "ШІ-Репетитор — Мої книги" folder
 * for book uploads, and is deliberately generic (see `ensureAppFolder` /
 * `grantServiceAccountReader` below) so the future media archive (D-67/S17)
 * reuses the very same token and helpers instead of a second connector.
 *
 * `drive.file` is a non-sensitive scope (docs/03 1.5 step 4): the token only
 * ever sees files/folders this app itself created, never the parent's whole
 * Drive — so a leaked token cannot reach anything else in "Мій диск".
 */
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const FOLDER_MIME = "application/vnd.google-apps.folder";

/** The one folder this slice creates (US-2.7, ADR-024); the archive folder name is D-67/S17's concern. */
export const UPLOADS_FOLDER_NAME = "ШІ-Репетитор — Мої книги";

export function isOAuthClientConfigured(): boolean {
  return !!getServerSecret("GOOGLE_OAUTH_CLIENT_ID") && !!getServerSecret("GOOGLE_OAUTH_CLIENT_SECRET");
}

/** `null` only when the OAuth client id/secret are not yet in env (BUG-005-style: caller shows a specific message). */
export function buildAuthorizeUrl(redirectUri: string, state: string): string | null {
  const clientId = getServerSecret("GOOGLE_OAUTH_CLIENT_ID");
  if (!clientId) return null;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    // Forces Google to hand back a refresh token even on a repeat consent
    // (otherwise a reconnect after revoking access would silently fail).
    prompt: "consent",
    state,
  });
  return `${AUTH_URL}?${params}`;
}

async function tokenRequest(
  body: URLSearchParams,
  fetchImpl: typeof fetch,
): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
  let res: Response;
  try {
    res = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new DriveError("oauth token request failed", null, "network");
  }
  if (!res.ok) throw new DriveError(`oauth token request rejected (${res.status})`, res.status, "forbidden");
  return res.json();
}

function oauthClient(): { clientId: string; clientSecret: string } | null {
  const clientId = getServerSecret("GOOGLE_OAUTH_CLIENT_ID");
  const clientSecret = getServerSecret("GOOGLE_OAUTH_CLIENT_SECRET");
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

async function exchangeAuthorizationCode(
  code: string,
  redirectUri: string,
  fetchImpl: typeof fetch,
): Promise<{ access_token: string; refresh_token?: string }> {
  const client = oauthClient();
  if (!client) throw new DriveError("OAuth client is not configured", null, "not_configured");
  return tokenRequest(
    new URLSearchParams({
      code,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
    fetchImpl,
  );
}

/** OAuth client secret doubles as the pgcrypto passphrase (same pattern as the Telegram bot token, S4 migration). */
function passphrase(): string | null {
  return getServerSecret("GOOGLE_OAUTH_CLIENT_SECRET");
}

async function storeRefreshToken(familyId: string, token: string): Promise<void> {
  const pass = passphrase();
  if (!pass) throw new DriveError("OAuth client is not configured", null, "not_configured");
  const { error } = await createServiceClient().rpc("set_drive_refresh_token", {
    p_family_id: familyId,
    p_token: token,
    p_passphrase: pass,
  });
  if (error) throw new Error(`set_drive_refresh_token failed: ${error.message}`);
  userTokenCache.delete(familyId);
}

async function readRefreshToken(familyId: string): Promise<string | null> {
  const pass = passphrase();
  if (!pass) return null;
  const { data, error } = await createServiceClient().rpc("get_drive_refresh_token", {
    p_family_id: familyId,
    p_passphrase: pass,
  });
  if (error) {
    console.error(`get_drive_refresh_token failed: ${error.message}`);
    return null;
  }
  return (data as string | null) ?? null;
}

const userTokenCache = new Map<string, { token: string; expiresAt: number }>();

/**
 * Short-lived Drive access token for the parent's own `drive.file` grant
 * (distinct from the read-only materials service account in `google.ts`).
 * Cached in memory per family until shortly before it expires.
 */
export async function getUserAccessToken(familyId: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const cached = userTokenCache.get(familyId);
  const now = Date.now();
  if (cached && cached.expiresAt - 60_000 > now) return cached.token;
  const client = oauthClient();
  if (!client) throw new DriveError("OAuth client is not configured", null, "not_configured");
  const refreshToken = await readRefreshToken(familyId);
  if (!refreshToken) throw new DriveError("Google Drive is not connected", null, "not_configured");
  const body = await tokenRequest(
    new URLSearchParams({
      refresh_token: refreshToken,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      grant_type: "refresh_token",
    }),
    fetchImpl,
  );
  userTokenCache.set(familyId, { token: body.access_token, expiresAt: now + (body.expires_in ?? 3600) * 1000 });
  return body.access_token;
}

async function findAppFolder(name: string, token: string, fetchImpl: typeof fetch): Promise<string | null> {
  const escaped = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const params = new URLSearchParams({
    q: `name = '${escaped}' and mimeType = '${FOLDER_MIME}' and trashed = false`,
    fields: "files(id)",
    pageSize: "1",
  });
  const res = await fetchImpl(`${DRIVE_API}/files?${params}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new DriveError(`drive folder lookup failed (${res.status})`, res.status, "http");
  const body = (await res.json()) as { files?: { id: string }[] };
  return body.files?.[0]?.id ?? null;
}

async function createAppFolder(name: string, token: string, fetchImpl: typeof fetch): Promise<string> {
  const res = await fetchImpl(`${DRIVE_API}/files?fields=id`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new DriveError(`drive folder create failed (${res.status})`, res.status, "http");
  const body = (await res.json()) as { id: string };
  return body.id;
}

/**
 * Idempotent "create my own folder" (ADR-024 §2): reuses a same-named folder
 * this app already created (visible to a `drive.file` token only if it was
 * created by this app, so a name match can only be our own earlier folder),
 * instead of creating a duplicate on every reconnect. General enough to be
 * called again for the D-67 archive folder without changes.
 */
export async function ensureAppFolder(name: string, token: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const existing = await findAppFolder(name, token, fetchImpl);
  return existing ?? createAppFolder(name, token, fetchImpl);
}

/**
 * Grants the existing materials-reading service account "Читач" on a folder
 * the app owns (ADR-024 §3) — replaces the manual Drive "Поділитися" step.
 * Idempotent: skips the call if that role is already granted.
 */
export async function grantServiceAccountReader(
  folderId: string,
  token: string,
  serviceAccountEmail: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const list = await fetchImpl(`${DRIVE_API}/files/${folderId}/permissions?fields=permissions(emailAddress,role)`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (list.ok) {
    const body = (await list.json()) as { permissions?: { emailAddress?: string; role?: string }[] };
    const already = (body.permissions ?? []).some(
      (p) => p.emailAddress === serviceAccountEmail && (p.role === "reader" || p.role === "writer"),
    );
    if (already) return;
  }
  const res = await fetchImpl(`${DRIVE_API}/files/${folderId}/permissions?sendNotificationEmail=false`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ role: "reader", type: "user", emailAddress: serviceAccountEmail }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new DriveError(`drive permission grant failed (${res.status})`, res.status, "http");
}

export interface DriveConnectionStatus {
  connected: boolean;
  connectedAt: string | null;
  uploadsFolderId: string | null;
}

export async function getDriveConnectionStatus(familyId: string): Promise<DriveConnectionStatus> {
  const { data } = await createServiceClient()
    .from("drive_oauth_connections")
    .select("connected_at, uploads_folder_id")
    .eq("family_id", familyId)
    .maybeSingle<{ connected_at: string | null; uploads_folder_id: string | null }>();
  return {
    connected: !!data?.connected_at,
    connectedAt: data?.connected_at ?? null,
    uploadsFolderId: isValidDriveId(data?.uploads_folder_id) ? data!.uploads_folder_id : null,
  };
}

/**
 * The whole "Підключити Google Drive" flow (ADR-024 §2-3): exchanges the
 * authorization code, stores the refresh token, creates (or reuses) the
 * uploads folder and shares it with the materials service account. Returns
 * the folder id so the parent screen can show it for the one remaining
 * manual step — pasting it into `GOOGLE_DRIVE_UPLOADS_FOLDER_ID` (same
 * pattern as the archive folder, docs/03 1.6.6).
 */
export async function connectGoogleDrive(
  familyId: string,
  code: string,
  redirectUri: string,
  serviceAccountEmail: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<{ uploadsFolderId: string }> {
  const tokens = await exchangeAuthorizationCode(code, redirectUri, fetchImpl);
  if (!tokens.refresh_token) {
    // Should not happen with prompt=consent, but never silently "succeed" without one.
    throw new DriveError("Google did not return a refresh token", null, "forbidden");
  }
  await storeRefreshToken(familyId, tokens.refresh_token);
  const uploadsFolderId = await ensureAppFolder(UPLOADS_FOLDER_NAME, tokens.access_token, fetchImpl);
  if (serviceAccountEmail) {
    await grantServiceAccountReader(uploadsFolderId, tokens.access_token, serviceAccountEmail, fetchImpl);
  }
  const { error } = await createServiceClient()
    .from("drive_oauth_connections")
    .update({ uploads_folder_id: uploadsFolderId })
    .eq("family_id", familyId);
  if (error) throw new Error(`drive_oauth_connections update failed: ${error.message}`);
  return { uploadsFolderId };
}
