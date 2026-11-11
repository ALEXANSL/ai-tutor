import "server-only";
import { getSubjectDetail } from "@/server/subjects/queries";
import { importedLessonHref } from "@/lib/imported-lesson-link";
import type { StudioProject } from "@/lib/studio";
import { forFamily } from "@/server/db/family-scope";
import { parseLiteratureV3Assets, parseLiteratureV3Course, parseLiteratureV3PackageManifest, type ParsedLiteratureV3Package } from "@/server/lessons/literatureV3Import";
import { persistLiteratureV3Package } from "@/server/lessons/literatureV3Persist";
import { studioVisualSvg, studioVisualDescription } from "./visual";
const content = (text: string) => ({ display: text, tts: { text, lang: "uk-UA" } });
export function studioPackage(projectId: string, project: StudioProject) {
  if (!project.plan || project.units.length !== project.plan.lessons.length || project.units.some(unit => unit.review?.verdict !== "pass")) throw new Error("Не всі уроки пройшли рецензію.");
  const bookId = `studio.${projectId}`;
  const files = new Map<string, Uint8Array>();
  const assetRows: Record<string, unknown>[] = [];
  const tasks: Record<string, unknown>[] = [], keys: ParsedLiteratureV3Package["taskKeys"] = [];
  const lessons = project.units.map((unit, index) => {
    const lessonId = `L${index + 1}`;
    const screens = unit.content.blocks.map((block, blockIndex) => {
      const assetIds: string[] = [];
      for (const [visualIndex, visual] of unit.visuals.entries()) if (visual.blockIndex === blockIndex) {
        const id = `${lessonId}A${visualIndex + 1}`, path = `assets/${id}.svg`;
        const bytes = new TextEncoder().encode(studioVisualSvg(visual)); files.set(path, bytes); assetIds.push(id);
        assetRows.push({ id, kind: "textbook_illustration", path, mime_type: "image/svg+xml", byte_size: bytes.byteLength, title: visual.title, caption: visual.caption, alt: `${visual.title}. ${visual.items.map(item => `${item.label}: ${item.detail}`).join(". ")}` });
      }
      const descriptions = unit.visuals.filter(visual => visual.blockIndex === blockIndex).map(studioVisualDescription).join("\n\n");
      return { id: `${lessonId}S${blockIndex + 1}`, title: block.title, step_type: block.kind, content: { display: (block.kind === "code" ? `\`\`\`\n${block.text}\n\`\`\`` : block.text) + (descriptions ? `\n\n**На схемі:** ${descriptions}` : ""), tts: { text: block.narration, lang: "uk-UA" } }, asset_ids: assetIds };
    });
    const references = project.sources.filter(source => unit.content.sourceIds.includes(source.id)).map(source => `${source.title}${source.page ? `, сторінка індексу ${source.page}` : ""}`).join("\n");
    screens.push({ id: `${lessonId}Sources`, title: "Джерела й розширення", step_type: "summary", content: { display: `${unit.content.enrichmentNote}\n\n${references || "Урок підготовлено із загальних знань ШІ без наданого підручника."}${unit.content.adultAssistance ? `\n\nДопомога дорослого: ${unit.content.adultAssistance}` : ""}`, tts: { text: `${unit.content.enrichmentNote} ${unit.content.adultAssistance} Джерела наведено на екрані.`, lang: "uk-UA" } }, asset_ids: [] });
    const taskIds = unit.content.questions.map((question, questionIndex) => {
      const id = `${lessonId}Q${questionIndex + 1}`;
      tasks.push({ id, lesson_id: lessonId, prompt: content(question.prompt), response_type: "single_choice", options: question.options.map((option, i) => ({ id: `o${i}`, content: content(option) })) });
      keys.push({ task_id: id, correct_option_ids: [`o${question.correctIndex}`], explanation: content(question.explanation), option_feedback: [], hints: [], grading: { method: "single_choice", points: 1, retry_allowed: true }, review_reading_ids: [] }); return id;
    });
    return { id: lessonId, title: unit.content.title, grade: project.request.grade, estimated_minutes: project.request.minutes, objectives: unit.content.objectives, screens, task_ids: taskIds, flow: [...screens.map(screen => ({ kind: "screen", ref_id: screen.id })), ...taskIds.map(id => ({ kind: "quiz", ref_id: id }))] };
  });
  const course = parseLiteratureV3Course({ schema_version: "2.0.0", book_id: bookId, grade: project.request.grade, lessons, tasks });
  const assets = parseLiteratureV3Assets({ schema_version: "2.0.0", book_id: bookId, items: assetRows });
  const manifest = parseLiteratureV3PackageManifest({ format: "studio-tutor-package", schema_version: "2.0.0", book_id: bookId, progress_namespace: bookId, source_edition: project.plan.title });
  const parsed: ParsedLiteratureV3Package = { manifest: manifest.manifest, lessons: course.lessons, tasks: course.tasks, assets: assets.assets, taskKeys: keys, works: [], readingItems: [], biographies: [], lessonGuides: [], pages: [], errors: [...manifest.errors, ...course.errors, ...assets.errors], warnings: [] };
  if (parsed.errors.length) throw new Error("Підготовлений курс не відповідає контракту читача.");
  return { parsed, files };
}
export async function prepareStudioPublication(familyId: string, projectId: string, project: StudioProject): Promise<NonNullable<StudioProject["publication"]>> {
  const scope = forFamily(familyId); const { parsed, files } = studioPackage(projectId, project);
  let subjectId = project.request.subjectId;
  if (project.request.mode === "extension" && subjectId) {
    const subject = await getSubjectDetail(familyId, subjectId);
    const base = subject?.topics.find(topic => topic.id === project.request.topicId);
    if (!base || importedLessonHref(base) !== project.baseHref) throw new Error("Базовий урок змінено або більше недоступний. Створи нову чернетку розширення для актуального уроку.");
  }
  if (!subjectId) {
    const code = `studio_${projectId.replaceAll("-", "")}`;
    const created = await scope.client.from("subjects").upsert({ owner_family_id: familyId, code, name_uk: project.plan!.title, kind: "course", active: false, is_stub: false, sort_order: 1000 }, { onConflict: "owner_family_id,code", ignoreDuplicates: true });
    if (created.error) throw new Error("Не вдалося створити курс.");
    const found = await scope.select("subjects", "id").eq("code", code).maybeSingle<{ id: string }>();
    if (found.error || !found.data) throw new Error("Не вдалося знайти створений курс."); subjectId = found.data.id;
  } else {
    const found = await scope.select("subjects", "id").eq("id", subjectId).maybeSingle<{ id: string }>();
    if (found.error || !found.data) throw new Error("Предмет більше недоступний.");
  }
  const saved = await persistLiteratureV3Package(scope, { subjectId, lessonStatus: "needs_review" }, parsed, files);
  if (saved.assetsMissing.length || saved.assetUploadFailures.length) throw new Error("Не всі ілюстрації завантажилися. Курс ще не опубліковано; повтори публікацію.");
  const result = await scope.select("literature_v3_lessons", "id,topic_id,title").eq("package_id", saved.packageId).order("order_no").returns<{ id: string; topic_id: string; title: string }[]>();
  if (result.error || result.data?.length !== project.units.length || result.data.some(row => !row.topic_id)) throw new Error("Не всі уроки збережені. Публікацію не завершено.");
  return { subjectId, packageId: saved.packageId, lessons: result.data.map(row => ({ id: row.id, topicId: row.topic_id, title: row.title })) };
}
export async function activateStudioPublication(familyId: string, publication: NonNullable<StudioProject["publication"]>, activateSubject: boolean) {
  const scope = forFamily(familyId);
  const activated = await scope.update("literature_v3_lessons", { status: "active" }).eq("package_id", publication.packageId);
  if (activated.error) throw new Error("Не вдалося активувати уроки.");
  if (activateSubject) {
    const result = await scope.update("subjects", { active: true, is_stub: false }).eq("id", publication.subjectId);
    if (result.error) throw new Error("Уроки готові, але курс ще не активовано. Повтори публікацію.");
  } else {
    const result = await scope.update("subjects", { is_stub: false }).eq("id", publication.subjectId);
    if (result.error) throw new Error("Уроки готові, але статус предмета ще не оновлено. Повтори публікацію.");
  }
}
