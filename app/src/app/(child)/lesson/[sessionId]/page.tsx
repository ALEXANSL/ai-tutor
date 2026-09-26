import { requireLessonAccess } from "@/server/auth/guards";
import { forFamily } from "@/server/db/family-scope";
import { loadLibraryItemTitles } from "@/server/lessons/generate";
import { getLessonView } from "@/server/lessons/orchestrator";
import { LessonPicker } from "@/components/lesson/LessonPicker";
import { LessonRunner } from "@/components/lesson/LessonRunner";
import { LessonPausedScreen } from "@/components/lesson/LessonPausedScreen";
import { LessonSummaryScreen } from "@/components/lesson/LessonSummaryScreen";

// Shares the 300s budget used on every page that can call into the lesson
// pipeline (`(child)/subject/[id]`, `parent/subjects/[id]`): `LessonPicker`
// here calls `chooseStartBlockAction`, which is normally cheap but keeps
// the same generous ceiling for consistency and any future slow path.
export const maxDuration = 300;

/**
 * Lesson screen (S4: open to the child herself, docs/STATUS.md — the S3
 * "режим тата only" restriction is lifted now that safety moderation
 * (ADR-009) is wired in). `requireLessonAccess()` also still lets a parent's
 * own account or tablet parent mode open it (demo, QA).
 */
export default async function LessonPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  const { familyId } = await requireLessonAccess();
  const { session, step } = await getLessonView(familyId, sessionId);

  if (session.mode === "choosing") {
    const candidates = await loadLibraryItemTitles(familyId, session.candidate_library_item_ids);
    return (
      <div className="pb-10">
        <LessonPicker sessionId={sessionId} candidates={candidates} />
      </div>
    );
  }

  if (session.status === "paused") {
    return (
      <div className="pb-10">
        <LessonPausedScreen sessionId={sessionId} reason={session.pause_reason} />
      </div>
    );
  }

  if (session.status === "completed" || !step) {
    return (
      <div className="pb-10">
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
      <LessonRunner
        sessionId={sessionId}
        subjectId={session.subject_id}
        topicId={session.topic_id}
        step={step}
        idleHintS={child?.idle_hint_s ?? 60}
        idlePauseS={child?.idle_pause_s ?? 180}
      />
    </div>
  );
}
