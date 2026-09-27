import { uk } from "@/i18n/uk";

export type DriveConnectQueryStatus = "connected" | "denied" | "state" | "not_configured" | "failed" | null;

/**
 * "Підключити Google Drive" (ADR-024): a plain link, not a client action —
 * this is a full-page redirect into Google's consent screen and back
 * (`/api/google/drive/connect` → `/api/google/drive/callback`), so no
 * client-side state is needed here. A Server Component (no "use client"):
 * `errorMessage`/`pasteHint` may name an exact env var (BUG-005 pattern) and
 * must arrive already resolved from the server, never through the shared
 * `uk` dictionary that client components import (see
 * `lib/drive-connect-messages.ts`).
 */
export function GoogleDriveConnectPanel({
  connected,
  connectedAt,
  uploadsFolderId,
  queryStatus,
  pasteHint,
  errorMessage,
}: {
  connected: boolean;
  connectedAt: string | null;
  uploadsFolderId: string | null;
  queryStatus: DriveConnectQueryStatus;
  /** Only shown when `connected && uploadsFolderId` — the not-yet-in-env one-time step. */
  pasteHint: string;
  /** Resolved message for `queryStatus === "not_configured"`; ignored otherwise. */
  errorMessage: string;
}) {
  const t = uk.parent.settings.drive;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-bold">{connected ? t.connected(connectedAt) : t.notConnected}</p>
      <p className="text-[13px] text-p-muted">{t.help}</p>
      {!connected && (
        <a
          href="/api/google/drive/connect"
          className="inline-flex min-h-11 items-center justify-center gap-1.5 self-start rounded-xl bg-p-primary px-4 text-[14px] font-bold text-white"
        >
          {t.connect}
        </a>
      )}
      {connected && uploadsFolderId && (
        <div className="rounded-xl bg-p-bg px-3 py-2.5 text-[13px]">
          <p className="mb-1 font-bold">{t.folderCreated}</p>
          <p className="mb-1 text-p-muted">{pasteHint}</p>
          <code className="block select-all break-all rounded-lg bg-p-surface px-2 py-1 text-[12px]">{uploadsFolderId}</code>
        </div>
      )}
      {queryStatus === "connected" && <p role="status" className="text-[13px] font-bold text-p-success">{t.justConnected}</p>}
      {queryStatus && queryStatus !== "connected" && (
        <p role="alert" className="text-[13px] font-bold text-p-danger">
          {queryStatus === "not_configured" ? errorMessage : t.errors[queryStatus]}
        </p>
      )}
    </div>
  );
}
