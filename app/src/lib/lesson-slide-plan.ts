import { z } from "zod";

/** Legacy (before ADR-050): abstract shapes drawn when no photo was found. Kept
 * only so plans saved by older decks still parse; nothing draws them anymore. */
const mark = z.object({
  shape: z.enum(["ellipse", "rect", "triangle", "line"]),
  x: z.number(), y: z.number(), width: z.number(), height: z.number(),
  color: z.enum(["ink", "teal", "gold", "clay", "pale"]),
});
/** ADR-051: what kind of picture explains this slide. */
export const slideVisualTypeSchema = z.enum(["map", "photo", "illustration", "none"]);
const place = z.object({ name: z.string(), lat: z.number(), lon: z.number() });
const outlineSlide = z.object({
  heading: z.string(), takeaway: z.string(), caption: z.string(),
  /** map: places named on the slide; photo: a real object (monument, artefact, portrait, mineral); illustration: a scene; none: no picture. */
  visualType: slideVisualTypeSchema,
  /** Ukrainian place names with coordinates, for visualType "map"; empty otherwise. */
  places: z.array(place),
  photoQuery: z.string(),
  /** English scene description for the image model; empty when a picture would mislead (exact maths, formulas). */
  imagePrompt: z.string(),
  narration: z.string(),
});
export const outlineSchema = z.object({ slides: z.array(outlineSlide) });
/** Chooses the visuals for plans saved before ADR-051 (they have no visualType). */
export const slideVisualsSchema = z.object({ visuals: z.array(outlineSlide.pick({ visualType: true, places: true, photoQuery: true, imagePrompt: true, caption: true })) });
/** ADR-050: the picture actually placed on the slide, stored privately in `course_assets`. */
export const slideVisualSchema = z.object({
  kind: z.enum(["ai", "photo", "map", "none"]),
  path: z.string().optional(),
  /** kind "map": Ukrainian names placed by the slide layout, at 0–1 of the picture. */
  labels: z.array(z.object({ name: z.string(), x: z.number(), y: z.number() })).optional(),
  credit: z.string().optional(),
  sourceUrl: z.string().optional(),
});
export type SlideVisual = z.infer<typeof slideVisualSchema>;
export const slidePlanSchema = z.object({ slides: z.array(outlineSlide.extend({
  visualType: slideVisualTypeSchema.optional(),
  places: z.array(place).optional(),
  imagePrompt: z.string().optional(),
  drawing: z.array(mark).optional(),
  visual: slideVisualSchema.optional(),
})) });
export type LessonSlidePlan = z.infer<typeof slidePlanSchema>;
export type LessonSlide = LessonSlidePlan["slides"][number];
