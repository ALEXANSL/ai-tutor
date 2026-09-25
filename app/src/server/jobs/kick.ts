import "server-only";
import { after } from "next/server";
import { registerAll } from "@/modules";
import { registerIngestJobs } from "../ingest/pipeline";
import { runJobs } from "./runner";

/** Composition root for background work: registries + job handlers. */
export function ensureJobHandlers(): void {
  registerAll();
  registerIngestJobs();
}

/**
 * Runs pending jobs after the response is sent (Next.js `after`, within the
 * function's max duration). Safe to call often: jobs are claimed with SKIP LOCKED.
 */
export function kickJobs(budgetMs = 240_000): void {
  ensureJobHandlers();
  after(async () => {
    try {
      await runJobs({ budgetMs });
    } catch (e) {
      console.error(`background jobs failed: ${(e as Error).message}`);
    }
  });
}
