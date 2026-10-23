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
