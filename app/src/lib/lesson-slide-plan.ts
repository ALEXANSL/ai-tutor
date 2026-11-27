import { z } from "zod";

/** Legacy (before ADR-050): abstract shapes drawn when no photo was found. Kept
 * only so plans saved by older decks still parse; nothing draws them anymore. */
const mark = z.object({
  shape: z.enum(["ellipse", "rect", "triangle", "line"]),
  x: z.number(), y: z.number(), width: z.number(), height: z.number(),
  color: z.enum(["ink", "teal", "gold", "clay", "pale"]),
});
const outlineSlide = z.object({
  heading: z.string(), takeaway: z.string(), caption: z.string(), photoQuery: z.string(),
  /** English scene description for the image model; empty when a picture would mislead (exact maths, formulas). */
  imagePrompt: z.string(),
  narration: z.string(),
});
export const outlineSchema = z.object({ slides: z.array(outlineSlide) });
/** Writes image prompts for plans saved before ADR-050 (they have no imagePrompt). */
export const imagePromptsSchema = z.object({ prompts: z.array(z.string()) });
/** ADR-050: the picture actually placed on the slide, stored privately in `course_assets`. */
export const slideVisualSchema = z.object({
  kind: z.enum(["ai", "photo", "none"]),
  path: z.string().optional(),
  credit: z.string().optional(),
  sourceUrl: z.string().optional(),
});
export type SlideVisual = z.infer<typeof slideVisualSchema>;
export const slidePlanSchema = z.object({ slides: z.array(outlineSlide.extend({
  imagePrompt: z.string().optional(),
  drawing: z.array(mark).optional(),
  visual: slideVisualSchema.optional(),
})) });
export type LessonSlidePlan = z.infer<typeof slidePlanSchema>;
export type LessonSlide = LessonSlidePlan["slides"][number];
