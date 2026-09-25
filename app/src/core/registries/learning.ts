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

/**
 * Structure strategies of the universal ingest pipeline (docs/02 9.1):
 *  - `textbook`: sections -> topics -> pages (+ topic dependencies);
 *  - `chapters`: chapters only, no topic graph (literary works);
 *  - `contents`: table of contents + fragments for search and quotes.
 */
export type StructureStrategyKey = "textbook" | "chapters" | "contents";

export interface SourceTypeDefinition {
  key: string;
  module: string;
  titleUk: string;
  /** StructureStrategy used by the ingest pipeline (S1). */
  structureStrategy: StructureStrategyKey;
  /** Offered to the model for automatic type detection (US-2.6 KP-1). */
  autoDetect: boolean;
  /** Icon in "Мої книги". */
  icon: string;
}

export const sessionModes = createRegistry<SessionModeDefinition>("sessionModes");
export const stepTypes = createRegistry<StepTypeDefinition>("stepTypes");
export const sourceTypes = createRegistry<SourceTypeDefinition>("sourceTypes");
