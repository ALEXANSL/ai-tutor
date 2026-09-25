import "server-only";
import { forFamily } from "../db/family-scope";
import { getGoogleServiceAccount, getServerSecret } from "../env";
import { getFamilyIntegration } from "../integrations";
import { DriveError, getAccessToken, isValidDriveId } from "./google";
import { checkFolderPublicAccess, type FolderAccess } from "./public-access";

/** Drive configuration of a family: folder id (env via the integrations seam) + service account. */
export async function getDriveAccess(familyId: string): Promise<{ folderId: string; token: () => Promise<string> }> {
  const folderId = await getFamilyIntegration(familyId, "drive_materials_folder");
  const sa = getGoogleServiceAccount();
  if (!isValidDriveId(folderId) || !sa) {
    throw new DriveError("Drive folder or service account is not configured", null, "not_configured");
  }
  return { folderId, token: () => getAccessToken(sa) };
}

export async function isDriveConfigured(familyId: string): Promise<boolean> {
  const folderId = await getFamilyIntegration(familyId, "drive_materials_folder");
  return isValidDriveId(folderId) && getGoogleServiceAccount() !== null;
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
