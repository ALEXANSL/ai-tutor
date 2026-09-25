import { sessionModes, sourceTypes, stepTypes } from "@/core/registries/learning";

/**
 * "School curriculum" learning module — the only module in the MVP (ADR-017).
 * Its MVP features are simply the first records in the core registries.
 * Evaluators, strategies and handlers are attached in the slices that
 * implement them (S1 ingest, S3 lessons, S26 interactive components).
 */
export const SCHOOL_MODULE = "school";

export function registerSchoolModule(): void {
  if (sessionModes.has("lesson")) return;
  sessionModes.register({ key: "lesson", module: SCHOOL_MODULE, titleUk: "Урок" });

  for (const key of ["slide", "choice", "open", "voice_dialog", "match", "mini_game", "photo"]) {
    stepTypes.register({ key, module: SCHOOL_MODULE, interactive: false });
  }
  stepTypes.register({ key: "interactive", module: SCHOOL_MODULE, interactive: true });

  // Source types (US-2.6 KP-1, D-41): any book, not only textbooks.
  const types = [
    { key: "textbook", titleUk: "Підручник", structureStrategy: "textbook", autoDetect: true, icon: "📘" },
    { key: "literary_work", titleUk: "Художній твір", structureStrategy: "chapters", autoDetect: true, icon: "📙" },
    { key: "popular_science", titleUk: "Науково-популярна", structureStrategy: "contents", autoDetect: true, icon: "🔭" },
    { key: "reference", titleUk: "Довідник", structureStrategy: "contents", autoDetect: true, icon: "📗" },
    { key: "other", titleUk: "Інше", structureStrategy: "contents", autoDetect: true, icon: "📄" },
    { key: "test_fragment", titleUk: "Тестовий фрагмент", structureStrategy: "contents", autoDetect: false, icon: "🧪" },
  ] as const;
  for (const t of types) sourceTypes.register({ ...t, module: SCHOOL_MODULE });
}
