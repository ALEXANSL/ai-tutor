import Link from "next/link";
import { ChildCard, ghostButton } from "@/components/child/ChildCard";
import { uk } from "@/i18n/uk";
import { requireChild } from "@/server/auth/guards";
import { getTutorGender } from "@/server/persona/queries";
import { AiIntro } from "../AiIntro";

/** The "I am AI" screen can be reviewed again from the menu (US-12.3 KP-1). */
export default async function AboutAiPage() {
  const { ctx, profile } = await requireChild();
  const gender = await getTutorGender(ctx.familyId, profile);
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-16">
      <ChildCard>
        <AiIntro nickname={profile.nickname ?? ""} tutorName={profile.tutor_name ?? ""} gender={gender} />
        <Link href="/today" className={ghostButton}>
          {uk.child.onboarding.aiIntro.back}
        </Link>
      </ChildCard>
    </main>
  );
}
