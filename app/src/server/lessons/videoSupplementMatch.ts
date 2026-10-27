import type { VideoLessonRow } from "./videoLessons";

function titleKey(title: string): string {
  return title.normalize("NFKC").toLocaleLowerCase("uk").replace(/[’'`ʼ]/gu, "’").replace(/[\s.,:;!?«»“”"()–—-]+/gu, " ").trim();
}
/** Never infer identity from a paragraph number alone. A unique full-title
 * match can recover an old topic's attachment without rewriting lesson data. */
export function matchVideoSupplement(videos: VideoLessonRow[], topicId: string | null, title: string): VideoLessonRow | null {
  const direct = topicId ? videos.filter(video => video.topicId === topicId) : [];
  if (direct.length === 1) return direct[0]!;
  const key = titleKey(title);
  if (!key) return null;
  const matches = videos.filter(video => titleKey(video.topicTitle) === key);
  return matches.length === 1 ? matches[0]! : null;
}

/** Resolve a topic rather than one video: several videos on the same topic
 * remain selectable. Never choose between different same-title topics. */
export function videoTopicIdForLesson(videos: VideoLessonRow[], topicId: string | null, title: string): string | null {
  if (topicId && videos.some(video => video.topicId === topicId)) return topicId;
  const key = titleKey(title);
  if (!key) return null;
  const candidates = new Set(videos.filter(video => titleKey(video.topicTitle) === key).map(video => video.topicId));
  return candidates.size === 1 ? [...candidates][0]! : null;
}
