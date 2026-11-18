import "server-only";
import { forFamily } from "@/server/db/family-scope";
import { loadVideoLessonSource, VideoSourceError } from "@/server/video-script/source";
import { getSubjectDetail } from "@/server/subjects/queries";
import { importedLessonHref } from "@/lib/imported-lesson-link";
import { buildTsQuery } from "@/server/search/query";
import { readStudioSourceCatalog, studioSourceAnalysisContract } from "./source-catalog";
import { snapshotStudioSources } from "./source-corpus";
import { STUDIO_MAX_SOURCE_CHUNKS, type StudioRequest, type StudioSource } from "@/lib/studio";

export async function loadStudioSources(familyId: string, request: StudioRequest, preparedSources: StudioSource[] = []) {
  const scope = forFamily(familyId); const sources: StudioSource[] = [...preparedSources]; const notes: string[] = [];
  let baseHref: string | null = null, baseTitle: string | null = null;
  const subject = request.subjectId ? await getSubjectDetail(familyId, request.subjectId) : null;
  if (request.subjectId && !subject) throw new Error("Предмет або курс недоступний.");
  if (["extension", "revision"].includes(request.mode) && !preparedSources.length) {
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
  if (request.sourceText.trim() && !sources.some(source => source.id === "provided-1")) sources.push({ id: "provided-1", title: "Текст, наданий татом", text: request.sourceText.trim(), page: null, kind: "provided" });
  let materialTitle: string | null = null;
  type Material = { id: string; title: string | null; name: string; status: string; content_hash: string | null; indexed_at: string | null; structure_outline_result?: { kind?: string; warnings?: string[] } };
  const materialFields = "id,title,name,status,content_hash,indexed_at,structure_outline_result";
  let material: Material | null = null;
  if (request.materialId) {
    const found = await scope.select("materials", materialFields).eq("id", request.materialId).neq("status", "removed").maybeSingle<Material>();
    if (found.error || !found.data) throw new Error("Вибрана книга недоступна.");
    material = found.data; materialTitle = material.title || material.name;
    if (!["ready", "ready_partial"].includes(material.status)) throw new Error("Дочекайся завершення обробки вибраної книги: курс має спиратися на повний доступний текст.");
    notes.push(...(material.structure_outline_result?.warnings ?? []));
    if (material.status === "ready_partial") notes.push("Структуру книги підготовлено частково: використовуємо доступний розпізнаний текст і враховуємо прогалини, а не стверджуємо повне відновлення оригіналу.");
  }
  let chunks: { id: string; material_id: string; ordinal: number; page: number | null; text: string }[] = [];
  if (request.materialId) {
    let lastOrdinal = -1;
    while (true) {
      let query = scope.select("chunks", "id,material_id,ordinal,page,text").eq("material_id", request.materialId).gt("ordinal", lastOrdinal);
      if (request.pageFrom !== null && request.pageTo !== null) query = query.gte("page", request.pageFrom).lte("page", request.pageTo);
      const page = await query.order("ordinal").limit(200).returns<typeof chunks>();
      if (page.error) throw new Error("Не вдалося прочитати всі частини вибраної книги. Підготовку ще не розпочато.");
      const rows = page.data ?? []; if (!rows.length) break;
      if (rows.some((row, index) => !Number.isSafeInteger(row.ordinal) || row.ordinal <= (index ? rows[index - 1]!.ordinal : lastOrdinal))) throw new Error("Порядок частин книги змінився. Онови джерело перед підготовкою.");
      chunks.push(...rows); lastOrdinal = rows.at(-1)!.ordinal;
      if (rows.length < 200) break;
    }
    const after = await scope.select("materials", materialFields).eq("id", request.materialId).neq("status", "removed").maybeSingle<Material>();
    if (after.error || !after.data || after.data.status !== material!.status || after.data.content_hash !== material!.content_hash || after.data.indexed_at !== material!.indexed_at) throw new Error("Книга змінилася під час читання. Дочекайся завершення її обробки й повтори запит.");
    if (!chunks.some(chunk => chunk.text.trim())) throw new Error("У вибраній книзі не знайдено читабельного тексту. Перевір розпізнавання джерела; генерацію ще не розпочато.");
    notes.push(request.pageFrom === null ? "Збережено весь доступний розпізнаний текст книги. Майстерня сама визначить теми й матеріал кожного уроку. Це не гарантує розпізнавання сторінок без тексту або ілюстрацій." : "Збережено всі доступні частини в обраному діапазоні. Межі уроків визначає Майстерня, а не технічний поділ на порції.");
  } else if (request.subjectId) {
    const { data, error } = await scope.client.rpc("search_chunks", { p_family_id: familyId, p_query_text: request.title.slice(0, 200), p_tsquery: buildTsQuery(`${baseTitle ?? request.title} ${request.idea.slice(0, 150)}`), p_query_embedding: null, p_subject_id: request.subjectId, p_kind: null, p_material_id: null, p_limit: 8 });
    if (error) notes.push("Пошук у книгах зараз недоступний; використано лише явно надані джерела.");
    const ids = (data ?? []).map((row: { chunk_id: string }) => row.chunk_id);
    if (ids.length) {
      const result = await scope.select("chunks", "id,material_id,ordinal,page,text").in("id", ids).returns<typeof chunks>();
      if (result.error) throw new Error("Не вдалося прочитати знайдені фрагменти."); chunks = result.data ?? [];
    }
    if (chunks.length) notes.push("За темою предмета знайдено окремі фрагменти; цілий підручник не вибирався.");
  }
  const names = new Map<string, string>();
  if (!materialTitle && chunks.length) {
    const result = await scope.select("materials", "id,title,name").in("id", [...new Set(chunks.map(chunk => chunk.material_id))]).returns<{ id: string; title: string | null; name: string }[]>();
    if (!result.error) for (const book of result.data ?? []) names.set(book.id, book.title || book.name);
  }
  for (const chunk of chunks) sources.push({ id: `chunk-${chunk.id}`, title: materialTitle ?? names.get(chunk.material_id) ?? "Матеріал вибраного предмета", text: chunk.text, page: chunk.page, kind: "book", audience: sourceAudience(chunk.text) });
  return stageStudioSources(familyId, sources, notes, { baseHref, baseTitle, subjectName: subject?.name ?? null });
}

export async function stageStudioSources(familyId: string, sources: StudioSource[], notes: string[], { baseHref, baseTitle, subjectName }: { baseHref: string | null; baseTitle: string | null; subjectName: string | null }) {
  if (!sources.length) notes.push("Наданих джерел немає: урок готується із загальних знань ШІ. Це буде зазначено у матеріалі.");
  if (sources.length > STUDIO_MAX_SOURCE_CHUNKS || Buffer.byteLength(JSON.stringify(sources)) > 55000) {
    const snapshot = await snapshotStudioSources(familyId, sources);
    const cached = await readStudioSourceCatalog(familyId, snapshot);
    if (cached) notes.push("Використано збережений огляд незмінного джерела; повторний аналіз частин не запускається.");
    return { sources: [], sourceCorpus: { ...snapshot, analysisContract: studioSourceAnalysisContract(), analyzed: cached ? snapshot.partCount : 0, notes: cached?.notes ?? [], catalog: cached?.catalog ?? [], reduceCursor: 0, reduced: [] }, sourceNotes: [...notes, "Великий матеріал аналізується послідовно й зберігається частинами; жодна частина не замінюється випадковим пошуком."], baseHref, baseTitle, subjectName };
  }
  if (sources.length) notes.push("Невеликий матеріал передається повністю без окремого зведення.");
  return { sources, sourceCorpus: undefined, sourceNotes: notes, baseHref, baseTitle, subjectName };

}

/** Explicit service headers only; a lesson about historical sources is still learner content. */
export function sourceAudience(text: string): NonNullable<StudioSource["audience"]> {
  const header = text.trim().split("\n")[0]!.trim().toLocaleLowerCase("uk").replace(/[:.]+$/, "");
  if (/^(?:для вчителя|методичні рекомендації для вчителя|teacher notes)$/.test(header)) return "teacher";
  if (/^(?:список використаних джерел|використані джерела|джерела презентації|бібліографія|references|bibliography)$/.test(header)) return "reference";
  return "learner";
}
