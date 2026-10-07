import { NextResponse, type NextRequest } from "next/server";
import { requireChild } from "@/server/auth/guards";
import { getBookMaterialMeta } from "@/server/books/reader";
import { DriveError, downloadFile, isValidDriveId } from "@/server/drive/google";
import { getDriveToken } from "@/server/drive/service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const dynamic = "force-dynamic";
// PO complaint 2026-10-07 ("підручник дуже довго грузиться" / "Не вдалося
// завантажити книгу"): a real schoolbook PDF (200+ pages, illustrations)
// downloaded from Drive routinely took longer than this platform's default
// Server Function timeout, which silently killed the request mid-download
// — same class of bug as `subject/[id]/page.tsx`'s own `maxDuration`
// comment, fixed the same way, with the same 300s budget `downloadFile`'s
// own 120s Drive-request timeout already assumes it has room inside.
export const maxDuration = 300;

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
 *
 * PO follow-up (2026-10-07): re-downloading the whole file from Drive on
 * EVERY open (even the same book, minutes apart) was the other half of
 * "довго грузиться" — a small process-local cache (one serverless instance
 * can stay warm across several requests in a row, the common case here:
 * the same child reopening the same book repeatedly in one lesson) turns
 * every open after the first, on that instance, into an in-memory hit with
 * no Drive round-trip at all. Bounded to a handful of entries so it can
 * never hold more than a few books' worth of memory at once.
 */
const fileCache = new Map<string, { bytes: Uint8Array; cachedAt: number }>();
const FILE_CACHE_TTL_MS = 15 * 60 * 1000;
const FILE_CACHE_MAX_ENTRIES = 5;

function getCachedFile(fileId: string): Uint8Array | null {
  const entry = fileCache.get(fileId);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > FILE_CACHE_TTL_MS) {
    fileCache.delete(fileId);
    return null;
  }
  return entry.bytes;
}

function setCachedFile(fileId: string, bytes: Uint8Array) {
  if (!fileCache.has(fileId) && fileCache.size >= FILE_CACHE_MAX_ENTRIES) {
    const oldestKey = [...fileCache.entries()].sort((a, b) => a[1].cachedAt - b[1].cachedAt)[0]?.[0];
    if (oldestKey) fileCache.delete(oldestKey);
  }
  fileCache.set(fileId, { bytes, cachedAt: Date.now() });
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ materialId: string }> }) {
  const { materialId } = await params;
  if (!UUID.test(materialId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const { ctx } = await requireChild();

  const meta = await getBookMaterialMeta(ctx.familyId, materialId);
  if (!meta || meta.format !== "pdf") return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!isValidDriveId(meta.driveFileId)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    let bytes = getCachedFile(meta.driveFileId);
    if (!bytes) {
      const getToken = await getDriveToken();
      bytes = await downloadFile(meta.driveFileId, await getToken());
      setCachedFile(meta.driveFileId, bytes);
    }
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
