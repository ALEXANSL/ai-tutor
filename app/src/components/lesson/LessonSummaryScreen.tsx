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
          {/* BUG (2026-09-27 nav review, finding #1): this was `/parent/subjects/${subjectId}`
              (тато-only, S3-era route) — a child hitting the app's only primary
              button on the "урок завершено" screen landed on the "🔒 лише для
              тата" wall. S4 already added the child-facing `/subject/${subjectId}`
              route (see `(child)/subject/[id]/page.tsx`); this screen was just
              never updated to use it. */}
          <Link href={`/subject/${subjectId}`} className={primaryButton}>
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
