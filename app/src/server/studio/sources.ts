import "server-only";
import { forFamily } from "@/server/db/family-scope";
import { loadVideoLessonSource, VideoSourceError } from "@/server/video-script/source";
import { getSubjectDetail } from "@/server/subjects/queries";
import { importedLessonHref } from "@/lib/imported-lesson-link";
import { buildTsQuery } from "@/server/search/query";
import type { StudioRequest, StudioSource } from "@/lib/studio";

export async function loadStudioSources(familyId: string, request: StudioRequest) {
  const scope = forFamily(familyId); const sources: StudioSource[] = []; const notes: string[] = [];
  let baseHref: string | null = null, baseTitle: string | null = null;
  const subject = request.subjectId ? await getSubjectDetail(familyId, request.subjectId) : null;
  if (request.subjectId && !subject) throw new Error("Предмет або курс недоступний.");
  if (request.mode === "extension") {
    const topic = subject?.topics.find(item => item.id === request.topicId);
    baseHref = topic ? importedLessonHref(topic) : null; baseTitle = topic?.title ?? null;
    if (!baseHref || !request.subjectId || !request.topicId) throw new Error("Вибери готовий базовий урок цього предмета.");
    try {
      const lesson = await loadVideoLessonSource(familyId, request.subjectId, request.topicId);
      sources.push(...lesson.blocks.map((block, index) => ({ id: `lesson-${index + 1}`, title: `${lesson.title}: ${block.title}`, text: block.text, page: null, kind: "lesson" as const })));
    } catch (error) {
      if (!(error instanceof VideoSourceError)) throw error;
      notes.push("У базовому уроці недостатньо основного тексту. Шукаємо матеріал у книгах; якщо фрагментів немає, розширення ґрунтуватиметься на загальних знаннях, а не на повному тексті підручника.");
    }
  }
  if (request.sourceText.trim()) sources.push({ id: "provided-1", title: "Текст, наданий татом", text: request.sourceText.trim(), page: null, kind: "provided" });
  let materialTitle: string | null = null;
  if (request.materialId) {
    const { data: material, error } = await scope.select("materials", "id,title,name").eq("id", request.materialId).maybeSingle<{ id: string; title: string | null; name: string }>();
    if (error || !material) throw new Error("Вибрана книга недоступна."); materialTitle = material.title || material.name;
  }
  let chunks: { id: string; material_id: string; page: number | null; text: string }[] = [];
  if (request.materialId && request.pageFrom !== null && request.pageTo !== null) {
    const { data, error } = await scope.select("chunks", "id,material_id,page,text").eq("material_id", request.materialId).gte("page", request.pageFrom).lte("page", request.pageTo).order("ordinal").limit(151).returns<typeof chunks>();
    if (error) throw new Error("Не вдалося прочитати вибрані сторінки."); chunks = data ?? [];
    if (chunks.length > 150) throw new Error("У вибраному діапазоні забагато фрагментів. Звузь діапазон; сторінки не обрізалися.");
  } else if (request.materialId || request.subjectId) {
    const { data, error } = await scope.client.rpc("search_chunks", { p_family_id: familyId, p_query_text: request.title.slice(0, 200), p_tsquery: buildTsQuery(`${baseTitle ?? request.title} ${request.idea.slice(0, 150)}`), p_query_embedding: null, p_subject_id: request.materialId ? null : request.subjectId, p_kind: null, p_material_id: request.materialId, p_limit: 8 });
    if (error) notes.push("Пошук у книгах зараз недоступний; використано лише явно надані джерела.");
    const ids = (data ?? []).map((row: { chunk_id: string }) => row.chunk_id);
    if (ids.length) {
      let selected = scope.select("chunks", "id,material_id,page,text").in("id", ids);
      if (request.materialId) selected = selected.eq("material_id", request.materialId);
      const result = await selected.returns<typeof chunks>();
      if (result.error) throw new Error("Не вдалося прочитати знайдені фрагменти."); chunks = result.data ?? [];
    }
  }
  if (request.materialId && !chunks.length) throw new Error("У вибраній книзі не знайдено читабельних фрагментів. Укажи сторінки, дочекайся обробки книги або встав потрібний текст. Генерацію ще не розпочато.");
  const names = new Map<string, string>();
  if (!materialTitle && chunks.length) {
    const result = await scope.select("materials", "id,title,name").in("id", [...new Set(chunks.map(chunk => chunk.material_id))]).returns<{ id: string; title: string | null; name: string }[]>();
    if (!result.error) for (const book of result.data ?? []) names.set(book.id, book.title || book.name);
  }
  for (const chunk of chunks) sources.push({ id: `chunk-${chunk.id}`, title: materialTitle ?? names.get(chunk.material_id) ?? "Матеріал вибраного предмета", text: chunk.text, page: chunk.page, kind: "book" });
  if (chunks.length) notes.push("Використано знайдені фрагменти, а не прочитано всю книгу. Номери сторінок індексу можуть відрізнятися від друкованих.");
  if (!sources.length) notes.push("Наданих джерел немає: урок готується із загальних знань ШІ. Це буде зазначено у матеріалі.");
  if (JSON.stringify(sources).length > 65000) throw new Error("Вибраних матеріалів більше ніж 65 000 символів. Звузь діапазон сторінок або розділи курс; джерела не обрізалися.");
  return { sources, sourceNotes: notes, baseHref, baseTitle, subjectName: subject?.name ?? null };
}
