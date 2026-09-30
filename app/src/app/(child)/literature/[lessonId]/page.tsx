import { notFound } from "next/navigation";
import { LiteratureLessonScreen } from "@/components/literature/LiteratureLessonView";
import { requireChild } from "@/server/auth/guards";
import { getLiteratureLessonView } from "@/server/lessons/literatureView";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * S33 (PO decision 2026-09-30, corrected same day) — minimal viewer for one
 * literature-extraction topic: content + test. A `needs_review` lesson is
 * still shown here (the parent explicitly opened this link to check it);
 * RLS already keeps it out of any listing surfaced to the child by default
 * (`literature_lessons_select_child` only allows `status = 'active'`).
 */
export default async function LiteratureLessonPage({ params }: { params: Promise<{ lessonId: string }> }) {
  const { lessonId } = await params;
  if (!UUID.test(lessonId)) notFound();
  const { ctx } = await requireChild();
  const lesson = await getLiteratureLessonView(ctx.familyId, lessonId);
  if (!lesson) notFound();

  return <LiteratureLessonScreen lesson={lesson} />;
}
