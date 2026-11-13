import type { StudioProject } from "./studio";
/** A long course response carries summaries and one complete lesson, never the entire course body. */
export function studioParentView(project: StudioProject, requestedIndex?: number): StudioProject {
  const result = { ...project }; delete result.unitRefs;
  if (project.request.lessonCount <= 6 && !project.unitRefs) return result;
  const index = Math.min(Math.max(0, requestedIndex ?? project.cursor), Math.max(0, project.units.length - 1));
  return { ...result, previewIndex: index, units: project.units.map((unit, i) => i === index ? unit : ({ content: { title: unit.content.title, objectives: [], blocks: [], questions: [], sourceIds: [], enrichmentNote: "", adultAssistance: "" }, visuals: [], review: unit.review ? { verdict: unit.review.verdict, summary: unit.review.summary.slice(0, 300), issues: [], corrections: [] } : null })) };
}
