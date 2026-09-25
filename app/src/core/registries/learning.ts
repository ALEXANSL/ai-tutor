import { createRegistry } from "./registry";

/**
 * Learning registries (ADR-017 "3 registries in code"): session modes, step
 * types and source types. The school module registers the MVP entries; new
 * modules add their own without changing the core.
 */
export interface SessionModeDefinition {
  key: string;
  module: string;
  titleUk: string;
}

export interface StepTypeDefinition {
  key: string;
  module: string;
  /** The answer is given by an interactive component and graded deterministically (ADR-020). */
  interactive: boolean;
}

export interface SourceTypeDefinition {
  key: string;
  module: string;
  titleUk: string;
  /** Name of the StructureStrategy used by the ingest pipeline (S1). */
  structureStrategy: "textbook" | "literary_work" | "fragments";
}

export const sessionModes = createRegistry<SessionModeDefinition>("sessionModes");
export const stepTypes = createRegistry<StepTypeDefinition>("stepTypes");
export const sourceTypes = createRegistry<SourceTypeDefinition>("sourceTypes");
