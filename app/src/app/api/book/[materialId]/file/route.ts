import { NextResponse, type NextRequest } from "next/server";
import { requireChild } from "@/server/auth/guards";
import { getBookMaterialMeta } from "@/server/books/reader";
import { DriveError, downloadFile, isValidDriveId } from "@/server/drive/google";
import { getDriveToken } from "@/server/drive/service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const dynamic = "force-dynamic";

/**
 * PDF reader (Alex, 2026-10-02): proxies the family's own PDF from Google
 * Drive so the browser never sees the Drive OAuth/service-account token —
 * the same reasoning as every other server-side Drive read in this app
 * (ADR-024). The whole file is downloaded once per request and returned in
 * one response (`downloadFile` already bounds it to `MAX_FILE_BYTES`,
 * 150 MB, streaming the *download* with a running byte counter — see
 * `drive/google.ts` — rather than trusting a possibly-missing
 * `Content-Length`). This is a deliberate, pragmatic choice for today's
 * scope: real schoolbook PDFs are a few MB, so buffering one in a single
 * serverless function invocation is fine; a true byte-range/streaming proxy
 * (so pdf.js could fetch only the pages it needs) is NOT implemented today
 * — see the written report for what a larger book would need.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ materialId: string }> }) {
  const { materialId } = await params;
  if (!UUID.test(materialId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const { ctx } = await requireChild();

  const meta = await getBookMaterialMeta(ctx.familyId, materialId);
  if (!meta || meta.format !== "pdf") return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!isValidDriveId(meta.driveFileId)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    const getToken = await getDriveToken();
    const bytes = await downloadFile(meta.driveFileId, await getToken());
    return new NextResponse(Buffer.from(bytes), {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-length": String(bytes.byteLength),
        // Private, short-lived cache only — this is the family's own book, never shared/CDN-cached.
        "cache-control": "private, max-age=300",
        "content-disposition": `inline; filename="${encodeURIComponent(meta.name || "book.pdf")}"`,
      },
    });
  } catch (e) {
    if (e instanceof DriveError) {
      const status = e.code === "not_found" ? 404 : e.code === "too_large" ? 413 : e.code === "forbidden" ? 502 : 500;
      return NextResponse.json({ error: e.code }, { status });
    }
    console.error(`book file proxy failed: ${(e as Error).name}: ${(e as Error).message}`);
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}
