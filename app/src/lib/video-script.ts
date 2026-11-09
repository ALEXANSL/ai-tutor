import { z } from "zod";

export const NO_VISUAL_TEXT = "NO TEXT IN THE VISUAL: no letters, words, numbers, labels, captions, subtitles, signs, logos, watermarks, pseudo-writing or random glyphs. Do not render written text even when the scene mentions a book, map or classroom. Use purely visual imagery.";
export const videoScenesSchema = z.object({
  scenes: z.array(z.object({
    title: z.string().trim().min(1).max(180),
    narration: z.string().trim().min(1).max(1800),
    visualPrompt: z.string().trim().min(1).max(1800),
    sourceBlockIds: z.array(z.string().min(1).max(20)).min(1).max(12),
  })).min(2).max(24),
});
export type VideoScenes = z.infer<typeof videoScenesSchema>;
export const videoDraftSchema = videoScenesSchema.extend({
  version: z.literal(1),
  title: z.string().max(500),
  sourceHash: z.string().length(64),
  createdAt: z.string(),
  provider: z.literal("openai"),
  model: z.string(),
  minutes: z.number().int().min(2).max(12),
  notes: z.string().max(1200).optional(),
});
export type VideoDraft = z.infer<typeof videoDraftSchema>;
export type VideoExport = "brief" | "narration" | "visuals";
export function visualInstructions(prompt: string): string {
  return `${prompt}\n${NO_VISUAL_TEXT}`;
}
export function estimatedVideoSeconds(draft: VideoScenes): number {
  return draft.scenes.reduce((sum, scene) => sum + Math.ceil(scene.narration.split(/\s+/u).length / 125 * 60) + 2, 0);
}
export function exportVideoScript(draft: VideoDraft, mode: VideoExport): string {
  if (mode === "narration") return draft.scenes.map(scene => scene.narration).join("\n\n");
  const scenes = draft.scenes.map((scene, index) => [
    `СЦЕНА ${index + 1}: ${scene.title}`,
    ...(mode === "brief" ? ["ТЕКСТ ОЗВУЧЕННЯ — читати дослівно:", scene.narration] : []),
    "ВІЗУАЛІЗАЦІЯ — інструкція, не озвучувати:", visualInstructions(scene.visualPrompt),
  ].join("\n")).join("\n\n");
  return [
    `ВІДЕОУРОК: ${draft.title}`,
    "Українська озвучка. Збережи порядок сцен і точний текст диктора. Не додавай фактів, реплік, вступів, висновків або нових тем. Не імпровізуй.",
    "Озвучуй лише поля «ТЕКСТ ОЗВУЧЕННЯ». Заголовки сцен і технічні інструкції не читати. Підбери професійний український голос у Pictory.",
    "Вимкни автоматичні субтитри, текстові накладки та титри. Жодного тексту у згенерованих візуалізаціях.",
    NO_VISUAL_TEXT, scenes,
  ].join("\n\n");
}
