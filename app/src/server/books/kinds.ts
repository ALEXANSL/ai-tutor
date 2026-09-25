import "server-only";
import { sourceTypes } from "@/core/registries/learning";
import { registerAll } from "@/modules";

/** Source types offered in the cabinet (registry, ADR-017). */
export function kindOptions(): { key: string; title: string; icon: string }[] {
  registerAll();
  return sourceTypes
    .list()
    .filter((k) => k.autoDetect)
    .map((k) => ({ key: k.key, title: k.titleUk, icon: k.icon }));
}
