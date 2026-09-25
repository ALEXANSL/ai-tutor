import { parentSetPersonaEditableAction } from "@/app/actions/parent";
import { ParentNicknameForm, ParentTutorNameForm } from "@/components/parent/ChildProfileForms";
import { TutorAvatar } from "@/components/TutorAvatar";
import { uk } from "@/i18n/uk";
import { requireParentAccess } from "@/server/auth/guards";
import { forFamily } from "@/server/db/family-scope";
import type { ChildProfileRow } from "@/server/db/types";
import { canChildEdit } from "@/server/persona/plan";
import { loadParentSettings } from "@/server/persona/service";
import { PageTitle, Panel, parentButton } from "../ui";

/** Child profile (mockup 13, S0 part): nickname, tutor persona, PM-23 switch. */
export default async function ParentChildPage() {
  const { familyId } = await requireParentAccess();
  const scope = forFamily(familyId);
  const [{ data: profile }, settings] = await Promise.all([
    scope.select("child_profile").limit(1).maybeSingle<ChildProfileRow>(),
    loadParentSettings(scope),
  ]);
  const t = uk.parent.child;
  const editable = canChildEdit(settings.persona_child_editable, "name");

  return (
    <>
      <PageTitle>{t.title}</PageTitle>
      {!profile ? (
        <Panel>
          <p className="text-p-muted">{t.notOnboarded}</p>
        </Panel>
      ) : (
        <>
          <Panel title={t.basics}>
            <ParentNicknameForm nickname={profile.nickname} />
          </Panel>
          <Panel title={t.tutorTitle}>
            <div className="flex flex-wrap gap-6">
              <div className="flex flex-col items-center gap-2">
                <TutorAvatar size="md" state="listening" />
              </div>
              <div className="flex min-w-[240px] flex-1 flex-col gap-4">
                <ParentTutorNameForm
                  options={settings.tutor_name_options}
                  current={profile.tutor_name}
                />
                <dl className="text-[13px]">
                  <div className="flex justify-between gap-3 border-b border-p-line py-2">
                    <dt className="text-p-muted">{t.voice}</dt>
                    <dd className="text-right font-bold">{t.voiceDefault}</dd>
                  </div>
                  <div className="flex justify-between gap-3 py-2">
                    <dt className="text-p-muted">{t.avatar}</dt>
                    <dd className="text-right font-bold">{t.avatarDefault}</dd>
                  </div>
                </dl>
                <form action={parentSetPersonaEditableAction} className="flex flex-wrap items-center gap-3">
                  <label className="flex min-h-11 flex-1 items-center gap-2.5 text-[14px]">
                    <input type="checkbox" name="editable" defaultChecked={editable} className="h-5 w-5 accent-[var(--p-primary)]" />
                    {t.editableLabel}
                  </label>
                  <button type="submit" className={parentButton}>
                    {t.save}
                  </button>
                </form>
              </div>
            </div>
          </Panel>
        </>
      )}
    </>
  );
}
