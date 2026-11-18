import "server-only";
import { z } from "zod";
import type { StudioLessonSources, StudioPlan, StudioProject, StudioSource } from "@/lib/studio";
import { saveStudioSourceCatalog } from "./source-catalog";
import { readStudioSourcePart, readStudioSourceNotes, writeStudioSourceNote, type SourceNote } from "./source-corpus";
const text = (max: number) => z.string().trim().min(1).max(max);
export const studioSourceNoteSchema = z.object({ title: text(150), summary: text(10000), topics: z.array(text(300)).min(1).max(20), limitations: z.array(text(500)).max(10), quotes: z.array(z.object({ sourceId: text(100), text: text(1800) }).strict()).max(6) }).strict();
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const CATALOG_BYTES = 55000, RAW_BYTES = 95000, REDUCE_GROUP = 4;
export interface StudioSourceTask { scope: "book" | "lesson"; reducing: boolean; sources: StudioSource[]; fromPart: number; toPart: number; count: number; verifiedQuotes?: { sourceId: string; text: string }[]; }
export function isStudioSourcePhase(phase: StudioProject["phase"]) { return ["analyze", "outline", "lesson_sources", "lesson_outline"].includes(phase); }
export async function studioPlanSources(familyId: string, project: StudioProject) {
  return project.sourceCorpus ? (await readStudioSourceNotes(familyId, project.sourceCorpus.id, project.sourceCorpus.catalog)).map(note => note.source) : project.sources;
}
export async function validateStudioSourcePlan(familyId: string, project: StudioProject, plan: StudioPlan, complete = true) {
  if (!project.sourceCorpus) return;
  const sources = await studioPlanSources(familyId, project), known = new Set(sources.map(source => source.id));
  const assigned = new Set(plan.lessons.flatMap(lesson => lesson.sourceIds ?? []));
  if (plan.lessons.some(lesson => !lesson.sourceIds?.length) || [...assigned].some(id => !known.has(id)) || plan.sourceExclusions?.some(item => !known.has(item.sourceId))) throw new Error("STUDIO-SOURCE-PLAN: план має вказати наявні частини джерела для кожного уроку.");
  const exclusions = new Set(plan.sourceExclusions?.map(item => item.sourceId));
  if (complete && sources.some(source => !assigned.has(source.id) && !exclusions.has(source.id))) throw new Error("STUDIO-SOURCE-COVERAGE: частину матеріалу не призначено урокам і не пояснено її виключення.");
}
/** One immutable source part per paid analysis; every reduction input is accounted for. */
export async function studioSourceTask(familyId: string, project: StudioProject): Promise<StudioSourceTask> {
  const corpus = project.sourceCorpus!;
  const scope = project.phase === "analyze" || project.phase === "outline" ? "book" : "lesson";
  const work = scope === "book" ? corpus : project.lessonSources!;
  const reducing = project.phase === "outline" || project.phase === "lesson_outline";
  if (reducing) {
    const pending = work.catalog.slice(work.reduceCursor, work.reduceCursor + REDUCE_GROUP);
    const candidates = await readStudioSourceNotes(familyId, corpus.id, pending);
    const notes: SourceNote[] = []; const refs: string[] = [];
    for (let i = 0; i < candidates.length; i++) {
      if (notes.length && bytes([...notes, candidates[i]]) > 105000) break;
      notes.push(candidates[i]!); refs.push(pending[i]!);
    }
    if (notes.length < 2 && pending.length > 1) throw new Error("STUDIO-SOURCE-NOTE-SIZE: опорні нотатки завеликі для зведення.");
    if (!notes.length) throw new Error("STUDIO-SOURCE-STATE");
    return { scope, reducing, sources: notes.map(note => note.source), fromPart: Math.min(...notes.map(note => note.fromPart)), toPart: Math.max(...notes.map(note => note.toPart)), count: refs.length, verifiedQuotes: notes.flatMap(note => note.quotes ?? []) };
  }
  const index = scope === "book" ? corpus.analyzed : project.lessonSources!.partIndexes[project.lessonSources!.cursor]!;
  return { scope, reducing, sources: await readStudioSourcePart(familyId, corpus, index), fromPart: index, toPart: index, count: 1 };
}
export async function applyStudioSourceTask(familyId: string, project: StudioProject, task: StudioSourceTask, raw: unknown): Promise<Partial<StudioProject>> {
  const result = studioSourceNoteSchema.parse(raw), corpus = project.sourceCorpus!;
  for (const quote of result.quotes) if (!(task.reducing ? task.verifiedQuotes?.some(verified => verified.sourceId === quote.sourceId && verified.text === quote.text) : task.sources.some(source => source.id === quote.sourceId && source.kind !== "summary" && source.text.includes(quote.text)))) throw new Error("STUDIO-SOURCE-QUOTE: цитата не збігається з наданим текстом.");
  const scopeId = task.scope === "book" ? "book" : `lesson-${project.cursor + 1}`;
  const note: SourceNote = { quotes: result.quotes, fromPart: task.fromPart, toPart: task.toPart, source: { id: `${scopeId}-parts-${task.fromPart + 1}-${task.toPart + 1}`, title: result.title, page: null, kind: "summary", audience: "learner", text: `Опорний конспект ШІ, не оригінал книги. Технічні частини: ${task.fromPart + 1}–${task.toPart + 1}.\n${result.summary}\nТеми:\n${result.topics.join("\n")}\nМежі й нерозпізнане:\n${result.limitations.join("\n")}\nПеревірені дослівні уривки:\n${result.quotes.map(quote => `[${quote.sourceId}]\n${quote.text}`).join("\n\n")}` } };
  if (task.reducing && bytes(note.source) >= bytes(task.sources)) throw new Error("STUDIO-SOURCE-NO-PROGRESS: зведення не зменшило обсяг матеріалу; зайві платні повтори зупинено.");
  const ref = await writeStudioSourceNote(familyId, corpus.id, note);
  const book = task.scope === "book";
  const work = book ? { ...corpus } : { ...project.lessonSources! };
  let completed: boolean;
  if (task.reducing) {
    work.reduceCursor += task.count; work.reduced = [...work.reduced, ref]; completed = work.reduceCursor >= work.catalog.length;
    if (completed) { work.catalog = work.reduced; work.reduceCursor = 0; work.reduced = []; }
  } else {
    work.notes = [...work.notes, ref];
    if (book) (work as typeof corpus).analyzed++;
    else (work as StudioLessonSources).cursor++;
    completed = book ? (work as typeof corpus).analyzed === corpus.partCount : (work as StudioLessonSources).cursor === project.lessonSources!.partIndexes.length;
    if (completed) work.catalog = work.notes;
  }
  let phase = project.phase; let cacheWarning = false;
  if (completed) {
    const notes = await readStudioSourceNotes(familyId, corpus.id, work.catalog);
    if (bytes(notes.map(note => note.source)) > CATALOG_BYTES) phase = book ? "outline" : "lesson_outline";
    else if (book) {
      try { await saveStudioSourceCatalog(familyId, work as typeof corpus); } catch { cacheWarning = true; }
      phase = project.sourceSelection && !project.sourceSelection.assessed ? "assess" : "plan";
    }
    else {
      (work as StudioLessonSources).context = { noteRefs: work.catalog, ids: notes.map(note => note.source.id) };
      phase = project.lessonSources!.targetPhase;
    }
  }
  return book ? { sourceCorpus: work as typeof corpus, phase, ...(cacheWarning ? { sourceNotes: [...project.sourceNotes, "Огляд джерела збережено в поточному проєкті. Спільний кеш зараз недоступний; повторний платний аналіз тут не запускається."] } : {}) } : { lessonSources: work as StudioLessonSources, phase };
}
/** Plan references identify semantic source groups, never a hard page quota. */
export async function prepareStudioLessonSources(familyId: string, project: StudioProject): Promise<Partial<StudioProject>> {
  const corpus = project.sourceCorpus!;
  const notes = await readStudioSourceNotes(familyId, corpus.id, corpus.catalog);
  const ids = new Set(project.plan?.lessons[project.cursor]?.sourceIds ?? []);
  const selected = ids.size ? notes.filter(note => ids.has(note.source.id)) : notes;
  if (!selected.length) throw new Error("STUDIO-SOURCE-PLAN");
  const parts = new Set<number>(); for (const note of selected) for (let i = note.fromPart; i <= note.toPart; i++) parts.add(i);
  const partIndexes = [...parts].sort((a, b) => a - b);
  if (!["author", "design", "review", "repair"].includes(project.phase)) throw new Error("STUDIO-SOURCE-STATE");
  const work: StudioLessonSources = { lessonIndex: project.cursor, targetPhase: project.phase as StudioLessonSources["targetPhase"], partIndexes, cursor: 0, notes: [], catalog: [], reduceCursor: 0, reduced: [] };
  if (partIndexes.length <= 2) {
    const sources = (await Promise.all(partIndexes.map(index => readStudioSourcePart(familyId, corpus, index)))).flat();
    if (bytes(sources) <= RAW_BYTES) { work.context = { rawParts: partIndexes, ids: sources.map(source => source.id) }; return { lessonSources: work }; }
  }
  return { lessonSources: work, phase: "lesson_sources" };
}
export async function studioLessonModelSources(familyId: string, project: StudioProject) {
  if (!project.sourceCorpus) return project.sources;
  const context = project.units[project.cursor]?.sourceContext ?? project.lessonSources?.context;
  if (!context) throw new Error("STUDIO-SOURCE-STATE");
  return context.rawParts ? (await Promise.all(context.rawParts.map(index => readStudioSourcePart(familyId, project.sourceCorpus!, index)))).flat() : (await readStudioSourceNotes(familyId, project.sourceCorpus.id, context.noteRefs ?? [])).map(note => note.source);
}
