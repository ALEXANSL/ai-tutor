import "server-only";
import { forFamily } from "@/server/db/family-scope";
import { studioPublicationVisible, type StudioProject } from "@/lib/studio";
import { importedLessonHref } from "@/lib/imported-lesson-link";
import { STUDIO_PROJECT } from "./store";
import { getSubjectDetail } from "@/server/subjects/queries";
export interface StudioPublishedLink { mode?: "course" | "extension" | "revision"; projectId: string; title: string; baseTopicId: string | null; baseHref: string | null; lessons: { id: string; topicId: string; title: string }[]; }
const LINK_COLUMNS = "id,title:payload->plan->>title,requestTitle:payload->request->>title,mode:payload->request->>mode,baseTopicId:payload->request->>topicId,baseHref:payload->>baseHref,publication:payload->publication,state:payload->>state,publicationRevision:payload->>publicationRevision,childAccess:payload->>childAccess";
type PublicRow = { id: string; title: string | null; requestTitle: string; mode: string; baseTopicId: string | null; baseHref: string | null; publication: StudioProject["publication"]; state: StudioProject["state"]; publicationRevision?: boolean | string; childAccess?: StudioProject["childAccess"] };
function publicLink(row: PublicRow): StudioPublishedLink | null {
  return row.publication && studioPublicationVisible({ ...row, publicationRevision: row.publicationRevision === true || row.publicationRevision === "true" }) ? { mode: row.mode === "revision" ? "revision" : row.mode === "extension" ? "extension" : "course", projectId: row.id, title: row.title || row.requestTitle, baseTopicId: ["extension", "revision"].includes(row.mode) ? row.baseTopicId : null, baseHref: row.baseHref, lessons: row.publication.lessons } : null;
}
export async function studioPublicationsForSubject(familyId: string, subjectId: string): Promise<StudioPublishedLink[]> {
  const links: StudioPublishedLink[] = [];
  for (let page = 0; page < 20; page++) {
    const { data, error } = await forFamily(familyId).select("jobs", LINK_COLUMNS).eq("type", STUDIO_PROJECT).eq("payload->publication->>subjectId", subjectId).order("created_at", { ascending: false }).order("id").range(page * 500, page * 500 + 499).returns<PublicRow[]>();
    if (error) throw new Error("Не вдалося завантажити розширені уроки.");
    for (const row of data ?? []) { const link = publicLink(row); if (link && row.publication?.subjectId === subjectId) links.push(link); }
    if ((data?.length ?? 0) < 500) return links;
  }
  throw new Error("Каталог завеликий для поточного перегляду.");
}
const TABLES: Record<string, string> = { "literature-v3": "literature_v3_lessons", "math-course-v2": "course_v2_lessons", "literature-course-v2": "literature_v2_lessons", literature: "literature_lessons", "course-lesson": "course_lessons" };
/** The client sends a pathname, never a family, table, source text or return URL. */
export async function studioLinksForPath(familyId: string, pathname: string): Promise<{ back: string | null; links: { title: string; href: string }[] }> {
  const match = /^\/([a-z0-9-]+)\/([a-f0-9-]{36})$/i.exec(pathname);
  const table = match && TABLES[match[1]!];
  if (!match || !table) return { back: null, links: [] };
  const { data: lesson, error } = await forFamily(familyId).select(table, table === "literature_v3_lessons" ? "subject_id,topic_id,status,package_id" : "subject_id,topic_id,status").eq("id", match[2]!).maybeSingle<{ subject_id: string; topic_id: string | null; status: string; package_id: string }>();
  if (error || !lesson || lesson.status !== "active") return { back: null, links: [] };
  const subject = await getSubjectDetail(familyId, lesson.subject_id);
  if (!subject?.childVisible) return { back: null, links: [] };
  if (table === "literature_v3_lessons") {
    const result = await forFamily(familyId).select("literature_v3_packages", "package_key").eq("id", lesson.package_id).maybeSingle<{ package_key: string }>();
    const projectId = /^studio\.([a-f0-9-]{36})$/i.exec(result.data?.package_key ?? "")?.[1];
    if (projectId) {
      const result = await forFamily(familyId).select("jobs", LINK_COLUMNS).eq("id", projectId).eq("type", STUDIO_PROJECT).maybeSingle<PublicRow>();
      const link = result.data ? publicLink(result.data) : null;
      if (!result.error && link?.baseHref && link.lessons.some(item => item.id === match[2])) return { back: link.mode === "revision" ? `${link.baseHref}?original=1` : link.baseHref, links: [] };
    }
  }
  const extensions = await studioPublicationsForSubject(familyId, lesson.subject_id);
  return { back: null, links: extensions.filter(item => item.mode !== "revision" && item.baseTopicId === lesson.topic_id).flatMap(item => item.lessons.map(part => ({ title: part.title, href: `/literature-v3/${part.id}` }))) };
}

/** Resolve a reviewed replacement without modifying the imported original or its progress. */
export async function studioReplacementForPath(familyId: string, pathname: string): Promise<string | null> {
  const match = /^\/([a-z0-9-]+)\/([a-f0-9-]{36})$/i.exec(pathname);
  const table = match && TABLES[match[1]!]; if (!match || !table) return null;
  const { data: base, error } = await forFamily(familyId).select(table, "subject_id,topic_id,status").eq("id", match[2]!).maybeSingle<{ subject_id: string; topic_id: string; status: string }>();
  if (error || !base || base.status !== "active") return null;
  const revisions = await studioPublicationsForSubject(familyId, base.subject_id);
  const revision = revisions.find(item => item.mode === "revision" && item.baseTopicId === base.topic_id && item.baseHref === pathname && item.lessons.length === 1);
  if (!revision) return null;
  const subject = await getSubjectDetail(familyId, base.subject_id); if (!subject?.childVisible) return null;
  return `/literature-v3/${revision.lessons[0]!.id}`;
}

export async function studioRevisionNavigation(familyId: string, subjectId: string, lessonId: string) {
  const publications = await studioPublicationsForSubject(familyId, subjectId);
  const revision = publications.find(item => item.mode === "revision" && item.lessons.some(lesson => lesson.id === lessonId));
  if (!revision?.baseTopicId) return null;
  const subject = await getSubjectDetail(familyId, subjectId); if (!subject?.childVisible) return null;
  const derived = new Set(publications.filter(item => item.baseTopicId).flatMap(item => item.lessons.map(lesson => lesson.topicId)));
  const topics = subject.topics.filter(topic => importedLessonHref(topic) && !derived.has(topic.id));
  return { topicId: revision.baseTopicId, lessons: topics.map((topic, orderNo) => {
    const replacement = publications.find(item => item.mode === "revision" && item.baseTopicId === topic.id)?.lessons[0];
    const href = replacement ? `/literature-v3/${replacement.id}` : importedLessonHref(topic)!;
    return { id: replacement?.id ?? href.split("/")[2]!, href, orderNo, title: topic.title, status: "active" as const };
  }) };
}
