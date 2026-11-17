import { NextResponse, type NextRequest } from "next/server";
import { requireParentAccess } from "@/server/auth/guards";
import { readUploadChunk, relaySourceUpload, UploadRelayError } from "@/server/drive/upload-relay";
export const dynamic = "force-dynamic";
export const maxDuration = 90;
async function relay(request: NextRequest, write: boolean) {
  const { familyId } = await requireParentAccess();
  try {
    const result = await relaySourceUpload(familyId, request.nextUrl.searchParams.get("uploadId") ?? "", write ? { bytes: await readUploadChunk(request), range: request.headers.get("content-range") ?? "" } : undefined);
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) { return NextResponse.json({ error: error instanceof UploadRelayError ? error.code : "failed" }, { status: error instanceof UploadRelayError ? error.status : 503 }); }
}
export async function GET(request: NextRequest) { return relay(request, false); }
export async function PUT(request: NextRequest) { return relay(request, true); }
