import { NextResponse } from "next/server";
import { getServerSecret } from "@/server/env";
import { JOB } from "@/server/ingest/pipeline";
import { isCronAuthorized } from "@/server/jobs/cron-auth";
import { ensureJobHandlers } from "@/server/jobs/kick";
import { enqueueJob, runJobs } from "@/server/jobs/runner";
import { createServiceClient } from "@/server/supabase/clients";

/**
 * Background tick (ADR-015). Called by Vercel Cron (daily "check the folder",
 * `?sync=1`) and optionally by Supabase pg_cron every minute. Protected by
 * CRON_SECRET (`Authorization: Bearer …`, sent by Vercel Cron automatically).
 */
export const maxDuration = 300;
export const dynamic = "force-dynamic";

async function tick(request: Request) {
  const secret = getServerSecret("CRON_SECRET");
  if (!secret) return NextResponse.json({ error: "not configured" }, { status: 503 });
  if (!isCronAuthorized(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  ensureJobHandlers();
  if (new URL(request.url).searchParams.get("sync") === "1") {
    const { data } = await createServiceClient().from("families").select("id").returns<{ id: string }[]>();
    for (const f of data ?? []) await enqueueJob(f.id, JOB.sync, {}, { dedupeKey: JOB.sync });
  }
  const { processed } = await runJobs({ budgetMs: 270_000 });
  return NextResponse.json({ processed });
}

export const GET = tick;
export const POST = tick;
