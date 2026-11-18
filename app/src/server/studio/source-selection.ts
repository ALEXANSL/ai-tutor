import "server-only";
import { z } from "zod";
import type { StudioProject, StudioSource } from "@/lib/studio";
import { studioPreparedBaseSources } from "./base-sources";
import { loadStudioSources, stageStudioSources } from "./sources";
export const studioResolveSchema = z.object({ topicIds: z.array(z.string().uuid()), reason: z.string().trim().min(1).max(1500) }).strict();
export const studioAssessSchema = z.object({ sufficient: z.boolean(), reason: z.string().trim().min(1).max(1500), missing: z.array(z.string().trim().min(1).max(500)).max(12) }).strict();
export async function studioBookFallback(familyId: string, project: StudioProject, existing: StudioSource[], reason: string): Promise<Partial<StudioProject>> {
  const materialId = project.sourceSelection?.fallbackMaterialId ?? project.request.materialId;
  const source = await loadStudioSources(familyId, { ...project.request, materialId }, existing);
  return { ...source, baseHref: source.baseHref ?? project.baseHref, baseTitle: source.baseTitle ?? project.baseTitle, subjectName: source.subjectName ?? project.subjectName, sourceSelection: project.sourceSelection ? { ...project.sourceSelection, assessed: true, reason } : undefined, phase: source.sourceCorpus && source.sourceCorpus.analyzed < source.sourceCorpus.partCount ? "analyze" : "plan", sourceNotes: [...source.sourceNotes, reason], lessonSources: undefined };
}
export async function applyStudioResolution(familyId: string, project: StudioProject, raw: unknown): Promise<Partial<StudioProject>> {
  const value = studioResolveSchema.parse(raw), selection = project.sourceSelection!;
  if (new Set(value.topicIds).size !== value.topicIds.length || value.topicIds.some(id => !selection.candidates.some(topic => topic.id === id))) throw new Error("STUDIO-BASE-TOPIC: обрано відсутній матеріал.");
  const requiredTopic = ["extension", "revision"].includes(project.request.mode) ? project.request.topicId : null;
  if (requiredTopic && !value.topicIds.includes(requiredTopic)) { if (!selection.candidates.some(topic => topic.id === requiredTopic)) throw new Error("STUDIO-BASE-TOPIC"); value.topicIds.unshift(requiredTopic); }
  const selected = await studioPreparedBaseSources(familyId, selection.candidates, value.topicIds);
  const next = { ...project, sourceSelection: { ...selection, selectedIds: value.topicIds, reason: value.reason } };
  if (!selected.sources.length) return studioBookFallback(familyId, next, [], "У базовому пакеті не знайдено достатнього готового матеріалу. Використовуємо доступні джерела й знання ШІ.");
  const sources = [...selected.sources];
  if (project.request.sourceText.trim()) sources.push({ id: "provided-1", title: "Власний матеріал", text: project.request.sourceText.trim(), page: null, kind: "provided" });
  const base = selection.candidates.find(topic => topic.id === project.request.topicId);
  const staged = await stageStudioSources(familyId, sources, ["Спочатку використано готові матеріали базового предмета. Книга не перечитувалася і не розпізнавалася повторно.", ...selected.warnings], { subjectName: project.subjectName, baseHref: base?.href ?? null, baseTitle: base?.title ?? null });
  return { ...staged, sourceSelection: next.sourceSelection, phase: staged.sourceCorpus && staged.sourceCorpus.analyzed < staged.sourceCorpus.partCount ? "analyze" : "assess" };
}
export async function applyStudioAssessment(familyId: string, project: StudioProject, sources: StudioSource[], raw: unknown): Promise<Partial<StudioProject>> {
  const assessment = studioAssessSchema.parse(raw);
  if (!assessment.sufficient) return studioBookFallback(familyId, project, sources, `Матеріали предмета доповнено: ${assessment.reason} Бракувало: ${assessment.missing.join("; ")}`);
  return { phase: "plan", sourceSelection: { ...project.sourceSelection!, assessed: true, reason: assessment.reason }, sourceNotes: [...project.sourceNotes, `Матеріалу достатньо для підготовки: ${assessment.reason} Додаткові пояснення й приклади автор створює зі знань ШІ.`] };
}
