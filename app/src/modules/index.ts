import { registerCoreNavigation } from "@/core/registries/core-navigation";
import { registerSchoolModule } from "./school";

/**
 * Composition root: the app (not the core) wires core defaults and learning
 * modules into the registries. Idempotent.
 */
export function registerAll(): void {
  registerCoreNavigation();
  registerSchoolModule();
}
