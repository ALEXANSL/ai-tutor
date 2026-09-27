import "server-only";
import { forFamily } from "../db/family-scope";
import { getGoogleServiceAccount, getServerSecret } from "../env";
import { getFamilyIntegration } from "../integrations";
import { DriveError, getAccessToken, isValidDriveId } from "./google";
import { checkFolderPublicAccess, type FolderAccess } from "./public-access";

/**
 * The service-account token alone, with no folder-id requirement: downloading
 * a known `drive_file_id` (indexing steps) never needs a folder id, only a
 * configured service account — a book uploaded into the "Мої книги" folder
 * (ADR-024) must download the same way even before the materials folder
 * itself is configured.
 */
export async function getDriveToken(): Promise<() => Promise<string>> {
  const sa = getGoogleServiceAccount();
  if (!sa) throw new DriveError("Google service account is not configured", null, "not_configured");
  return () => getAccessToken(sa);
}

export async function isDriveConfigured(familyId: string): Promise<boolean> {
  const folderId = await getFamilyIntegration(familyId, "drive_materials_folder");
  return isValidDriveId(folderId) && getGoogleServiceAccount() !== null;
}

/** Service account e-mail (ADR-024 §3): shared with the parent's uploads folder via `permissions.create`. */
export function getServiceAccountEmail(): string | null {
  return getGoogleServiceAccount()?.clientEmail ?? null;
}

/**
 * Every folder the materials-indexing service account is configured to scan
 * (docs/02 10.3): the manually-shared materials folder, and — once the
 * parent has pasted its id after connecting Google Drive (ADR-024) — the
 * app-owned, auto-shared "Мої книги" uploads folder. Both are scanned the
 * same way by `syncDriveFolder`; nothing else in the ingest pipeline changes.
 */
export async function getConfiguredDriveFolders(
  familyId: string,
): Promise<{ kind: "materials" | "uploads"; folderId: string }[]> {
  const [materials, uploads] = await Promise.all([
    getFamilyIntegration(familyId, "drive_materials_folder"),
    getFamilyIntegration(familyId, "drive_uploads_folder"),
  ]);
  const out: { kind: "materials" | "uploads"; folderId: string }[] = [];
  if (isValidDriveId(materials)) out.push({ kind: "materials", folderId: materials });
  if (isValidDriveId(uploads)) out.push({ kind: "uploads", folderId: uploads });
  return out;
}

export async function isUploadsFolderConfigured(familyId: string): Promise<boolean> {
  const folderId = await getFamilyIntegration(familyId, "drive_uploads_folder");
  return isValidDriveId(folderId);
}

/** Link to the folder, built on the server for the parent only (US-2.7 KP-4, NFR-PRIV-8). */
export async function getDriveFolderUrl(familyId: string): Promise<string | null> {
  const folderId = await getFamilyIntegration(familyId, "drive_materials_folder");
  return isValidDriveId(folderId) ? `https://drive.google.com/drive/folders/${folderId}` : null;
}

const KIND = "drive_materials_public";
const TTL_MS = 10 * 60_000;

export interface StoredFolderAccess {
  access: FolderAccess;
  checkedAt: string;
}

/**
 * Cached public-access status (checked at most every 10 min, or on demand).
 * Shown as a warning on the dashboard and in "Мої книги" (US-2.1 KP-2).
 */
export async function getFolderAccessStatus(familyId: string, opts: { force?: boolean } = {}): Promise<StoredFolderAccess> {
  const scope = forFamily(familyId);
  if (!opts.force) {
    const { data } = await scope
      .select("integration_status", "status, checked_at")
      .eq("kind", KIND)
      .maybeSingle<{ status: FolderAccess; checked_at: string }>();
    if (data && Date.now() - new Date(data.checked_at).getTime() < TTL_MS) {
      return { access: data.status, checkedAt: data.checked_at };
    }
  }
  const folderId = await getFamilyIntegration(familyId, "drive_materials_folder");
  const sa = getGoogleServiceAccount();
  const access = await checkFolderPublicAccess({
    folderId,
    apiKey: getServerSecret("GOOGLE_API_KEY"),
    getToken: sa ? () => getAccessToken(sa) : undefined,
  });
  const checkedAt = new Date().toISOString();
  const { error } = await scope.upsert("integration_status", { kind: KIND, status: access, checked_at: checkedAt }, "family_id,kind");
  if (error) console.error(`integration_status upsert failed: ${error.message}`);
  return { access, checkedAt };
}
