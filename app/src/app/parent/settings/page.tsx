import { listLiteratureCandidateMaterials } from "@/app/actions/literature-extraction";
import { ContentQaSweepPanel } from "@/components/parent/ContentQaSweepPanel";
import { LiteratureExtractionPanel } from "@/components/parent/LiteratureExtractionPanel";
import { GoogleDriveConnectPanel, type DriveConnectQueryStatus } from "@/components/parent/GoogleDriveConnectPanel";
import { PinForm } from "@/components/parent/PinForm";
import { UrgentChannelsPanel } from "@/components/parent/UrgentChannelsPanel";
import { uk } from "@/i18n/uk";
import { requireParentAccess } from "@/server/auth/guards";
import { forFamily, getFamilyTimezone } from "@/server/db/family-scope";
import { getDriveConnectionStatus } from "@/server/drive/oauth";
import { DRIVE_OAUTH_NOT_CONFIGURED_MESSAGE, DRIVE_UPLOADS_FOLDER_PASTE_HINT } from "@/lib/drive-connect-messages";
import { isEmailConfigured } from "@/server/notify/email";
import { loadParentSettings } from "@/server/persona/service";
import { PageTitle, Panel } from "../ui";

type Search = Promise<{ drive?: string; drive_error?: string }>;
const KNOWN_ERRORS: DriveConnectQueryStatus[] = ["denied", "state", "not_configured", "failed"];

// The content_qa sweep can process the whole library and take a while
// (§ContentQaSweepPanel) — same generous budget as the books indexing
// routes and the lesson-generation pages (`(child)/subject/[id]`, etc.).
export const maxDuration = 300;

/** Settings (S0 part): the parent-mode PIN (US-1.5 KP-5) and its policy. */
export default async function SettingsPage({ searchParams }: { searchParams: Search }) {
  const { familyId, via } = await requireParentAccess();
  const scope = forFamily(familyId);
  const [settings, timeZone, drive, query, literatureMaterials] = await Promise.all([
    loadParentSettings(scope),
    getFamilyTimezone(scope),
    getDriveConnectionStatus(familyId),
    searchParams,
    listLiteratureCandidateMaterials(familyId),
  ]);
  const t = uk.parent.settings;
  const queryStatus: DriveConnectQueryStatus =
    query.drive === "connected"
      ? "connected"
      : (KNOWN_ERRORS.find((e) => e === query.drive_error) ?? null);
  const lockedUntil =
    settings.pin_locked_until && new Date(settings.pin_locked_until) > new Date()
      ? new Intl.DateTimeFormat("uk-UA", { timeZone, hour: "2-digit", minute: "2-digit" }).format(
          new Date(settings.pin_locked_until),
        )
      : null;
  const driveConnectedAt = drive.connectedAt
    ? new Intl.DateTimeFormat("uk-UA", { timeZone, day: "2-digit", month: "2-digit", year: "numeric" }).format(
        new Date(drive.connectedAt),
      )
    : null;

  return (
    <>
      <PageTitle>{t.title}</PageTitle>
      <Panel title={t.pinTitle}>
        <p className="mb-1 text-sm font-bold">{settings.pin_hash ? t.pinCurrentSet : t.pinCurrentNotSet}</p>
        {lockedUntil && <p className="mb-1 text-sm font-bold text-p-danger">{t.pinLockedUntil(lockedUntil)}</p>}
        <p className="mb-4 text-sm text-p-muted">{t.pinHelp}</p>
        <p className="mb-4 text-xs text-p-muted">
          {t.policy(settings.pin_max_attempts, settings.pin_lock_minutes, settings.parent_mode_idle_min)}
        </p>
        {via === "account" ? <PinForm /> : <p className="text-sm">{t.pinOnlyOwnAccount}</p>}
      </Panel>
      <Panel title={t.urgentTitle}>
        <p className="mb-3 text-[13px] text-p-muted">{t.urgentHelp}</p>
        <UrgentChannelsPanel emailConfigured={isEmailConfigured()} telegramLinked={settings.telegram_linked_at != null} />
      </Panel>
      <Panel title={t.drive.title}>
        {via === "account" ? (
          <GoogleDriveConnectPanel
            connected={drive.connected}
            connectedAt={driveConnectedAt}
            uploadsFolderId={drive.uploadsFolderId}
            queryStatus={queryStatus}
            pasteHint={DRIVE_UPLOADS_FOLDER_PASTE_HINT}
            errorMessage={DRIVE_OAUTH_NOT_CONFIGURED_MESSAGE}
          />
        ) : (
          <p className="text-sm">{t.drive.onlyOwnAccount}</p>
        )}
      </Panel>
      <Panel title={t.maintenance.title}>
        <ContentQaSweepPanel />
      </Panel>
      <Panel title={t.literatureExtraction.title}>
        <LiteratureExtractionPanel materials={literatureMaterials} />
      </Panel>
    </>
  );
}
