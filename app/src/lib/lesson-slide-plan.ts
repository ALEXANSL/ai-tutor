import { z } from "zod";

const mark = z.object({
  shape: z.enum(["ellipse", "rect", "triangle", "line"]),
  x: z.number(), y: z.number(), width: z.number(), height: z.number(),
  color: z.enum(["ink", "teal", "gold", "clay", "pale"]),
});
const outlineSlide = z.object({
  heading: z.string(), takeaway: z.string(), caption: z.string(), photoQuery: z.string(),
  narration: z.string(),
});
export const outlineSchema = z.object({ slides: z.array(outlineSlide) });
export const artworkSchema = z.object({ drawings: z.array(z.object({ drawing: z.array(mark) })) });
export const slidePlanSchema = z.object({ slides: z.array(outlineSlide.extend({ drawing: z.array(mark) })) });
export type LessonSlidePlan = z.infer<typeof slidePlanSchema>;
