import "server-only";
import { DRIVE_API, isValidDriveId } from "./google";

/**
 * "Is the materials folder open to anyone with the link?" (US-2.1 KP-2, R-8,
 * ADR-003). Step 1: an ANONYMOUS metadata request with only the API key —
 * success means the folder is public. Step 2 (access level): the "anyone"
 * permission via the service account; if the Viewer service account may not
 * read permissions, the anonymous `capabilities.canEdit` is used as a hint.
 */
export type PublicAccessLevel = "reader" | "commenter" | "writer" | "unknown";

export type FolderAccess =
  | { state: "restricted" }
  | { state: "public"; level: PublicAccessLevel }
  | { state: "unknown"; reason: "not_configured" | "api_key_rejected" | "network" | "unexpected" };

async function safeFetch(fetchImpl: typeof fetch, url: string, init?: RequestInit): Promise<Response | null> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(5_000) });
  } catch {
    return null;
  }
}

function levelFromRole(role: string | undefined): PublicAccessLevel {
  if (role === "reader") return "reader";
  if (role === "commenter") return "commenter";
  if (role === "writer" || role === "fileOrganizer" || role === "organizer") return "writer";
  return "unknown";
}

export async function checkFolderPublicAccess(opts: {
  folderId: string | null;
  apiKey: string | null;
  /** Service-account token provider; optional (used only for the access level). */
  getToken?: () => Promise<string>;
  fetchImpl?: typeof fetch;
}): Promise<FolderAccess> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  if (!isValidDriveId(opts.folderId) || !opts.apiKey) return { state: "unknown", reason: "not_configured" };
  const key = encodeURIComponent(opts.apiKey);

  const anon = await safeFetch(
    fetchImpl,
    `${DRIVE_API}/files/${opts.folderId}?fields=id,capabilities(canEdit,canComment)&supportsAllDrives=true&key=${key}`,
  );
  if (!anon) return { state: "unknown", reason: "network" };
  if (anon.status === 404) return { state: "restricted" };
  if (anon.status === 400 || anon.status === 401 || anon.status === 403) {
    // A private file answers 404 to anonymous callers; 400/403 here means the key is wrong/restricted.
    return { state: "unknown", reason: "api_key_rejected" };
  }
  if (!anon.ok) return { state: "unknown", reason: "unexpected" };

  const meta = (await anon.json().catch(() => ({}))) as { capabilities?: { canEdit?: boolean; canComment?: boolean } };

  if (opts.getToken) {
    try {
      const token = await opts.getToken();
      const perms = await safeFetch(
        fetchImpl,
        `${DRIVE_API}/files/${opts.folderId}/permissions?fields=permissions(type,role)&supportsAllDrives=true`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (perms?.ok) {
        const body = (await perms.json()) as { permissions?: { type?: string; role?: string }[] };
        const anyone = (body.permissions ?? []).filter((p) => p.type === "anyone");
        if (anyone.length) {
          const levels = anyone.map((p) => levelFromRole(p.role));
          const order: PublicAccessLevel[] = ["writer", "commenter", "reader", "unknown"];
          return { state: "public", level: order.find((l) => levels.includes(l)) ?? "unknown" };
        }
      }
    } catch {
      // fall through to the anonymous hint
    }
  }
  if (meta.capabilities?.canEdit) return { state: "public", level: "writer" };
  if (meta.capabilities?.canComment) return { state: "public", level: "commenter" };
  if (meta.capabilities && meta.capabilities.canEdit === false) return { state: "public", level: "reader" };
  return { state: "public", level: "unknown" };
}
