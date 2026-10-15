import { NextResponse } from "next/server";
import { requireChild } from "@/server/auth/guards";
import { forFamily } from "@/server/db/family-scope";
import { createServiceClient } from "@/server/supabase/clients";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIT_V3_ASSETS_BUCKET = "course_assets"; // same shared bucket literatureV3Persist.ts uploads lesson_pdf assets to, under `lit-v3/{packageId}/{assetKey}`.

/**
 * S45 (US-31.3, ADR-044 §4) — streams one `literature_v3_assets`
 * (`kind='lesson_pdf'`) file straight from our own Supabase Storage, the
 * same authorization shape as `/api/book/[materialId]/file` (ADR-024's
 * reasoning for not trusting the browser with a storage token applies here
 * too) but WITHOUT that route's Drive/Range complexity — this is already a
 * small (~800 KB), locally-stored file, so a plain full-body response is
 * enough; `VirtualBookReader`/`pdfEngine.ts`'s pdf.js loader still works
 * fine without Range support (it falls back to a full download on its own
 * when a server doesn't advertise `Accept-Ranges`).
 */
export async function GET(_request: Request, { params }: { params: Promise<{ assetId: string }> }) {
  const { assetId } = await params;
  if (!UUID.test(assetId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const { ctx } = await requireChild();

  // Authenticated (RLS-enforced) lookup: confirms this family can see this
  // asset through an active lesson (`literature_v3_assets_select_child`
  // policy) before we ever touch Storage with the service client.
  const scope = forFamily(ctx.familyId);
  const { data: asset } = await scope
    .select("literature_v3_assets", "storage_path, mime_type, kind")
    .eq("id", assetId)
    .maybeSingle<{ storage_path: string | null; mime_type: string; kind: string }>();
  if (!asset || asset.kind !== "lesson_pdf" || !asset.storage_path) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const service = createServiceClient();
  const { data: blob, error } = await service.storage.from(LIT_V3_ASSETS_BUCKET).download(asset.storage_path);
  if (error || !blob) {
    console.error(`lesson-pdf file proxy failed: ${error?.message}`);
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());
  return new NextResponse(Buffer.from(bytes), {
    status: 200,
    headers: {
      "content-type": asset.mime_type || "application/pdf",
      "content-length": String(bytes.byteLength),
      // Private, short-lived cache only — this is the family's own content, never shared/CDN-cached.
      "cache-control": "private, max-age=300",
    },
  });
}
