import { registerCoreNavigation } from "@/core/registries/core-navigation";
import "@/lesson-components"; // side effect: registers built-in interactive components (ADR-020)
import { registerSchoolModule } from "./school";

/**
 * Composition root: the app (not the core) wires core defaults and learning
 * modules into the registries. Idempotent.
 */
export function registerAll(): void {
  registerCoreNavigation();
  registerSchoolModule();
}
