import "server-only";
import { forFamily } from "@/server/db/family-scope";
import { studioPublicationVisible, studioStateLabels, type StudioProject, type StudioState } from "@/lib/studio";
import { STUDIO_PROJECT } from "./store";
export interface StudioCatalogItem { id: string; revision: number; title: string; subjectId: string | null; subjectName: string | null; state: StudioState; published: boolean; visible: boolean; lessonCount: number; spentUsd: number; }
interface Row { id: string; revision: string; title: string | null; requestTitle: string; subjectId: string | null; subjectName: string | null; state: StudioState; publication: StudioProject["publication"]; childAccess: StudioProject["childAccess"]; publicationRevision: string | boolean | null; lessonCount: string; spentUsd: string; }
const columns = "id,revision:payload->>revision,title:payload->plan->>title,requestTitle:payload->request->>title,subjectId:payload->request->>subjectId,subjectName:payload->>subjectName,state:payload->>state,publication:payload->publication,childAccess:payload->>childAccess,publicationRevision:payload->>publicationRevision,lessonCount:payload->request->>lessonCount,spentUsd:payload->>spentUsd";
export async function studioCatalog(familyId: string, options: { q: string; subject: string; page: number }) {
  const scope = forFamily(familyId); const page = Math.max(0, Math.min(10000, Math.floor(options.page) || 0));
  let query = scope.select("jobs", columns).eq("type", STUDIO_PROJECT).eq("payload->>version", "1");
  const term = options.q.replace(/[^\p{L}\p{N}\s’'–—.-]/gu, " ").trim().slice(0, 120);
  if (term) query = query.or(`payload->plan->>title.ilike.%${term}%,payload->request->>title.ilike.%${term}%`);
  if (options.subject === "standalone") query = query.is("payload->request->>subjectId", null);
  else if (/^[a-f0-9-]{36}$/i.test(options.subject)) query = query.eq("payload->request->>subjectId", options.subject);
  const [found, subjects] = await Promise.all([
    query.order("created_at", { ascending: false }).order("id").range(page * 50, page * 50 + 50).returns<Row[]>(),
    scope.select("subjects", "id,name:name_uk").order("sort_order").returns<{ id: string; name: string }[]>(),
  ]);
  if (found.error || subjects.error) throw new Error("Не вдалося завантажити каталог майстерні.");
  const names = new Map((subjects.data ?? []).map(item => [item.id, item.name]));
  const items: StudioCatalogItem[] = (found.data ?? []).slice(0, 50).map(row => ({ id: row.id, revision: Number(row.revision), title: row.title || row.requestTitle, subjectId: row.subjectId, subjectName: row.subjectId ? names.get(row.subjectId) ?? row.subjectName : null, state: Object.hasOwn(studioStateLabels, row.state) ? row.state : "failed", published: !!row.publication, visible: studioPublicationVisible({ ...row, publicationRevision: row.publicationRevision === true || row.publicationRevision === "true" }), lessonCount: Number(row.lessonCount) || 0, spentUsd: Number(row.spentUsd) || 0 }));
  return { items, subjects: subjects.data ?? [], hasMore: (found.data?.length ?? 0) > 50, page };
}
