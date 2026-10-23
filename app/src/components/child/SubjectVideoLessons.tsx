import { listVideoLessonsForSubject } from "@/server/lessons/videoLessons";
import { matchVideoSupplement } from "@/server/lessons/videoSupplementMatch";
import { VideoLessonButton } from "./VideoLessonButton";

/** Independent of the text-topic filter: even earlier attachments remain
 * reachable. No topic/lesson rows are migrated or regenerated. */
export async function SubjectVideoLessons({ familyId, subjectId }: { familyId: string; subjectId: string }) {
  const videos = await listVideoLessonsForSubject(familyId, subjectId).catch(() => null);
  if (!videos) return <p role="status" className="mb-4 rounded-xl border border-line p-3 text-sm text-muted">Не вдалося завантажити список відео. Онови сторінку, щоб спробувати ще раз. Текстові уроки доступні нижче.</p>;
  if (!videos.length) return null;
  return <section aria-label="Відеоматеріали предмета" className="mb-5 rounded-2xl border border-line bg-surface p-4">
      <h2 className="text-xl font-bold">Відеоматеріали до тем</h2>
      <p className="mt-1 text-sm text-muted">Додаткові пояснення у відео. Звичайні уроки залишаються нижче.</p>
      <ul className="mt-3 space-y-3">{videos.map(video => <li key={video.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line p-3">
        <span className="min-w-0 font-bold">{video.topicTitle}</span>
        <VideoLessonButton topicId={video.topicId} title={video.topicTitle} />
      </li>)}</ul>
    </section>;
}

/** Additive entry point in all existing lesson readers. Failed optional
 * metadata must never turn a working text lesson into an error page. */
export async function TopicVideoSupplement({ familyId, subjectId, topicId, title }: { familyId: string; subjectId: string; topicId: string | null; title: string }) {
  const videos = await listVideoLessonsForSubject(familyId, subjectId).catch(() => null);
  if (!videos) return null;
  const video = matchVideoSupplement(videos, topicId, title);
  if (!video) return null;
  return <aside aria-label="Відео до цього уроку" className="mx-4 mt-4 flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-surface p-4">
      <p className="text-sm font-bold">Додатково до уроку</p>
      <VideoLessonButton topicId={video.topicId} title={video.topicTitle} />
    </aside>;
}
