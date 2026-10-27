import "server-only";
import { listVideoLessonsForSubject } from "./videoLessons";
import { videoTopicIdForLesson } from "./videoSupplementMatch";

/** Read-only optional supplement lookup, including earlier topic attachments. */
export async function resolveLessonVideoTopicId(familyId: string, subjectId: string, topicId: string | null, title: string): Promise<string | null> {
  const videos = await listVideoLessonsForSubject(familyId, subjectId).catch(() => null);
  return videos ? videoTopicIdForLesson(videos, topicId, title) : null;
}
