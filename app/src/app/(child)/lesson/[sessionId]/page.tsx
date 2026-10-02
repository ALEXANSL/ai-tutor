import { redirect } from "next/navigation";
import { requireLessonAccess } from "@/server/auth/guards";
import { forFamily } from "@/server/db/family-scope";
import { loadLibraryItemTitles } from "@/server/lessons/generate";
import { getActiveLiteratureLessonIdForTopic } from "@/server/lessons/literatureView";
import { getActiveCourseLessonIdForTopic } from "@/server/lessons/courseView";
import { getLessonView } from "@/server/lessons/orchestrator";
import { LessonPicker } from "@/components/lesson/LessonPicker";
import { LessonRunner } from "@/components/lesson/LessonRunner";
import { LessonPausedScreen } from "@/components/lesson/LessonPausedScreen";
import { LessonSummaryScreen } from "@/components/lesson/LessonSummaryScreen";
import { LibraryWarmProgress } from "@/components/lesson/LibraryWarmProgress";

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
  const { session, step, remediation } = await getLessonView(familyId, sessionId);

  // 2026-10-02 incident: redirect ANY way of landing here (stale session,
  // bookmarked URL, cached page) straight to the S33 literature lesson if
  // this topic now has one — the old step-runner below must never be the
  // thing the child sees for such a topic again (see
  // `getActiveLiteratureLessonIdForTopic`'s doc comment).
  const literatureLessonId = await getActiveLiteratureLessonIdForTopic(familyId, session.topic_id);
  if (literatureLessonId) redirect(`/literature/${literatureLessonId}`);
  // S34: same safety net, parallel $0 image-anchored course-package import.
  const courseLessonId = await getActiveCourseLessonIdForTopic(familyId, session.topic_id);
  if (courseLessonId) redirect(`/course-lesson/${courseLessonId}`);

  // ADR-023 (D-76): a "cold" topic (zero active blocks at start) lands here
  // with no candidates yet — a `library.warm_topic` job is producing the
  // first one in the background; the progress screen polls until it (or the
  // safe fallback template) is ready, then this page re-renders as `choosing`.
  if (session.mode === "warming") {
    const scope = forFamily(familyId);
    const [{ data: subject }, { data: topic }] = await Promise.all([
      scope.select("subjects", "name_uk").eq("id", session.subject_id).maybeSingle<{ name_uk: string }>(),
      scope.select("topics", "title").eq("id", session.topic_id).maybeSingle<{ title: string }>(),
    ]);
    return (
      <div className="pb-10">
        <LibraryWarmProgress
          sessionId={sessionId}
          subjectId={session.subject_id}
          subjectName={subject?.name_uk ?? ""}
          topicTitle={topic?.title ?? ""}
        />
      </div>
    );
  }

  if (session.mode === "choosing") {
    const candidates = await loadLibraryItemTitles(familyId, session.candidate_library_item_ids);
    return (
      <div className="pb-10">
        <LessonPicker sessionId={sessionId} subjectId={session.subject_id} candidates={candidates} />
      </div>
    );
  }

  if (session.status === "paused") {
    return (
      <div className="pb-10">
        <LessonPausedScreen sessionId={sessionId} subjectId={session.subject_id} reason={session.pause_reason} />
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
        presentationMode={session.presentation_mode as "voice" | "auto" | "text"}
        currentBlockOrder={session.current_block_order}
        remediation={remediation}
      />
    </div>
  );
}
