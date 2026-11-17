import "server-only";
import { z } from "zod";
import { studioLessonSchema, studioDesignSchema, type StudioUnit } from "@/lib/studio";
const nullableText = (max: number) => z.string().trim().min(1).max(max).nullable();
export const studioRepairSchema = z.object({
  diagnosis: z.string().trim().min(20).max(2000), reviewAdvice: z.string().max(2000),
  blocks: z.array(z.object({ blockIndex: z.number().int().min(0).max(7), replacement: studioLessonSchema.shape.blocks.element }).strict()).max(8),
  questions: z.array(z.object({ questionIndex: z.number().int().min(0).max(2), replacement: studioLessonSchema.shape.questions.element }).strict()).max(3),
  visuals: studioDesignSchema.shape.visuals.nullable(), title: nullableText(200), objectives: studioLessonSchema.shape.objectives.nullable(),
  sourceIds: studioLessonSchema.shape.sourceIds.nullable(), enrichmentNote: nullableText(1000), adultAssistance: z.string().max(1500).nullable(),
}).strict();
/** Apply only explicit, validated element replacements; omitted lesson content cannot be erased. */
export function applyStudioRepair(unit: StudioUnit, raw: unknown): { unit: StudioUnit; diagnosis: string; reviewAdvice: string } {
  const fix = studioRepairSchema.parse(raw);
  if (new Set(fix.blocks.map(block => block.blockIndex)).size !== fix.blocks.length || new Set(fix.questions.map(question => question.questionIndex)).size !== fix.questions.length) throw new Error("STUDIO-REPAIR-DUPLICATE");
  if (fix.blocks.some(block => !unit.content.blocks[block.blockIndex]) || fix.questions.some(question => !unit.content.questions[question.questionIndex])) throw new Error("STUDIO-REPAIR-REF");
  const content = { ...unit.content, blocks: [...unit.content.blocks], questions: [...unit.content.questions] };
  for (const patch of fix.blocks) content.blocks[patch.blockIndex] = patch.replacement;
  for (const patch of fix.questions) content.questions[patch.questionIndex] = patch.replacement;
  if (fix.title !== null) content.title = fix.title;
  if (fix.objectives !== null) content.objectives = fix.objectives;
  if (fix.sourceIds !== null) content.sourceIds = fix.sourceIds;
  if (fix.enrichmentNote !== null) content.enrichmentNote = fix.enrichmentNote;
  if (fix.adultAssistance !== null) content.adultAssistance = fix.adultAssistance;
  const visuals = fix.visuals === null ? unit.visuals : fix.visuals;
  if (visuals.some(visual => visual.blockIndex >= content.blocks.length || (visual.kind === "dimensions" && (!visual.width || !visual.height || !visual.unit)))) throw new Error("STUDIO-REPAIR-VISUAL");
  return { unit: { ...unit, content, visuals, review: null }, diagnosis: fix.diagnosis, reviewAdvice: fix.reviewAdvice };
}
