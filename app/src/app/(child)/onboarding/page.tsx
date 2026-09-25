import { redirect } from "next/navigation";
import { completeOnboardingAction, saveTutorNameAction } from "@/app/actions/child";
import { ChildCard, StepDots, primaryButton } from "@/components/child/ChildCard";
import { NicknameForm } from "@/components/child/NicknameForm";
import { TutorNamePicker } from "@/components/child/TutorNamePicker";
import { uk } from "@/i18n/uk";
import { requireChild } from "@/server/auth/guards";
import { getChildPersonaSettings, getTutorGender } from "@/server/persona/queries";
import { AiIntro } from "../AiIntro";

const TOTAL_STEPS = 3;

/**
 * First-login onboarding (US-1.6 KP-1, KP-5; US-12.3 KP-1): ≤ 3 screens —
 * nickname → tutor name → "I am AI". Voice stays default until S12; the
 * avatar is the default "flame" until S25.
 */
export default async function OnboardingPage() {
  const { ctx, profile } = await requireChild({ allowOnboarding: true });
  if (profile.onboarding_completed_at) redirect("/today");
  const t = uk.child.onboarding;
  const step = !profile.nickname ? 1 : !profile.tutor_name ? 2 : 3;
  const dots = <StepDots step={step} total={TOTAL_STEPS} label={t.stepLabel(step, TOTAL_STEPS)} />;

  let body: React.ReactNode;
  if (step === 1) {
    body = (
      <>
        <h1 className="mb-2 text-[26px] font-extrabold">{t.nickname.title}</h1>
        <p className="mb-6 text-base leading-relaxed text-muted">{t.nickname.subtitle}</p>
        <NicknameForm submitLabel={t.nickname.submit} />
      </>
    );
  } else if (step === 2) {
    const { options } = await getChildPersonaSettings(ctx.familyId);
    body = (
      <>
        <h1 className="mb-2 text-[26px] font-extrabold">{t.tutorName.title}</h1>
        <p className="mb-6 text-base leading-relaxed text-muted">{t.tutorName.subtitle}</p>
        <TutorNamePicker options={options} current={null} action={saveTutorNameAction} submitLabel={t.tutorName.submit} />
      </>
    );
  } else {
    const gender = await getTutorGender(ctx.familyId, profile);
    body = (
      <>
        <AiIntro nickname={profile.nickname!} tutorName={profile.tutor_name!} gender={gender} />
        <form action={completeOnboardingAction}>
          <button type="submit" className={primaryButton}>
            {t.aiIntro.submit}
          </button>
        </form>
      </>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-16">
      <ChildCard wide={step === 2}>
        {dots}
        {body}
      </ChildCard>
    </main>
  );
}
