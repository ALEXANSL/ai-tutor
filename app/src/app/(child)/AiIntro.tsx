import { TutorAvatar } from "@/components/TutorAvatar";
import { uk, type TutorGender } from "@/i18n/uk";
import { gendered } from "@/lib/persona/gender";

/** US-12.3 KP-1 / US-1.7 KP-10: honest "I am AI" + "Dad can read all our chats". */
export function AiIntro({ nickname, tutorName, gender }: { nickname: string; tutorName: string; gender: TutorGender }) {
  const t = uk.child.onboarding.aiIntro;
  return (
    <>
      <div className="mb-4">
        <TutorAvatar state="speaking" />
      </div>
      <h1 className="mb-4 text-[26px] font-extrabold">{t.greeting(nickname, tutorName)}</h1>
      <div className="mb-6 rounded-[18px] bg-surface-alt px-5 py-4 text-left text-[17px] leading-relaxed">
        <p>{t.body(gendered(gender, uk.ai.roleNoun))}</p>
        <p className="mt-3">{t.parentCanRead}</p>
      </div>
    </>
  );
}
