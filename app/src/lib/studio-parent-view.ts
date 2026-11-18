import type { StudioProject } from "./studio";
/** A long course response carries summaries and one complete lesson, never the entire course body. */
export function studioParentView(project: StudioProject, requestedIndex?: number): StudioProject {
  const result = { ...project, units: project.units.map(unit => { const copy = { ...unit }; delete copy.sourceContext; return copy; }) }; delete result.unitRefs;
  delete result.sourceCorpus; delete result.lessonSources; delete result.sourceSelection;
  result.canRestart = ["failed", "paused"].includes(project.state) && !!project.pendingModelCall && !project.pendingModelCall.billed && !project.pendingModelCall.background;
  result.savedModelResult = !!project.pendingModelCall?.billed;
  result.canRegenerate = project.state === "failed" && !!project.pendingModelCall?.billed && project.failureDiagnostic?.category === "content";
  delete result.unavailableSpecialists; delete result.lastTransportRetryHash; delete result.lastRateLimitRetryHash; delete result.pendingModelCall; delete result.unresolvedModelCalls; delete result.regeneration;
  if (project.sourceCorpus) result.sourceProgress = { partCount: project.sourceCorpus.partCount, analyzed: project.sourceCorpus.analyzed, characters: project.sourceCorpus.characterCount, stage: project.phase, lessonParts: project.lessonSources?.partIndexes.length ?? 0, lessonPrepared: project.lessonSources?.cursor ?? 0 };
  if (project.request.lessonCount <= 6 && !project.unitRefs) return result;
  const index = Math.min(Math.max(0, requestedIndex ?? project.cursor), Math.max(0, project.units.length - 1));
  return { ...result, previewIndex: index, units: result.units.map((unit, i) => i === index ? unit : ({ content: { title: unit.content.title, objectives: [], blocks: [], questions: [], sourceIds: [], enrichmentNote: "", adultAssistance: "" }, visuals: [], reviewRound: unit.reviewRound, review: unit.review ? { verdict: unit.review.verdict, summary: unit.review.summary.slice(0, 300), issues: [], corrections: [] } : null })) };
}
