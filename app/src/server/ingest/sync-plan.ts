/**
 * "Перевірити папку": compares the Drive folder with known materials
 * (US-2.1, US-2.7 KP-4, US-2.6 KP-5, KP-6). Pure — unit-tested.
 */
export interface KnownMaterial {
  id: string;
  drive_file_id: string;
  name: string;
  drive_md5: string | null;
  drive_modified_time: string | null;
  status: string;
  status_detail: string | null;
}

export interface FolderFile {
  id: string;
  name: string;
  mimeType: string;
  md5Checksum?: string;
  modifiedTime?: string;
  size?: string;
  format: "pdf" | "epub";
}

/** Errors that a new check of the folder may fix (configuration was added later). */
export const RETRY_ON_SYNC_DETAILS = new Set(["ai_not_configured", "drive_not_configured", "drive_forbidden"]);

export interface SyncPlan {
  insert: { file: FolderFile; status: "queued" | "deferred" }[];
  requeue: { id: string; file: FolderFile; status: "queued" | "deferred" }[];
  rename: { id: string; name: string }[];
  remove: string[];
}

function changed(m: KnownMaterial, f: FolderFile): boolean {
  if (m.drive_md5 && f.md5Checksum) return m.drive_md5 !== f.md5Checksum;
  if (m.drive_modified_time && f.modifiedTime) {
    return new Date(m.drive_modified_time).getTime() !== new Date(f.modifiedTime).getTime();
  }
  return false;
}

export function planSync(known: KnownMaterial[], files: FolderFile[], opts: { budgetBlocked: boolean }): SyncPlan {
  const status = opts.budgetBlocked ? ("deferred" as const) : ("queued" as const);
  const byDriveId = new Map(known.map((m) => [m.drive_file_id, m]));
  const seen = new Set<string>();
  const plan: SyncPlan = { insert: [], requeue: [], rename: [], remove: [] };

  for (const f of files) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    const m = byDriveId.get(f.id);
    if (!m) {
      plan.insert.push({ file: f, status });
      continue;
    }
    if (m.name !== f.name) plan.rename.push({ id: m.id, name: f.name });
    const needsWork =
      m.status === "removed" ||
      changed(m, f) ||
      (m.status === "deferred" && !opts.budgetBlocked) ||
      (m.status === "error" && RETRY_ON_SYNC_DETAILS.has(m.status_detail ?? ""));
    if (needsWork) plan.requeue.push({ id: m.id, file: f, status });
  }
  for (const m of known) {
    if (!seen.has(m.drive_file_id) && m.status !== "removed") plan.remove.push(m.id);
  }
  return plan;
}
