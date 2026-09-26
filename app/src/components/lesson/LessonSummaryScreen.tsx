import Link from "next/link";
import { ChildCard, primaryButton } from "@/components/child/ChildCard";
import { uk } from "@/i18n/uk";

/** US-6.7 КП-3: "Ще урок" is only ever the child's own action — no auto-start. */
export function LessonSummaryScreen({ subjectId }: { subjectId: string }) {
  const t = uk.child.lesson;
  return (
    <div className="flex min-h-[70vh] items-center justify-center px-4 py-8">
      <ChildCard>
        <h1 className="mb-1 text-2xl font-extrabold">{t.summaryTitle}</h1>
        <p className="mb-6 text-sm text-muted">{t.summaryBody}</p>
        <div className="grid gap-3">
          <Link href={`/parent/subjects/${subjectId}`} className={primaryButton}>
            {t.moreLesson}
          </Link>
          <Link href="/today" className="text-sm font-bold text-muted">
            {t.backToToday}
          </Link>
        </div>
      </ChildCard>
    </div>
  );
}
