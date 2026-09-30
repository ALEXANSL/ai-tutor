"use server";

import { requireParentAccess } from "@/server/auth/guards";
import { runContentQaSweep, type ContentQaSweepSummary } from "@/server/lessons/content-qa-sweep-lib";
import { createServiceClient } from "@/server/supabase/clients";
import { uk } from "@/i18n/uk";

/**
 * ADR-034 follow-up: "Перевірити бібліотеку уроків" button in
 * `/parent/settings` — reuses `runContentQaSweep` (`content-qa-sweep-lib.ts`)
 * exactly as `scripts/content-qa-sweep.ts` does, just invoked from a Next.js
 * server action instead of a standalone `tsx` CLI process (the PO does not
 * run terminal commands). No new checking/writing logic here — this file is
 * only the parent-access gate + service-role client + the same dry-run-by-
 * default safety as the CLI (`apply` defaults to `false`).
 *
 * `runContentQaSweep` can touch every `library_items` block across every
 * family in an unscoped run — same as the CLI's own default (no `--family`)
 * — because this is a whole-of-database maintenance operation, not a
 * per-family one; the parent triggering it only needs to be a parent of
 * SOME family (`requireParentAccess`), same access level as the rest of
 * `/parent/settings`.
 */
export type ContentQaSweepState = { status: "ok"; summary: ContentQaSweepSummary } | { status: "error"; message: string };

export async function runContentQaSweepAction(apply: boolean): Promise<ContentQaSweepState> {
  await requireParentAccess();
  try {
    const summary = await runContentQaSweep(createServiceClient(), { apply });
    return { status: "ok", summary };
  } catch (e) {
    console.error(`runContentQaSweepAction failed: ${(e as Error).message}`);
    return { status: "error", message: uk.common.error };
  }
}
