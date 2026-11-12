import "server-only";
import { forFamily } from "@/server/db/family-scope";
import { studioPublicationVisible, type StudioProject } from "@/lib/studio";
import { STUDIO_PROJECT } from "./store";
import { getSubjectDetail } from "@/server/subjects/queries";
export interface StudioPublishedLink { projectId: string; title: string; baseTopicId: string | null; baseHref: string | null; lessons: { id: string; topicId: string; title: string }[]; }
const LINK_COLUMNS = "id,title:payload->plan->>title,requestTitle:payload->request->>title,mode:payload->request->>mode,baseTopicId:payload->request->>topicId,baseHref:payload->>baseHref,publication:payload->publication,state:payload->>state,publicationRevision:payload->>publicationRevision,childAccess:payload->>childAccess";
type PublicRow = { id: string; title: string | null; requestTitle: string; mode: string; baseTopicId: string | null; baseHref: string | null; publication: StudioProject["publication"]; state: StudioProject["state"]; publicationRevision?: boolean | string; childAccess?: StudioProject["childAccess"] };
function publicLink(row: PublicRow): StudioPublishedLink | null {
  return row.publication && studioPublicationVisible({ ...row, publicationRevision: row.publicationRevision === true || row.publicationRevision === "true" }) ? { projectId: row.id, title: row.title || row.requestTitle, baseTopicId: row.mode === "extension" ? row.baseTopicId : null, baseHref: row.baseHref, lessons: row.publication.lessons } : null;
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
      if (!result.error && link?.baseHref && link.lessons.some(item => item.id === match[2])) return { back: link.baseHref, links: [] };
    }
  }
  const extensions = await studioPublicationsForSubject(familyId, lesson.subject_id);
  return { back: null, links: extensions.filter(item => item.baseTopicId === lesson.topic_id).flatMap(item => item.lessons.map(part => ({ title: part.title, href: `/literature-v3/${part.id}` }))) };
}
