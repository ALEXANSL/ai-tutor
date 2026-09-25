import Link from "next/link";
import { saveTutorNameAction } from "@/app/actions/child";
import { ChildCard, ghostButton } from "@/components/child/ChildCard";
import { NicknameForm } from "@/components/child/NicknameForm";
import { SignOutLink } from "@/components/child/SignOutLink";
import { TutorNamePicker } from "@/components/child/TutorNamePicker";
import { TutorAvatar } from "@/components/TutorAvatar";
import { uk } from "@/i18n/uk";
import { requireChild } from "@/server/auth/guards";
import { canChildEdit } from "@/server/persona/plan";
import { getChildPersonaSettings } from "@/server/persona/queries";

const row = "mb-3 rounded-2xl border border-line bg-surface-alt px-4 py-3.5 text-left";
const summary =
  "flex cursor-pointer list-none items-center gap-3.5 [&::-webkit-details-marker]:hidden";
const changeButton = "ml-auto flex min-h-11 items-center rounded-xl bg-primary px-3.5 text-sm font-bold text-white";

/**
 * "Мій репетитор" (US-1.7 KP-1): current name, voice, avatar; change the name
 * in ≤ 2 taps from "Today" unless the parent turned it off (PM-23). The
 * nickname can also be changed here (PM-13).
 */
export default async function MyTutorPage() {
  const { ctx, profile } = await requireChild();
  const { options, editable } = await getChildPersonaSettings(ctx.familyId);
  const canEditName = canChildEdit(editable, "name");
  const t = uk.child.myTutor;

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-16">
      <ChildCard wide>
        <h1 className="mb-2 text-[26px] font-extrabold">{t.title}</h1>
        <p className="mb-5 text-muted">{t.subtitle}</p>
        <div className="mb-5">
          <TutorAvatar state="listening" />
        </div>

        {canEditName ? (
          <details className={row}>
            <summary className={summary}>
              <span className="flex-1">
                <b className="block">{t.name(profile.tutor_name ?? "")}</b>
                <span className="text-xs text-muted">{t.nameHelp}</span>
              </span>
              <span className={changeButton}>{t.change}</span>
            </summary>
            <div className="mt-4">
              <TutorNamePicker
                options={options}
                current={profile.tutor_name}
                currentGender={profile.tutor_name_gender}
                action={saveTutorNameAction}
                submitLabel={t.save}
              />
            </div>
          </details>
        ) : (
          <div className={row}>
            <b className="block">{t.name(profile.tutor_name ?? "")}</b>
            <span className="text-xs text-muted">{t.readOnly}</span>
          </div>
        )}

        <div className={row}>
          <b className="block">{t.voice}</b>
          <span className="text-xs text-muted">{canEditName ? t.voiceHelp : t.readOnly}</span>
        </div>
        <div className={row}>
          <b className="block">{t.avatar}</b>
          <span className="text-xs text-muted">{canEditName ? t.avatarHelp : t.readOnly}</span>
        </div>

        <details className={row}>
          <summary className={summary}>
            <span className="flex-1">
              <b className="block">{t.nicknameValue(profile.nickname ?? "")}</b>
              <span className="text-xs text-muted">{t.nicknameTitle}</span>
            </span>
            <span className={changeButton}>{t.change}</span>
          </summary>
          <div className="mt-4">
            <NicknameForm initial={profile.nickname} submitLabel={t.save} />
          </div>
        </details>

        <Link href="/today" className={`${ghostButton} mt-3`}>
          {t.back}
        </Link>
        <SignOutLink />
      </ChildCard>
    </main>
  );
}
