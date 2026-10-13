import { NextResponse, type NextRequest } from "next/server";
import { requireChild } from "@/server/auth/guards";
import { getBookMaterialMeta } from "@/server/books/reader";
import { DriveError, downloadFile, downloadFileRange, isValidDriveId } from "@/server/drive/google";
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
 * (ADR-024). A full, unranged request downloads the whole file once per
 * request/instance (`downloadFile` already bounds it to `MAX_FILE_BYTES`,
 * 150 MB, streaming the *download* with a running byte counter — see
 * `drive/google.ts` — rather than trusting a possibly-missing
 * `Content-Length`).
 *
 * PO complaint 2026-10-13 (repeat of 2026-10-07, History/Literature PDF
 * this time): the *first* open of a newly-linked book was still slow even
 * after the 2026-10-07 fixes below, because the whole load path was
 * strictly sequential — download every byte, then have pdf.js parse every
 * byte, before rendering even page 1. This route now honours HTTP `Range`
 * requests (`206 Partial Content` with `Content-Range`/`Accept-Ranges`), so
 * `BookReader`'s `pdfjsLib.getDocument({ url, rangeChunkSize })` can fetch
 * only the small xref/structure chunk plus the bytes of the page actually
 * being shown, instead of the whole book. See `downloadFileRange` in
 * `drive/google.ts` for how a range is requested from Drive itself.
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

/** Fallback chunk size for an open-ended `Range: bytes=N-` request (no end given) — matches the
 * `rangeChunkSize` `BookReader` asks pdf.js to use, so in practice this only covers other clients. */
const DEFAULT_RANGE_CHUNK = 131_072;

/** Parses a single-range `Range: bytes=start-end` (or `bytes=start-`) header. `null` if absent/unusable. */
function parseRange(header: string | null): { start: number; end: number | null } | null {
  if (!header) return null;
  const match = /^bytes=(\d+)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : null;
  if (!Number.isFinite(start) || (end !== null && (!Number.isFinite(end) || end < start))) return null;
  return { start, end };
}

function driveErrorStatus(e: DriveError): number {
  return e.code === "not_found" ? 404 : e.code === "too_large" ? 413 : e.code === "forbidden" ? 502 : 500;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ materialId: string }> }) {
  const { materialId } = await params;
  if (!UUID.test(materialId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const { ctx } = await requireChild();

  const meta = await getBookMaterialMeta(ctx.familyId, materialId);
  if (!meta || meta.format !== "pdf") return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!isValidDriveId(meta.driveFileId)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const range = parseRange(request.headers.get("range"));

  if (range) {
    const cached = getCachedFile(meta.driveFileId);
    try {
      if (cached) {
        // Already have the whole file locally (15-min cache) — slice it in memory, no Drive round-trip.
        const total = cached.byteLength;
        const end = Math.min(range.end ?? range.start + DEFAULT_RANGE_CHUNK - 1, total - 1);
        const start = Math.min(range.start, end);
        const slice = cached.subarray(start, end + 1);
        return new NextResponse(Buffer.from(slice), {
          status: 206,
          headers: {
            "content-type": "application/pdf",
            "content-length": String(slice.byteLength),
            "content-range": `bytes ${start}-${end}/${total}`,
            "accept-ranges": "bytes",
            "cache-control": "private, max-age=300",
          },
        });
      }

      // Not cached: ask Drive for exactly this range — never the whole file (that would defeat the point).
      const end = range.end ?? range.start + DEFAULT_RANGE_CHUNK - 1;
      const getToken = await getDriveToken();
      const result = await downloadFileRange(meta.driveFileId, await getToken(), { start: range.start, end });
      if (result.start === null || result.total === null) {
        // Drive ignored the Range (served 200) — fall back to a full, non-partial response so the
        // client can still render something instead of getting a mismatched 206.
        return new NextResponse(Buffer.from(result.bytes), {
          status: 200,
          headers: {
            "content-type": "application/pdf",
            "content-length": String(result.bytes.byteLength),
            "accept-ranges": "bytes",
            "cache-control": "private, max-age=300",
          },
        });
      }
      return new NextResponse(Buffer.from(result.bytes), {
        status: 206,
        headers: {
          "content-type": "application/pdf",
          "content-length": String(result.bytes.byteLength),
          "content-range": `bytes ${result.start}-${result.end}/${result.total}`,
          "accept-ranges": "bytes",
          "cache-control": "private, max-age=300",
        },
      });
    } catch (e) {
      if (e instanceof DriveError) return NextResponse.json({ error: e.code }, { status: driveErrorStatus(e) });
      console.error(`book file range proxy failed: ${(e as Error).name}: ${(e as Error).message}`);
      return NextResponse.json({ error: "failed" }, { status: 500 });
    }
  }

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
        "accept-ranges": "bytes",
        // Private, short-lived cache only — this is the family's own book, never shared/CDN-cached.
        "cache-control": "private, max-age=300",
        "content-disposition": `inline; filename="${encodeURIComponent(meta.name || "book.pdf")}"`,
      },
    });
  } catch (e) {
    if (e instanceof DriveError) return NextResponse.json({ error: e.code }, { status: driveErrorStatus(e) });
    console.error(`book file proxy failed: ${(e as Error).name}: ${(e as Error).message}`);
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}
