import "server-only";
import { forFamily } from "@/server/db/family-scope";
import { loadVideoLessonSource, VideoSourceError } from "@/server/video-script/source";
import { getSubjectDetail } from "@/server/subjects/queries";
import { importedLessonHref } from "@/lib/imported-lesson-link";
import { buildTsQuery } from "@/server/search/query";
import { STUDIO_MAX_SOURCE_CHUNKS, type StudioRequest, type StudioSource } from "@/lib/studio";

export async function loadStudioSources(familyId: string, request: StudioRequest) {
  const scope = forFamily(familyId); const sources: StudioSource[] = []; const notes: string[] = [];
  let baseHref: string | null = null, baseTitle: string | null = null;
  const subject = request.subjectId ? await getSubjectDetail(familyId, request.subjectId) : null;
  if (request.subjectId && !subject) throw new Error("Предмет або курс недоступний.");
  if (["extension", "revision"].includes(request.mode)) {
    const topic = subject?.topics.find(item => item.id === request.topicId);
    baseHref = topic ? importedLessonHref(topic) : null; baseTitle = topic?.title ?? null;
    if (!baseHref || !request.subjectId || !request.topicId) throw new Error("Вибери готовий базовий урок цього предмета.");
    try {
      const lesson = await loadVideoLessonSource(familyId, request.subjectId, request.topicId);
      sources.push(...lesson.blocks.map((block, index) => ({ id: `lesson-${index + 1}`, title: `${lesson.title}: ${block.title}`, text: block.text, page: null, kind: "lesson" as const })));
    } catch (error) {
      if (!(error instanceof VideoSourceError)) throw error;
      notes.push("У базовому уроці недостатньо основного тексту. Шукаємо матеріал у книгах; якщо фрагментів немає, підготовка уроку ґрунтуватиметься на загальних знаннях, а не на повному тексті підручника.");
    }
  }
  if (request.sourceText.trim()) sources.push({ id: "provided-1", title: "Текст, наданий татом", text: request.sourceText.trim(), page: null, kind: "provided" });
  let materialTitle: string | null = null; let isDocument = false;
  if (request.materialId) {
    const { data: material, error } = await scope.select("materials", "id,title,name,structure_outline_result").eq("id", request.materialId).neq("status", "removed").maybeSingle<{ id: string; title: string | null; name: string; structure_outline_result?: { kind?: string; warnings?: string[] } }>();
    if (error || !material) throw new Error("Вибрана книга недоступна."); materialTitle = material.title || material.name;
    isDocument = material.structure_outline_result?.kind === "source_document" || /\.(?:pptx|docx|txt|text|md)$/i.test(material.name);
    if (/^source_(?:image|document)$/.test(material.structure_outline_result?.kind ?? "")) notes.push(...(material.structure_outline_result?.warnings ?? []));
  }
  let chunks: { id: string; material_id: string; page: number | null; text: string }[] = [];
  let completeSmallSource = false;
  if (request.materialId && request.pageFrom === null && request.pageTo === null) {
    const all = await scope.select("chunks", "id,material_id,page,text").eq("material_id", request.materialId).order("ordinal").limit(STUDIO_MAX_SOURCE_CHUNKS + 1).returns<typeof chunks>();
    if (all.error) throw new Error("Не вдалося прочитати вибраний матеріал.");
    if (all.data?.length && all.data.length <= STUDIO_MAX_SOURCE_CHUNKS && Buffer.byteLength(JSON.stringify(all.data)) <= 55000) { chunks = all.data; completeSmallSource = true; }
    else if (isDocument && all.data?.length) throw new Error("Презентація або документ завеликі для одного запиту. Вибери діапазон слайдів чи частин: не замінюємо весь матеріал випадковими результатами пошуку.");
  }
  if (request.materialId && request.pageFrom !== null && request.pageTo !== null) {
    const { data, error } = await scope.select("chunks", "id,material_id,page,text").eq("material_id", request.materialId).gte("page", request.pageFrom).lte("page", request.pageTo).order("ordinal").limit(151).returns<typeof chunks>();
    if (error) throw new Error("Не вдалося прочитати вибрані сторінки."); chunks = data ?? [];
    if (chunks.length > 150) throw new Error("У вибраному діапазоні забагато фрагментів. Звузь діапазон; сторінки не обрізалися.");
  } else if (!completeSmallSource && (request.materialId || request.subjectId)) {
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
  for (const chunk of chunks) sources.push({ id: `chunk-${chunk.id}`, title: materialTitle ?? names.get(chunk.material_id) ?? "Матеріал вибраного предмета", text: chunk.text, page: chunk.page, kind: "book", audience: sourceAudience(chunk.text) });
  if (completeSmallSource) notes.push("Використано весь розпізнаний текст невеликого матеріалу, а не лише результати пошуку.");
  else if (chunks.length) notes.push("Використано знайдені фрагменти, а не прочитано всю книгу. Номери сторінок індексу можуть відрізнятися від друкованих.");
  if (!sources.length) notes.push("Наданих джерел немає: урок готується із загальних знань ШІ. Це буде зазначено у матеріалі.");
  if (JSON.stringify(sources).length > 65000) throw new Error("Вибраних матеріалів більше ніж 65 000 символів. Звузь діапазон сторінок або розділи курс; джерела не обрізалися.");
  return { sources, sourceNotes: notes, baseHref, baseTitle, subjectName: subject?.name ?? null };
}

/** Explicit service headers only; a lesson about historical sources is still learner content. */
export function sourceAudience(text: string): NonNullable<StudioSource["audience"]> {
  const header = text.trim().split("\n")[0]!.trim().toLocaleLowerCase("uk").replace(/[:.]+$/, "");
  if (/^(?:для вчителя|методичні рекомендації для вчителя|teacher notes)$/.test(header)) return "teacher";
  if (/^(?:список використаних джерел|використані джерела|джерела презентації|бібліографія|references|bibliography)$/.test(header)) return "reference";
  return "learner";
}
