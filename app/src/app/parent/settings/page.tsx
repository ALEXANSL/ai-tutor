import { PinForm } from "@/components/parent/PinForm";
import { uk } from "@/i18n/uk";
import { requireParentAccess } from "@/server/auth/guards";
import { forFamily, getFamilyTimezone } from "@/server/db/family-scope";
import { loadParentSettings } from "@/server/persona/service";
import { PageTitle, Panel } from "../ui";

/** Settings (S0 part): the parent-mode PIN (US-1.5 KP-5) and its policy. */
export default async function SettingsPage() {
  const { familyId, via } = await requireParentAccess();
  const scope = forFamily(familyId);
  const [settings, timeZone] = await Promise.all([loadParentSettings(scope), getFamilyTimezone(scope)]);
  const t = uk.parent.settings;
  const lockedUntil =
    settings.pin_locked_until && new Date(settings.pin_locked_until) > new Date()
      ? new Intl.DateTimeFormat("uk-UA", { timeZone, hour: "2-digit", minute: "2-digit" }).format(
          new Date(settings.pin_locked_until),
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
    </>
  );
}
