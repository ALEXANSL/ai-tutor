import { uk } from "@/i18n/uk";
import { requireParentAccess } from "@/server/auth/guards";
import { forFamily } from "@/server/db/family-scope";
import { loadLibraryItemTitles } from "@/server/lessons/generate";
import { getLessonView } from "@/server/lessons/orchestrator";
import { LessonPicker } from "@/components/lesson/LessonPicker";
import { LessonRunner } from "@/components/lesson/LessonRunner";
import { LessonPausedScreen } from "@/components/lesson/LessonPausedScreen";
import { LessonSummaryScreen } from "@/components/lesson/LessonSummaryScreen";
import { ParentOnlyBadge } from "@/components/lesson/ParentOnlyBadge";

/**
 * S3 lesson screen. Access is `requireParentAccess()`, not `requireChild()`:
 * per the backlog note for S3, a lesson opens only in "режим тата" / for the
 * parent until S4's safety rules are verified — the badge below says so.
 */
export default async function LessonPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  const { familyId } = await requireParentAccess();
  const t = uk.child.lesson;
  const { session, step } = await getLessonView(familyId, sessionId);

  if (session.mode === "choosing") {
    const candidates = await loadLibraryItemTitles(familyId, session.candidate_library_item_ids);
    return (
      <div className="pb-10">
        <ParentOnlyBadge />
        <LessonPicker sessionId={sessionId} candidates={candidates} />
      </div>
    );
  }

  if (session.status === "paused") {
    return (
      <div className="pb-10">
        <ParentOnlyBadge />
        <LessonPausedScreen sessionId={sessionId} reason={session.pause_reason} />
      </div>
    );
  }

  if (session.status === "completed" || !step) {
    return (
      <div className="pb-10">
        <ParentOnlyBadge />
        <LessonSummaryScreen subjectId={session.subject_id} />
      </div>
    );
  }

  const { data: child } = await forFamily(familyId)
    .select("child_profile", "idle_hint_s, idle_pause_s")
    .eq("id", session.child_profile_id)
    .maybeSingle<{ idle_hint_s: number; idle_pause_s: number }>();

  return (
    <div className="pb-10">
      <ParentOnlyBadge />
      <LessonRunner
        sessionId={sessionId}
        subjectId={session.subject_id}
        topicId={session.topic_id}
        step={step}
        idleHintS={child?.idle_hint_s ?? 60}
        idlePauseS={child?.idle_pause_s ?? 180}
        labels={t}
      />
    </div>
  );
}
