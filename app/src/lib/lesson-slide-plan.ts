import { z } from "zod";

const mark = z.object({
  shape: z.enum(["ellipse", "rect", "triangle", "line"]),
  x: z.number(), y: z.number(), width: z.number(), height: z.number(),
  color: z.enum(["ink", "teal", "gold", "clay", "pale"]),
});
export const slidePlanSchema = z.object({ slides: z.array(z.object({
  heading: z.string(), takeaway: z.string(), caption: z.string(), photoQuery: z.string(),
  drawing: z.array(mark), narration: z.string(),
})) });
export type LessonSlidePlan = z.infer<typeof slidePlanSchema>;
