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

  sourceTypes.register({ key: "textbook", module: SCHOOL_MODULE, titleUk: "Підручник", structureStrategy: "textbook" });
  sourceTypes.register({ key: "literary_work", module: SCHOOL_MODULE, titleUk: "Художній твір", structureStrategy: "literary_work" });
  sourceTypes.register({ key: "test_fragment", module: SCHOOL_MODULE, titleUk: "Тестовий фрагмент", structureStrategy: "fragments" });
}
