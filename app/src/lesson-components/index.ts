/**
 * Side-effect import point (ADR-020 §2): importing this module registers
 * every built-in lesson component. Called once from `modules/index.ts`.
 */
import "./drag_sort";

export { getLessonComponent, listLessonComponents, allowedForSubject } from "./registry";
export type { LessonComponentDefinition, LessonComponentVerdict } from "./registry";
