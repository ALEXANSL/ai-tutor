import "server-only";
import { studioNarrationText } from "@/lib/studio-narration";
import { z } from "zod";
import { STUDIO_MAX_BLOCKS, STUDIO_MAX_QUIZZES, studioLessonSchema, studioAuthorSchema, studioDesignSchema, type StudioUnit } from "@/lib/studio";
const nullableText = (max: number) => z.string().trim().min(1).max(max).nullable();
export const studioRepairSchema = z.object({
  diagnosis: z.string().trim().min(20).max(2000), reviewAdvice: z.string().max(2000),
  blocks: z.array(z.object({ blockIndex: z.number().int().min(0).max(STUDIO_MAX_BLOCKS - 1), replacement: studioAuthorSchema.shape.blocks.element }).strict()).max(STUDIO_MAX_BLOCKS),
  questions: z.array(z.object({ questionIndex: z.number().int().min(0).max(STUDIO_MAX_QUIZZES - 1), replacement: studioLessonSchema.shape.questions.element }).strict()).max(STUDIO_MAX_QUIZZES),
  visuals: studioDesignSchema.shape.visuals.nullable(), title: nullableText(200), objectives: studioLessonSchema.shape.objectives.nullable(),
  sourceIds: studioLessonSchema.shape.sourceIds.nullable(), enrichmentNote: nullableText(1000), adultAssistance: z.string().max(1500).nullable(),
}).strict();
/** Apply only explicit, validated element replacements; omitted lesson content cannot be erased. */
export function applyStudioRepair(unit: StudioUnit, raw: unknown): { unit: StudioUnit; diagnosis: string; reviewAdvice: string } {
  const fix = studioRepairSchema.parse(raw);
  if (new Set(fix.blocks.map(block => block.blockIndex)).size !== fix.blocks.length || new Set(fix.questions.map(question => question.questionIndex)).size !== fix.questions.length) throw new Error("STUDIO-REPAIR-DUPLICATE");
  const content = { ...unit.content, blocks: [...unit.content.blocks], questions: [...unit.content.questions] };
  for (const patch of fix.blocks.sort((a, b) => a.blockIndex - b.blockIndex)) {
    if (patch.blockIndex > content.blocks.length) throw new Error("STUDIO-REPAIR-REF");
    content.blocks[patch.blockIndex] = { ...patch.replacement, narration: studioNarrationText(patch.replacement) };
  }
  for (const patch of fix.questions.sort((a, b) => a.questionIndex - b.questionIndex)) {
    if (patch.questionIndex > content.questions.length) throw new Error("STUDIO-REPAIR-REF");
    content.questions[patch.questionIndex] = patch.replacement;
  }
  if (fix.title !== null) content.title = fix.title;
  if (fix.objectives !== null) content.objectives = fix.objectives;
  if (fix.sourceIds !== null) content.sourceIds = fix.sourceIds;
  if (fix.enrichmentNote !== null) content.enrichmentNote = fix.enrichmentNote;
  if (fix.adultAssistance !== null) content.adultAssistance = fix.adultAssistance;
  const visuals = fix.visuals === null ? unit.visuals : fix.visuals;
  if (visuals.some(visual => visual.blockIndex >= content.blocks.length || (visual.kind === "dimensions" && (!visual.width || !visual.height || !visual.unit)))) throw new Error("STUDIO-REPAIR-VISUAL");
  return { unit: { ...unit, content, visuals, review: null }, diagnosis: fix.diagnosis, reviewAdvice: fix.reviewAdvice };
}

/** Take only complete JSON values from an interrupted patch. Never finish a string or invent a missing item. */
export function recoverRepairForExport(unit: StudioUnit, raw: unknown): StudioUnit | null {
  if (typeof raw !== "string" || raw.length > 500000) return null;
  try { return applyStudioRepair(unit, JSON.parse(raw)).unit; } catch { /* inspect the complete prefix */ }
  const stack: string[] = [];
  let quoted = false, escaped = false, rootStart = -1, array = "", itemStart = -1;
  const blocks: unknown[] = [], questions: unknown[] = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === "{" || c === "[") {
      if (!stack.length) {
        if (c !== "{" || raw.slice(0,i).trim()) return null;
        rootStart = i + 1;
      } else if (stack.length === 1 && c === "[") {
        const key = raw.slice(rootStart,i).trim();
        array = /^"blocks"\s*:$/.test(key) ? "blocks" : /^"questions"\s*:$/.test(key) ? "questions" : "";
      } else if (stack.length === 2 && array && c === "{") itemStart = i;
      stack.push(c);
    } else if (c === "}" || c === "]") {
      if (stack.pop() !== (c === "}" ? "{" : "[")) return null;
      if (stack.length === 2 && array && itemStart >= 0 && c === "}") {
        try { (array === "blocks" ? blocks : questions).push(JSON.parse(raw.slice(itemStart,i+1))); }
        catch { return null; }
        itemStart = -1;
      }
      if (stack.length === 1) array = "";
      if (!stack.length) break;
    } else if (stack.length === 1 && c === ",") rootStart = i + 1;
  }
  if (!blocks.length && !questions.length) return null;
  try {
    return applyStudioRepair(unit,{diagnosis:"Відновлено завершені елементи відповіді.",reviewAdvice:"",blocks,questions,visuals:null,title:null,objectives:null,sourceIds:null,enrichmentNote:null,adultAssistance:null}).unit;
  } catch { return null; }
}
