import "server-only";
import { z } from "zod";
import type { StudioRequest, StudioSource } from "@/lib/studio";
import { importedLessonHref } from "@/lib/imported-lesson-link";
import { forFamily } from "@/server/db/family-scope";
import { getSubjectDetail } from "@/server/subjects/queries";
import { loadVideoLessonSource, VideoSourceError } from "@/server/video-script/source";

export interface BaseTopicCandidate {
  id: string;
  subjectId: string;
  title: string;
  pageFrom: number | null;
  pageTo: number | null;
  href?: string;
}

const uuid = z.string().uuid();
const SUBJECT_PAGE_SIZE = 50;
const SOURCE_CONCURRENCY = 4;

/** Bounded fan-out with stable result order; failures are propagated, never replaced by empty content. */
async function mapBounded<T, R>(items: T[], worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(SOURCE_CONCURRENCY, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]!);
    }
  }));
  return results;
}

/** Inventory metadata only: no keyword shortcut, raw textbook reads, or page-range exclusion. */
export async function studioBaseCandidates(
  familyId: string,
  request: StudioRequest,
): Promise<{ topics: BaseTopicCandidate[]; subjectName: string | null; fallbackMaterialId: string | null }> {
  const scope = forFamily(familyId);
  let materialSubjectId: string | null = null;
  // A selected material remains a family-scoped selector even when its text is not needed.
  if (request.materialId) {
    const material = await scope.select("materials", "subject_id")
      .eq("id", request.materialId).neq("status", "removed").maybeSingle<{ subject_id: string | null }>();
    if (material.error) throw new Error("Не вдалося перевірити предмет вибраної книги.");
    if (!material.data) throw new Error("Вибрана книга недоступна.");
    materialSubjectId = material.data.subject_id;
  }
  const selectedSubjectId = request.subjectId ?? materialSubjectId;
  let fallbackMaterialId = request.materialId;
  if (!fallbackMaterialId && request.subjectId) {
    const textbook = await scope.select("materials", "id")
      .eq("subject_id", request.subjectId).eq("kind", "textbook").eq("use_in_lessons", true)
      .in("status", ["ready", "ready_partial"]).order("added_at", { ascending: false }).limit(1)
      .maybeSingle<{ id: string }>();
    if (textbook.error) throw new Error("Не вдалося перевірити доступний підручник базового предмета.");
    fallbackMaterialId = textbook.data?.id ?? null;
  }
  const subjectIds: string[] = [];
  if (selectedSubjectId) subjectIds.push(selectedSubjectId);
  else {
    // Inventory every active school subject in pages, not only the first search hits.
    const seen = new Set<string>();
    for (let offset = 0; ; offset += SUBJECT_PAGE_SIZE) {
      const result = await scope.select("subjects", "id")
        .eq("kind", "school_subject").eq("active", true).order("id")
        .range(offset, offset + SUBJECT_PAGE_SIZE - 1).returns<{ id: string }[]>();
      if (result.error) throw new Error("Не вдалося прочитати перелік базових предметів.");
      const rows = result.data ?? [];
      for (const row of rows) {
        if (!uuid.safeParse(row.id).success || seen.has(row.id)) throw new Error("Перелік предметів змінився або містить некоректні ідентифікатори. Повтори підготовку.");
        seen.add(row.id); subjectIds.push(row.id);
      }
      if (rows.length < SUBJECT_PAGE_SIZE) break;
    }
  }
  const details = await mapBounded(subjectIds, async subjectId => {
    const detail = await getSubjectDetail(familyId, subjectId);
    if (!detail || detail.id !== subjectId) throw new Error("Базовий предмет недоступний. Онови перелік перед підготовкою.");
    return detail;
  });
  const topics: BaseTopicCandidate[] = [];
  const seenTopics = new Set<string>();
  for (const detail of details) {
    if (!detail.active || !detail.childVisible) continue;
    for (const topic of detail.topics) {
      const href = importedLessonHref(topic);
      if (!href) continue;
      if (!uuid.safeParse(topic.id).success || seenTopics.has(topic.id)) throw new Error("Перелік готових уроків містить некоректні або повторені ідентифікатори.");
      seenTopics.add(topic.id);
      topics.push({ id: topic.id, subjectId: detail.id, title: topic.title, pageFrom: topic.pageFrom ?? null, pageTo: topic.pageTo ?? null, href });
    }
  }
  return { topics, subjectName: details.length === 1 ? details[0]!.name : null, fallbackMaterialId };
}

/** Load the actual selected prepared lessons; text quality/coverage remains a later semantic decision. */
export async function studioPreparedBaseSources(
  familyId: string,
  candidates: BaseTopicCandidate[],
  topicIds: string[],
): Promise<{ sources: StudioSource[]; warnings: string[] }> {
  const byId = new Map<string, BaseTopicCandidate>();
  for (const topic of candidates) {
    if (byId.has(topic.id)) throw new Error("Перелік базових уроків неоднозначний.");
    byId.set(topic.id, topic);
  }
  const selectedIds = [...new Set(topicIds)];
  const selected = selectedIds.map(id => {
    const topic = byId.get(id);
    if (!uuid.safeParse(id).success || !topic) throw new Error("Обраний базовий урок відсутній у перевіреному переліку.");
    return topic;
  });
  const results = await mapBounded(selected, async topic => {
    try {
      // Revalidates family, subject/topic relationship, current publication and source quality.
      const lesson = await loadVideoLessonSource(familyId, topic.subjectId, topic.id);
      const sources: StudioSource[] = lesson.blocks.map((block, index) => ({
        id: `base-${topic.id}-${index + 1}`,
        title: `${lesson.title}: ${block.title}`,
        text: block.text,
        page: null,
        kind: "lesson",
      }));
      return { sources, warnings: [] as string[] };
    } catch (error) {
      if (!(error instanceof VideoSourceError)) throw error;
      return {
        sources: [] as StudioSource[],
        warnings: [`Базовий урок «${topic.title}» не дав достатнього доступного навчального тексту: ${error.message} Покриття теми ним не підтверджене; потрібна перевірка інших матеріалів.`],
      };
    }
  });
  return { sources: results.flatMap(result => result.sources), warnings: results.flatMap(result => result.warnings) };
}
